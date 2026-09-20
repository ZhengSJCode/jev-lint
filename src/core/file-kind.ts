/**
 * 「这个路径算不算代码文件」。
 *
 * 单独成一个零依赖模块，是因为问这个问题的有两类调用方：
 *   shared.ts / contract.ts   要审的文件，跑在 Node 或 mod 沙箱里
 *   changed.ts                要先过滤再比数量上限
 * 后者不能从 shared 引 —— 那条路径会连带加载 check.js 与 TS 编译器。
 */

/** 只审这些扩展名。Python 的 AST 与 TS 解析器不兼容，暂不支持 */
const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

export function isCodeFile(filePath: string): boolean {
  return CODE_EXT.some(ext => filePath.endsWith(ext))
}
