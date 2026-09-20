import type { FileSource } from './contract.js'
import { FILE_SOURCE_IDS } from './contract.js'
import { gitDiffSource } from './git-diff.js'
import { toolCallSource } from './tool-call.js'

export type { FileSource } from './contract.js'
export { isCodeFile } from './contract.js'

/**
 * 按配置挑一个来源策略。
 *
 * 认不出的值退回 tool-call 而不是报错：这是插件的配置项，
 * 打错一个字就让整个 hook 罢工，比用默认值更糟。
 */
export function makeSource(kind: unknown): FileSource {
  const id = FILE_SOURCE_IDS.find(candidate => candidate === kind)
  return id === 'git-diff' ? gitDiffSource() : toolCallSource()
}
