import type { FileSource } from './contract.js'

/**
 * 从工具调用的结果里取文件路径。
 *
 * 两种形状都要认，因为它们出现在不同的地方：
 *
 *   { filePath: "..." }                     transcript 里存的工具结果（官方 diff mod 读的就是这个）
 *   { ref, result, text, isError }          `tool.call` hook 里 next(e) 返回的包装
 *
 * 后者是实测出来的：Write 的返回值字段是 ref/result/text/isError，
 * 文件路径嵌在 `result` 里一层。只认扁平形态的话一个文件都攒不到。
 */
export function filePathOf(result: unknown, depth = 0): string | null {
  if (!isRecord(result) || depth > 2) {
    return null
  }
  if (typeof result.filePath === 'string') {
    return result.filePath
  }
  return filePathOf(result.result, depth + 1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
