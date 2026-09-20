/**
 * 两个 hook 适配器的公共件。
 *
 * 抽出来是因为 PostToolUse 和 Stop 的差异只在「审哪些文件、什么时候审」，
 * 读输入、判类型、输出上下文这几步完全一样 —— 复制两份就会漂移。
 */

import type { CheckReport } from '../core/check.js'
import { checkFile } from '../core/check.js'
import { loadApiKey } from '../core/env.js'

/** 只审这些扩展名。Python 的 AST 与 TS 解析器不兼容，暂不支持 */
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

export function isCodeFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  return dot >= 0 && CODE_EXT.has(filePath.slice(dot).toLowerCase())
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 把文字送进 Claude 的上下文。
 *
 * 不能直接 print —— PostToolUse / Stop 都不在「纯文本 stdout 进上下文」的例外名单里，
 * 那样写只会进 debug log。必须包成 hookSpecificOutput。
 */
export function emitContext(hookEventName: string, text: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        // 写成陈述句：命令式口吻会触发 Claude 的 prompt-injection 防御，内容会被转给人看
        additionalContext: text,
      },
    }),
  )
}

export interface GuardResult {
  /** 只含有违规的那些报告 */
  reports: CheckReport[]
  /** 请求失败的函数，形状「文件: 函数名: 原因」 */
  failures: string[]
}

/**
 * 对一组文件跑检查。
 *
 * 路径去重：一轮里同一个文件被改三次，没有理由审三遍 ——
 * 输入一模一样，结果也就一模一样。
 */
export async function guardFiles(files: string[], cwd: string): Promise<GuardResult> {
  const unique = Array.from(new Set(files.filter(isCodeFile)))
  const reports: CheckReport[] = []
  const failures: string[] = []

  for (const file of unique) {
    try {
      const report = await checkFile(file, { apiKey: loadApiKey(cwd) })
      if (report.violations.length > 0) {
        reports.push(report)
      }
      failures.push(...report.failures.map(f => `${file}: ${f}`))
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { reports, failures }
}
