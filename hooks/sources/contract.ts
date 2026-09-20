/**
 * 「这一轮改了哪些文件」的来源策略。
 *
 * 两种取法各有各的适用面，谁也替代不了谁：
 *
 *   tool-call  逐次累积 Claude 真的调用过的编辑工具。
 *              精确到本轮，代价是依赖 tool.call 的结果结构，
 *              而且 Claude 用 Bash 改的文件（`sed -i`、`> file`）它看不见。
 *
 *   git-diff   直接问 git 工作区里有什么改动。
 *              结构稳定、能看见 Bash 的改动，代价是看到的是**一切**未提交改动，
 *              不区分是不是这一轮产生的 —— 聊天轮里工作区有旧改动也会被审。
 *
 * 两条路的差异只在「什么时候记、拿什么出结果」，所以封成同一个形状：
 * observe 决定要不要记（git-diff 不记，留空），files 负责出结果。
 */

export type FileSourceId = 'tool-call' | 'git-diff'

export const FILE_SOURCE_IDS: readonly FileSourceId[] = ['tool-call', 'git-diff']

export interface FileSource {
  /** 写进日志和错误信息，说明这份结果是谁找的 */
  readonly id: FileSourceId

  /**
   * 每次工具调用之后调用一次。
   * 不关心工具调用的策略（git-diff）留空即可。
   */
  observe(event: ToolCallEvent, result: unknown): void

  /**
   * 一轮结束时产出要审的文件（绝对路径）。
   *
   * 读完即清 —— 下一轮从这个策略拿到的应该是新一轮的东西，
   * 而不是把上一轮审过的又审一遍。
   */
  files(ctx: FileContext): Promise<string[]>
}

/**
 * 策略能用到的上下文。
 *
 * 刻意**不含 `$`**：引擎禁止把 `$` 整体传出去，校验原话是
 * 「$ itself is passed as an argument (bound, passed, spread, returned or read)」，
 * 只允许在调用点直接写 `$.noun.event(...)`。所以这里给的是调用方
 * 在调用点绑好的一个普通函数，策略永远拿不到 `$` 本身。
 */
export interface FileContext {
  cwd: string
  run(argv: string[]): Promise<CommandResult>
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ToolCallEvent {
  tool: string
  /** 有值说明这是子代理的调用，不该记在主循环头上 */
  agentId?: string
}

/**
 * 只审这些扩展名。Python 的 AST 与 TS 解析器不兼容，暂不支持。
 *
 * 与 src/core/file-kind.ts 是同一份逻辑的两处副本 —— mod 这边没法引那边：
 * 那条路径会把它拖进 src 的构建图，而这里是引擎直接加载的 TS 源码。
 */
export const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

export function isCodeFile(path: string): boolean {
  return CODE_EXT.some(ext => path.endsWith(ext))
}
