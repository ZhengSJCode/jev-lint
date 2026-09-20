import type { FileContext, FileSource } from './contract.js'
import { isCodeFile } from './contract.js'

/**
 * 直接问 git 要改动文件。
 *
 * 两条 git 命令合起来才等于「工作区里改过的文件」：
 *   diff --name-only HEAD                 已跟踪文件的改动
 *   ls-files --others --exclude-standard  全新、还没被跟踪的文件
 *
 * 只用前者会漏掉这一轮新建的文件 —— 而那恰恰是最该审的东西。
 */
export function gitDiffSource(): FileSource {
  return {
    id: 'git-diff',

    // git 不需要逐次记录：它在 files() 里一次性问出全量
    observe() {},

    async files(ctx: FileContext): Promise<string[]> {
      // 两条命令的路径基准**不一样**：diff 输出相对仓库根，ls-files 输出相对 cwd。
      // 在 monorepo 子包里起会话时这个差别会让其中一半路径拼错，所以统一改用仓库根
      const root = await rootOf(ctx)
      if (root === null) {
        return []
      }

      const tracked = await pathsOf(ctx, ['git', 'diff', '--name-only', '-z', 'HEAD'])
      const untracked = await pathsOf(ctx, [
        'git',
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ])

      // 空仓库里没有 HEAD，diff 会失败 —— 那时候 ls-files 的结果就是全部
      return [...tracked, ...untracked].map(relative => append(root, relative)).filter(isCodeFile)
    },
  }
}

/** 仓库根的绝对路径 */
async function rootOf(ctx: FileContext): Promise<string | null> {
  const lines = await pathsOf(ctx, ['git', 'rev-parse', '--show-toplevel'])
  return lines[0] ?? null
}

/**
 * 跑一条 git 命令，按 `\0` 切出路径。
 *
 * 全程带 `-z`：默认格式对非 ASCII 与含空格的路径做 C 风格转义再加引号
 * （`"\344\270\255\346\226\207.ts"`），不还原那层转义，这些文件会被
 * `isCodeFile` 判为非代码文件静默跳过 —— 中文文件名在国内项目里是常态。
 */
async function pathsOf(ctx: FileContext, argv: string[]): Promise<string[]> {
  try {
    const { exitCode, stdout } = await ctx.run(argv)
    return exitCode === 0 ? stdout.split('\0').filter(Boolean) : []
  } catch {
    return []
  }
}

/** 拼绝对路径。沙箱里没有 Node 的 path 模块，只能自己接 */
function append(root: string, relative: string): string {
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  return `${base}/${relative}`
}
