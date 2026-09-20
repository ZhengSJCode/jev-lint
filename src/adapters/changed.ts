import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { isCodeFile } from '../core/file-kind.js'

/**
 * 找出「这一轮改过哪些文件」。
 *
 * Stop hook 的输入里没有文件路径（那是 PostToolUse 才有的 tool_input.file_path），
 * 所以只能自己找。两种办法：
 *
 *   git   —— 工作区里未提交的改动
 *   时间  —— 最近 N 分钟内被写过的文件
 *
 * 选 git：它是稳定契约，而「按修改时间捞」要递归整个仓库、撞上 node_modules 之类的
 * 目录就得写排除规则，判据还随文件系统精度浮动。
 *
 * 代价（必须知道）：git 看到的是「所有未提交改动」，不区分是不是这一轮改的。
 * 在一个积压了几十处未提交改动的仓库里，它会从头到尾审一遍。所以下面卡了上限。
 */

/** 最多审这么多文件。超了说明这个仓库的未提交改动多半不是本轮产生的，宁可不审 */
const MAX_FILES = 20

/**
 * porcelain 每行的固定宽度：两个状态字符 + 一个空格。
 *
 * 写成常量而不是散落的 2 和 3 —— 那两个数看着像魔法数字，实际是格式定义的一部分，
 * 但只有给了名字才看得出这一点。
 */
const STATUS_WIDTH = 2
const PATH_START = 3

/** 跑一条 git 命令。不是 git 仓库时 git 会往 stderr 喷一堆，这里不需要转达 */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * 仓库根。
 *
 * git 的路径输出是**相对仓库根**的，不是相对 cwd —— 在 monorepo 子包里起会话时
 * （`claude` 跑在 `packages/api`），直接拼到 cwd 上会得到
 * `<repo>/packages/api/packages/api/src/x.ts` 这种谁都不存在的路径。
 */
function toplevelOf(cwd: string): string | null {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim() || null
  } catch {
    return null
  }
}

/**
 * `status --porcelain -z` 的输出 → 路径列表。
 *
 * 用 `-z` 而不是默认格式：默认格式对非 ASCII 与含空格的路径做 C 风格转义再加引号
 * （`"\344\270\255\346\226\207.ts"`），还原那层转义比想象中麻烦，而漏还原的后果是
 * 这些文件被 `isCodeFile` 判为非代码文件**静默跳过** —— 中文文件名在国内项目里是常态。
 *
 * `-z` 是原样 UTF-8、`\0` 分隔。重命名写成 `R  <新名>\0<旧名>`：新名在前，
 * 后面那个旧名要跳过，否则会被当成一个真实路径去读。
 */
function pathsOf(raw: string): string[] {
  const parts = raw.split('\0')
  const out: string[] = []

  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) {
      continue
    }
    const status = entry.slice(0, STATUS_WIDTH)
    out.push(entry.slice(PATH_START))
    if (status.startsWith('R') || status.startsWith('C')) {
      i++
    }
  }
  return out
}

/**
 * 工作区里改动过的**代码**文件（绝对路径）。
 *
 * 任何一步失败都返回空数组 —— 找不出改动就不审，比审错一堆好。
 */
export function changedFiles(cwd: string): string[] {
  const root = toplevelOf(cwd)
  if (root === null) {
    return []
  }

  try {
    // 先按扩展名过滤再比上限：一轮里生成了 20 张 png 加 2 个 .ts，
    // 卡在未过滤的 22 上会让那两个 .ts 一条都不审，且没有任何提示。
    //
    // 必须带 -uall：默认 git 把未跟踪的**目录**折叠成一条（`?? packages/`），
    // 那是个目录名不是文件，过滤扩展名时会被整个丢掉 —— 新写的文件全看不见
    const all = pathsOf(git(cwd, ['status', '--porcelain', '-z', '-uall']))
      .map(rel => path.resolve(root, rel))
      .filter(isCodeFile)

    return all.length > MAX_FILES ? [] : all
  } catch {
    return []
  }
}
