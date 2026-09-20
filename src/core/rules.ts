import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Rule, RuleScope } from './types.js'

/**
 * 规则从 markdown 读，不写死在代码里。
 *
 * 写死的版本没法让项目的使用者改口径 —— 想加一条「禁止 console.log」
 * 就得改 TS 再编译。
 */

export interface RuleSet {
  rules: Rule[]
  /**
   * 判定标准，按规则标题索引。
   *
   * 与提问分开：标准每批请求只传一次（state），提问每个函数都要问一遍。
   * 把标准写进提问，就是每个函数多花一份标准的 token。
   */
  rubric: Record<string, string>
}

/** 本包自带的规则：包根的 rules.md */
function bundledRulesPath(): string {
  // dist/core/rules.js → 上两级即包根
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', 'rules.md')
}

/**
 * 按优先级收集规则文件，**后者覆盖前者**（按 id）：
 *
 *   1. 本包自带的 rules.md          兜底，保证任何项目都有规则可用
 *   2. `~/.claude/rules/**`          你的全局规范
 *   3. `<项目>/.claude/rules/**`     项目自己的规范，优先级最高
 *
 * 后两个是 Claude Code 的官方 rules 机制。同一份文件 Claude 写代码时会读进上下文，
 * 这里拿它当检查项 —— **一份文件两边生效**，不用维护两遍。
 * 覆盖而不是叠加，是为了让项目能用同名小节改写全局口径（比如把某条规则的阈值调紧）。
 */
function collectRuleFiles(fromPath?: string): string[] {
  const files = [bundledRulesPath()]

  files.push(...markdownUnder(path.join(os.homedir(), '.claude', 'rules')))

  // 从被检查文件所在目录往上找，近的排后面（优先级更高）
  const start = fromPath ? path.dirname(path.resolve(fromPath)) : process.cwd()
  files.push(...projectRulesAbove(start))

  return files
}

/** 从 start 一路往上，收集沿途每个 `.claude/rules/` 下的 md */
function projectRulesAbove(start: string): string[] {
  const found: string[] = []
  let dir = start

  while (true) {
    found.unshift(...markdownUnder(path.join(dir, '.claude', 'rules')))
    const parent = path.dirname(dir)
    if (parent === dir) {
      return found
    }
    dir = parent
  }
}

/** 递归收集目录下的 .md。目录不存在就返回空 —— 这是常态，不是错误 */
function markdownUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return []
  }

  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...markdownUnder(full))
    } else if (entry.name.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

/**
 * 加载规则。
 *
 * `fromPath` 给被检查的文件路径 —— 规则按**它所在的项目**取，而不是按 jev-guard
 * 装在哪。不给就用当前工作目录。
 */
export function loadRules(fromPath?: string): RuleSet {
  const rules = new Map<string, Rule>()
  const rubric: Record<string, string> = {}

  for (const file of collectRuleFiles(fromPath)) {
    let parsed: RuleSet
    try {
      parsed = parseRules(fs.readFileSync(file, 'utf8'))
    } catch {
      // 单个规则文件读不了（权限、编码）不该让整次检查失败，跳过它
      continue
    }
    for (const rule of parsed.rules) {
      rules.set(rule.id, rule)
    }
    Object.assign(rubric, parsed.rubric)
  }

  return { rules: [...rules.values()], rubric }
}

/**
 * 解析一份规则 markdown。
 *
 * 只认 `## <id>` 和它下面的 `- 标题/范围/阈值/提问/标准:` 几种行，其余一律忽略 ——
 * 这样文件里可以随便写说明、示例、给模型看的散文（Claude Code 的 rules 文件就是
 * 正文 + 可选 frontmatter，`---` 那块自动落在这里的「其余」里）。
 */
function parseRules(md: string): RuleSet {
  const rules: Rule[] = []
  const rubric: Record<string, string> = {}
  let draft: Draft | null = null

  const flush = (): void => {
    // 缺标题或提问的小节是没写完或写错了，直接跳过，比拿半条规则去问模型好
    if (draft?.id && draft.title && draft.question) {
      rules.push({
        id: draft.id,
        title: draft.title,
        scope: draft.scope,
        question: draft.question,
        ...(draft.threshold !== undefined && { threshold: draft.threshold }),
      })
      if (draft.standard) {
        rubric[draft.title] = draft.standard
      }
    }
    draft = null
  }

  for (const line of contentLines(md)) {
    const heading = line.match(/^##\s+(\S+)\s*$/)
    if (heading) {
      flush()
      draft = { id: heading[1], title: '', question: '', standard: '', scope: 'function' }
      continue
    }
    if (draft) {
      Object.assign(draft, readField(line) ?? {})
    }
  }
  flush()

  return { rules, rubric }
}

/**
 * 逐行吐出内容，跳过 ``` 围栏内部。
 *
 * 规则文件里常拿代码块当格式示例，那里的 `## <id>` 是示例不是规则 ——
 * 不跳过它，解析出来就凭空多一条 id 叫 `<id>` 的规则，还会被真的发去问模型。
 */
function* contentLines(md: string): Generator<string> {
  let inFence = false
  for (const line of md.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (!inFence) {
      yield line
    }
  }
}

interface Draft {
  id: string
  title: string
  question: string
  standard: string
  scope: RuleScope
  threshold?: number
}

/**
 * 解析一行字段，返回它给 draft 带来的增量。
 *
 * 返回值而不是就地改传入的 draft：`readField(line, draft)` 那种写法里，
 * 数据流是藏起来的 —— 调用处看不出 draft 会被改写。
 */
function readField(line: string): Partial<Draft> | null {
  const field = line.match(/^-\s*(标题|提问|标准|范围|阈值)\s*[:：]\s*(.+?)\s*$/)
  if (!field) {
    return null
  }
  const [, name, value] = field

  if (name === '标题') {
    return { title: value }
  }
  if (name === '提问') {
    return { question: value }
  }
  if (name === '阈值') {
    // 解析不出数字就当作没写，落到全局线 —— 一个打错的数值不该让整条规则罢工
    const threshold = Number(value)
    return Number.isFinite(threshold) ? { threshold } : null
  }
  if (name === '范围') {
    // 只认「文件」二字，其余一律当函数级 —— 打错一个字就静默变成另一条规则，
    // 比退回默认值更糟，所以这里不做模糊匹配
    return { scope: value === '文件' ? 'file' : 'function' }
  }
  return { standard: value }
}
