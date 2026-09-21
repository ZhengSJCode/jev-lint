import type { On, Register } from 'claude-code'

import { serveTool, TOOL_MATCHERS, TOOL_SPECS } from './check-tools.js'
import type { Report, RunCli } from './run-cli.js'
import { checkFileViaCli } from './run-cli.js'
import type { FileSource } from './sources/index.js'
import { isCodeFile, makeSource } from './sources/index.js'

/**
 * jev-lint 作为 Claude Code mod 的入口 —— 两种形态都在这里挂上。
 *
 * 自动（hook）：
 *   `tool.call`      累积这一轮被编辑的文件，或响应模型对我们工具的调用
 *   `turn.complete`  一轮结束，审这一轮改过的文件，写回回答下方
 *
 * 主动（tool）：`session.start` 时注册 check_file / check_snippet，
 * 之后模型想查哪个文件、甚至还没落盘的代码，都可以自己调。
 *
 * 「这一轮改了哪些文件」由 hooks/sources/ 下的策略决定，插件选项 `fileSource` 切换。
 * 配置**不在** `register` 的第二个参数里 —— 那是 plugin.json 里声明的插件默认值，
 * 本插件没声明；用户配置在 `settings.pluginConfigs["jev-lint"].options`，要在
 * session.start 时从 `$` 读。
 *
 * 每个 hook 注册在各自的函数里，而不是都堆在 register 里：那样 register
 * 会长到 60 行、一眼看不出挂了几件事。但 handler 里的 `$` 必须在各自内联用 ——
 * 它不能传出去（引擎校验会拒），所以能拆的只有「注册动作」这一层。
 */

/** 与 .claude-plugin/plugin.json 的 name 一致，用来定位 settings 里自己的那一段 */
const PLUGIN_NAME = 'jev-lint'

/** 改动文件的工具。取自官方 diff mod 的 EDITING_TOOLS —— 没有 MultiEdit，它已不存在 */
const EDITING_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

/** 一次最多审这么多文件。一轮里改出 20 个以上，多半是批量生成，审了也看不完 */
const MAX_FILES = 20

/** 报告里最多列这么多条，多了没人读 */
const MAX_HITS = 10

/**
 * 一次并行审几个文件。
 *
 * 每个子进程内部还会再并发 4（CLI 的 runPool），所以这里是 2 × 4 = 8 ——
 * 对「不撞对方限流」这个目标来说够用了，再大就是拿请求量赌接口的容忍度。
 */
const FILE_BATCH = 2

export const register: Register = (on, options) => {
  // 先拿 register 收到的 options 顶上（plugin.json 声明过的话它就有效），
  // session.start 再用 settings 里的用户配置覆盖
  let source: FileSource = makeSource(readOption(options, 'fileSource'))

  on('session.start', async ($, e, next) => {
    const settings = await $.settings.read().catch(() => null)
    source = makeSource(pickFileSource(settings))

    for (const spec of TOOL_SPECS) {
      // 注册失败（比如同名被占）不该让整个插件挂掉，顶多是模型少一个工具
      await $.tool.register(spec).catch(() => undefined)
    }
    return next(e)
  })

  // 传取值函数而不是实例：session.start 之后 source 会被换成配置指定的那个
  trackEditedFiles(on, () => source)
  serveCheckTools(on)
  reviewChangedFiles(on, () => source)
}

/**
 * 从引擎的 settings 里挖出 `fileSource`。
 *
 * 收的是 settings 这个普通对象，不是 `$` —— 后者传出去会被引擎校验拒掉。
 * 认不出来就返回 undefined，由 makeSource 退回默认策略：配置项打错一个字
 * 就让整个 hook 罢工，比用默认值更糟。
 *
 * 沿途每一层都可能是 undefined 或不是对象（用户只配了中间一层、
 * settings 读出来是空对象……），所以每步都过一遍 asRecord 再往下走。
 */
function pickFileSource(settings: unknown): unknown {
  const configs = asRecord(settings)?.pluginConfigs
  const mine = asRecord(configs)?.[PLUGIN_NAME]
  const options = asRecord(mine)?.options
  return asRecord(options)?.fileSource
}

/** 收窄成普通对象；不是对象（含 null、数组以外的一切）就给 null */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** 记下这一轮被改过的文件，留给 turn.complete 消费 */
function trackEditedFiles(on: On, sourceOf: () => FileSource): void {
  on('tool.call', { tool: [...EDITING_TOOLS] }, async ($, e, next) => {
    const result = await next(e)
    sourceOf().observe({ tool: e.tool, agentId: e.agentId }, result)
    return result
  })
}

/** 模型调用了我们注册的工具：跑一次检查，把结果原样回给它 */
function serveCheckTools(on: On): void {
  on('tool.call', { tool: TOOL_MATCHERS }, async ($, e) => {
    const text = await serveTool({
      tool: e.tool,
      // 引擎把工具参数平铺在事件对象上，不是塞在某个 input 字段里
      args: e as unknown as Record<string, unknown>,
      // `$` 只能在调用点这样用 —— 传出去会被引擎校验拒掉
      run: (argv, init) => $.process.run(argv, init),
      cli: `${$.plugin.root}/dist/index.js`,
    })
    return { result: text }
  })
}

