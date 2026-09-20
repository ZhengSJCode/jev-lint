import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Rule, RuleScope } from './types.js'

/**
 * 规则从 rules.md 读，不写死在代码里。
 *
 * 写死的版本没法让项目的使用者改口径 —— 想加一条「禁止 console.log」
 * 就得改 TS 再编译。markdown 是能直接编辑、也能直接 review 的形式。
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

/** 默认规则文件：项目根的 rules.md */
function defaultRulesPath(): string {
  // dist/core/rules.js → 上两级即项目根
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', 'rules.md')
}

export function loadRules(mdPath: string = defaultRulesPath()): RuleSet {
  return parseRules(fs.readFileSync(mdPath, 'utf8'))
}

/**
 * 解析规则文件。
 *
 * 只认 `## <id>` 和它下面的 `- 标题/范围/提问/标准:` 四种行，其余（正文说明、代码块）
 * 一律忽略 —— 这样文件里可以随便写注释和示例，不影响解析。
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
      readField(line, draft)
    }
  }
  flush()

  return { rules, rubric }
}

/**
 * 逐行吐出内容，跳过 ``` 围栏内部。
 *
 * 规则文件开头用代码块讲格式，那里的 `## <id>` 是示例不是规则 ——
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

function readField(line: string, draft: Draft): void {
  const field = line.match(/^-\s*(标题|提问|标准|范围|阈值)\s*[:：]\s*(.+?)\s*$/)
  if (!field) {
    return
  }
  if (field[1] === '标题') {
    draft.title = field[2]
  } else if (field[1] === '提问') {
    draft.question = field[2]
  } else if (field[1] === '阈值') {
    // 解析不出数字就当作没写，落到全局线 —— 和认不出的 fileSource 一样，
    // 一个打错的数值不该让整条规则罢工
    const value = Number(field[2])
    if (Number.isFinite(value)) {
      draft.threshold = value
    }
  } else if (field[1] === '范围') {
    // 只认「文件」二字，其余一律当函数级 —— 打错一个字就静默变成另一条规则，
    // 比退回默认值更糟，所以这里不做模糊匹配
    draft.scope = field[2] === '文件' ? 'file' : 'function'
  } else {
    draft.standard = field[2]
  }
}
