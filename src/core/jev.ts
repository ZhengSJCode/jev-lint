import type { EntryType } from '@typesafe-ai/sdk'
import { noul, TypeSafeClient } from '@typesafe-ai/sdk'

import type { FnSlice, GuardOptions, Rule } from './types.js'

/**
 * 单次请求超时。
 *
 * 一个函数几十行、几个问题，比「逐行问 120 个问题」轻得多，
 * 所以比 vscode-hide-comments 里那套的 120s 收紧到 60s。
 */
const TIMEOUT_MS = 60_000

/** 默认模型。jev-latest 是这类结构化问答的当前版本 */
const DEFAULT_MODEL = 'jev-latest'

/** 文件级检查要看的内容：路径，加上带行号的正文 */
export interface FileSlice {
  path: string
  numbered: string
}

export function createClient(options: GuardOptions): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: options.apiKey,
    baseURL: options.baseUrl ?? 'https://api.typesafe.ai',
    defaultModel: options.model ?? DEFAULT_MODEL,
    timeout: TIMEOUT_MS,
  })
}

/**
 * 问一个函数的全部规则，返回 { 规则 id → 违规概率 }。
 *
 * 一次请求带 N 个问题，而不是 N 次请求各带一个问题 ——
 * 代码这段 state 只传一次，N 个问题共用它。
 */
export async function askFunction(
  client: TypeSafeClient,
  fn: FnSlice,
  rules: Rule[],
  rubric: Record<string, string>,
  model: string,
): Promise<Record<string, number>> {
  return ask(
    client,
    {
      说明: '下面是待审查的一个函数，行号是它在原文件里的位置',
      判定标准: rubric,
      代码: fn.numbered,
    },
    rules,
    model,
  )
}

/**
 * 问整个文件的规则，返回 { 规则 id → 违规概率 }。
 *
 * 与 askFunction 分开，是因为 state 要给的东西根本不同：
 * 「这个文件放在这个路径下合不合理」只有看到路径才答得上，
 * 而函数级的问题看到路径反而是噪音。
 */
export async function askFile(
  client: TypeSafeClient,
  file: FileSlice,
  rules: Rule[],
  rubric: Record<string, string>,
  model: string,
): Promise<Record<string, number>> {
  return ask(
    client,
    {
      说明: '下面是待审查的一个文件，行号是它在文件里的位置',
      判定标准: rubric,
      路径: file.path,
      代码: file.numbered,
    },
    rules,
    model,
  )
}

/** 两条链路共用的提问与取值：state 不同，问法与容错一样 */
async function ask(
  client: TypeSafeClient,
  state: EntryType,
  rules: Rule[],
  model: string,
): Promise<Record<string, number>> {
  const questions: Record<string, ReturnType<typeof noul>> = {}
  for (const rule of rules) {
    questions[rule.id] = noul(rule.question)
  }

  const { answers } = await client.systemOne({ state, questions, model })

  const out: Record<string, number> = {}
  for (const rule of rules) {
    // 缺答案按 0（不违规）处理：宁可漏报，也不拿一个凭空的值去指控用户
    out[rule.id] = answers[rule.id]?.noul ?? 0
  }
  return out
}
