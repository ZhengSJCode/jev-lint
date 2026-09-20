import fs from 'node:fs'

import { extractFunctions } from './extract.js'
import type { FileSlice } from './jev.js'
import { askFile, askFunction, createClient } from './jev.js'
import { loadRules } from './rules.js'
import type { FnSlice, GuardOptions, Rule, Violation } from './types.js'

/** 低于这条线连报都不报。实测 0.7 以下几乎全是噪音 */
const DEFAULT_WARNING = 0.7
/** 达到这条线是必须改。实测 0.9 以上只有真命中 */
const DEFAULT_ERROR = 0.9
const DEFAULT_CONCURRENCY = 4
const DEFAULT_MODEL = 'jev-latest'

/** 文件级检查最多看这么多行 —— 判断「放对地方没有」不需要读完整份，长文件截断省时间 */
const MAX_FILE_LINES = 300

/** 一次检查的完整结果 */
export interface CheckReport {
  file: string
  functions: number
  violations: Violation[]
  /** 请求失败的项，形状是「对象: 原因」 */
  failures: string[]
}

export async function checkFile(filePath: string, options: GuardOptions): Promise<CheckReport> {
  const source = fs.readFileSync(filePath, 'utf8')
  return checkSource(source, filePath, options)
}

/**
 * 审查一份源码。
 *
 * 规则按 scope 分两阶段跑：
 *   函数级  每个函数各问一次（并发）
 *   文件级  整份文件只问一次 —— 「这个文件放在这个路径下合不合理」
 *           只有看到路径才答得上，逐函数问 N 遍既浪费又答不准
 *
 * 单次请求失败**不中断整次检查** —— 并发跑十几个函数，挂掉一个就整份放弃，
 * 用户会以为整个文件都没问题。失败的进 failures 单独报。
 */
export async function checkSource(
  source: string,
  fileName: string,
  options: GuardOptions,
): Promise<CheckReport> {
  // 每次检查重读规则文件：用户改完 rules.md 下次运行就该生效，不该等重启
  const { rules, rubric } = loadRules()
  const fnRules = rules.filter(rule => rule.scope === 'function')
  const fileRules = rules.filter(rule => rule.scope === 'file')

  const lines = {
    warning: options.warningThreshold ?? DEFAULT_WARNING,
    error: options.errorThreshold ?? DEFAULT_ERROR,
  }
  const client = createClient(options)
  const model = options.model ?? DEFAULT_MODEL
  const concurrency = DEFAULT_CONCURRENCY

  const fns = extractFunctions(source, fileName)

  // 与 checkWholeFile 对称的守卫：把函数级规则全删光时（只留 placement 之类），
  // SDK 会以「At least one question is required」拒掉每一次请求 ——
  // 结果是 N 条 failures + 0 条违规，读起来却像「没问题」
  const results =
    fnRules.length === 0
      ? fns.map(() => [] as Violation[])
      : await runPool(fns, concurrency, async fn => {
          const scores = await askFunction(client, fn, fnRules, rubric, model)
          return toViolations(fn.name, fn.startLine, fn.endLine, scores, fnRules, lines)
        })

  const { violations, failures } = splitResults(fns, results)
  const whole = await checkWholeFile(client, fileName, source, { fileRules, rubric, model, lines })
  violations.push(...whole.violations)
  failures.push(...whole.failure)

  violations.sort((a, b) => b.confidence - a.confidence)
  return { file: fileName, functions: fns.length, violations, failures }
}

interface WholeFileRequest {
  fileRules: Rule[]
  rubric: Record<string, string>
  model: string
  lines: { warning: number; error: number }
}

/** 文件级那一遍。它挂了不该让函数级的结果一起消失，所以自己收着错误 */
async function checkWholeFile(
  client: ReturnType<typeof createClient>,
  fileName: string,
  source: string,
  request: WholeFileRequest,
): Promise<{ violations: Violation[]; failure: string[] }> {
  if (request.fileRules.length === 0) {
    return { violations: [], failure: [] }
  }

  try {
    const all = source.split('\n')
    const lineCount = all.length
    const file: FileSlice = {
      path: fileName,
      numbered: all
        .slice(0, MAX_FILE_LINES)
        .map((text, i) => `${i + 1}\t${text}`)
        .join('\n'),
    }

    const scores = await askFile(client, file, request.fileRules, request.rubric, request.model)

    return {
      violations: toViolations(fileName, 1, lineCount, scores, request.fileRules, request.lines),
      failure: [],
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { violations: [], failure: [`${fileName}（文件级）: ${reason}`] }
  }
}

/** 把并发池的「结果或错误」拆回两条流：违规、以及没问成的函数 */
function splitResults(
  fns: FnSlice[],
  results: Array<Violation[] | Error>,
): { violations: Violation[]; failures: string[] } {
  const violations: Violation[] = []
  const failures: string[] = []

  results.forEach((result, i) => {
    if (result instanceof Error) {
      failures.push(`${fns[i].name}: ${result.message}`)
    } else {
      violations.push(...result)
    }
  })

  return { violations, failures }
}

/** 把「规则 → 概率」里过线的那几条转成违规记录 */
function toViolations(
  target: string,
  startLine: number,
  endLine: number,
  scores: Record<string, number>,
  rules: Rule[],
  lines: { warning: number; error: number },
): Violation[] {
  const out: Violation[] = []
  for (const rule of rules) {
    const confidence = scores[rule.id]
    // 规则自己声明了就用自己的线，没有才落到全局的 warning 线
    const bar = rule.threshold ?? lines.warning
    if (confidence >= bar) {
      out.push({
        ruleId: rule.id,
        title: rule.title,
        target,
        startLine,
        endLine,
        confidence,
        severity: confidence >= lines.error ? 'error' : 'warning',
      })
    }
  }
  return out
}

/** 定长并发池：跑完一个补一个，不做无界并发去撞对方的限流 */
async function runPool<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<R | Error>> {
  const out: Array<R | Error> = new Array(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= items.length) {
        return
      }
      try {
        out[i] = await fn(items[i])
      } catch (error) {
        out[i] = error instanceof Error ? error : new Error(String(error))
      }
    }
  }

  // 至少起一个 worker：size 为 0 或负数时 Math.min 给 0，
  // out 会全是 undefined 空洞，调用方在 splitResults 里 push(...undefined) 直接 TypeError
  const width = Math.max(1, Math.min(size, items.length))
  await Promise.all(Array.from({ length: width }, worker))
  return out
}