/** 一轮结束：把这一轮改过的文件审一遍，命中写在回答下方 */
function reviewChangedFiles(on: On, sourceOf: () => FileSource): void {
  on('turn.complete', async ($, e, next) => {
    // 子代理的轮次原样放行，且不碰策略 —— 策略里记的是主循环的东西
    if (e.agentId !== undefined) {
      return next(e)
    }

    // `$` 的三个能力在调用点各自绑定后传进去 —— `$` 本身不能传出调用点，
    // 所以抽出去的是「拿到能力之后干什么」
    const text = await reviewTurn({
      reason: e.reason,
      source: sourceOf(),
      cwd: () => $.session.cwd(),
      run: (argv, init) => $.process.run(argv, init),
      cli: `${$.plugin.root}/dist/index.js`,
    })

    return text === null ? next(e) : { text }
  })
}

/** 汇总后的一条命中：违规字段 + 它来自哪个文件 */
type Hit = Report['violations'][number] & { file: string }

interface TurnDeps {
  reason: string
  source: FileSource
  cwd: () => Promise<string>
  run: RunCli
  cli: string
}

/**
 * 一轮结束后的审查。任何失败都不往上冒 —— 它是收尾动作，
 * 挂了不该影响这一轮本身（CLI 挂了、接口超时都算）。
 */
async function reviewTurn(deps: TurnDeps): Promise<string | null> {
  try {
    // 先取再判断：中断、拒绝、报错的轮次也要把累积清掉，
    // 否则它改到一半的文件会被算进下一轮的账上
    const cwd = await deps.cwd()
    const files = await deps.source.files({ cwd, run: deps.run })

    if (!shouldReview(deps.reason, files)) {
      return null
    }
    return await guard(deps.run, deps.cli, files)
  } catch {
    return null
  }
}

/** 中断、拒绝、报错三种收尾里代码多半没改完，审了只会添乱 */
function shouldReview(reason: string, files: string[]): boolean {
  return reason === 'answer' && files.length > 0 && files.length <= MAX_FILES
}

/**
 * 审这些文件，产出要显示在回答下方的文字；没什么可报的就返回 null。
 *
 * 收 run 和 cli 而不是 `$`：后者传出去会被引擎校验拒掉。
 */
async function guard(run: RunCli, cli: string, files: string[]): Promise<string | null> {
  const codeFiles = files.filter(isCodeFile)
  if (codeFiles.length === 0) {
    return null
  }

  const outcomes = await runFilesInBatches(run, cli, codeFiles)
  const reports = outcomes.flatMap(outcome => (outcome.ok ? [outcome.report] : []))
  const reasons = outcomes.flatMap(outcome => (outcome.ok ? [] : [outcome.reason]))

  return render(reports, codeFiles.length, reasons)
}

/**
 * 分批审文件。
 *
 * 单文件的并发由 CLI 自己控制（`check.ts` 的 runPool，默认 4），但那是在
 * **每个子进程内部**。这里如果对文件一把 `Promise.all`，20 个文件就是
 * 20 × 4 = 80 个并发请求同时打出去 —— 正好和 runPool 那句
 * 「不做无界并发去撞对方的限流」的意图相反。
 */
async function runFilesInBatches(
  run: RunCli,
  cli: string,
  files: string[],
): Promise<Array<Awaited<ReturnType<typeof checkFileViaCli>>>> {
  const out: Array<Awaited<ReturnType<typeof checkFileViaCli>>> = []
  for (let i = 0; i < files.length; i += FILE_BATCH) {
    const batch = files.slice(i, i + FILE_BATCH)
    out.push(...(await Promise.all(batch.map(file => checkFileViaCli(run, cli, file)))))
  }
  return out
}

/**
 * 排成几行。没有违规、也没出岔子就什么都不说 —— 不打扰是这个 hook 的第一原则。
 *
 * failures 要单独说：检查失败和检查通过都表现为「没有命中」，但前者意味着
 * 这道门已经废了（key 过期、接口挂了），不说就永远不会被发现。
 */
function render(reports: Report[], scanned: number, failures: string[] = []): string | null {
  const hits = reports
    .flatMap(report => report.violations.map(violation => ({ file: report.file, ...violation })))
    .sort((a, b) => b.confidence - a.confidence)

  if (hits.length === 0 && failures.length === 0) {
    return null
  }

  return [
    `jev-lint audited ${scanned} changed files, ${hits.length} hits:`,
    // 分两档列：error 是必须改的，warning 只是建议看
    ...renderSeverity(hits, 'error', 'must fix'),
    ...renderSeverity(hits, 'warning', 'worth a look'),
    ...renderFailures(failures),
    '(the above comes from jev-lint\'s function-by-function check; rules are in rules.md)',
  ].join('\n')
}

/** 渲染一档。这一档没有命中就返回空数组，让调用方直接展开 */
function renderSeverity(hits: Hit[], severity: 'error' | 'warning', label: string): string[] {
  const group = hits.filter(hit => hit.severity === severity)
  if (group.length === 0) {
    return []
  }
  return [
    `  ${severity}（${label}）`,
    ...group.slice(0, MAX_HITS).map(hit => {
      const name = hit.file.split('/').pop()
      return `    ${hit.confidence.toFixed(2)}  ${name}:${hit.startLine}-${hit.endLine}  ${hit.title}  ${hit.target}`
    }),
  ]
}

/** 没检查成的文件 —— 不说的话，它的「没有命中」会被当成「通过」 */
function renderFailures(failures: string[]): string[] {
  if (failures.length === 0) {
    return []
  }
  return [
    `  ! ${failures.length} files could not be checked (the results above are incomplete):`,
    ...failures.map(f => `    ${f}`),
  ]
}

/** `register` 收到的插件选项。本插件没在 plugin.json 里声明，通常拿不到东西 */
function readOption(options: unknown, key: string): unknown {
  return asRecord(options)?.[key]
}
