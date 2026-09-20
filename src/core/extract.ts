import ts from 'typescript'

import type { FnSlice } from './types.js'

/**
 * 短于这个行数的函数不单独审。
 *
 * 实测 4 行的转发函数（`a(); b();` 两行调用）会被判成「违反单一职责 0.55」——
 * 上下文太少时模型给的是中庸概率，不是判断。这类函数职责一眼可见，
 * 不审它同时也省掉一次请求。
 */
const MIN_FN_LINES = 6

/**
 * 从源码里抽出「值得单独审」的函数。
 *
 * 用 TS 编译器而不是正则：正则数不清嵌套的花括号，也分不出
 * `{ a: () => x }` 这种对象字面量里的箭头函数算不算一个函数。
 *
 * 刻意**不深入函数体**：`arr.map(x => x.id)` 这种回调每个都单独审一遍，
 * 既慢又没有意义 —— 真正体现职责的是顶层函数和类方法。
 */
export function extractFunctions(source: string, fileName: string): FnSlice[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const lines = source.split('\n')
  const out: FnSlice[] = []

  const push = (node: ts.Node, name: string): void => {
    const slice = toSlice(sf, node, name, lines)
    if (slice.endLine - slice.startLine + 1 >= MIN_FN_LINES) {
      out.push(slice)
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      push(node, node.name.text)
      return
    }
    if (ts.isMethodDeclaration(node) && node.name) {
      push(node, node.name.getText(sf))
      return
    }
    if (isNamedFunctionVariable(node)) {
      push(node, node.name.text)
      return
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sf, visit)
  return out
}

/** `const foo = () => {}` / `const foo = function () {}` —— 有名字才收 */
function isNamedFunctionVariable(
  node: ts.Node,
): node is ts.VariableDeclaration & { name: ts.Identifier } {
  if (!ts.isVariableDeclaration(node) || !node.initializer) {
    return false
  }
  // 返回值里带上 name 的收窄：只断言 VariableDeclaration 的话，
  // node.name 仍是 BindingName（可能是解构模式），调用处取 .text 过不了类型检查
  if (!ts.isIdentifier(node.name)) {
    return false
  }
  return ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)
}

function toSlice(sf: ts.SourceFile, node: ts.Node, name: string, lines: string[]): FnSlice {
  const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1
  const slice = lines.slice(startLine - 1, endLine)

  return {
    name,
    startLine,
    endLine,
    // 行号用全文坐标，报告里点开就能对上编辑器
    numbered: slice.map((text, i) => `${startLine + i}\t${text}`).join('\n'),
  }
}
