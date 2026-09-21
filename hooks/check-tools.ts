import type { Report, RunCli } from './run-cli.js'
import { checkFileViaCli, checkSnippetViaCli } from './run-cli.js'

/**
 * 注册给模型的工具 —— mod 的第二种形态。
 *
 * 官方 mods 的 README 把两种形态写得清楚：hook 自动跑，tool 让模型自己调。
 * 这里两个都做 —— `turn.complete` 兜底审一遍，这两个工具则让模型
 * 想查就查，还能查还没落盘的代码。
 *
 * 注册动作在 `session.start` 之后才被接受（更早调用会被拒，注册出来的
 * 全名是 `mcp__<plugin>__<name>`），所以响应它的 `tool.call`
 * hook 必须用全名去匹配。
 */

/** 与 .claude-plugin/plugin.json 的 name 一致 —— 工具全名靠它拼出来 */
const PLUGIN_NAME = 'jev-lint'

export const TOOL_SPECS = [
  {
    name: 'check_file',
    description:
      'Audit an existing code file function by function with jev, against the rules in rules.md. ' +
      'Returns results in two levels, error / warning; states it plainly when there are no violations. Good for a self-check right after editing a file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'absolute path to the file' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'check_snippet',
    description:
      'Audit a piece of code that has not been written to disk yet (a function you just thought through, a snippet not yet saved). ' +
      'Uses the same rules as check_file but does not require the file to exist. Good for asking before you start writing.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'the code to audit' },
        file_name: {
          type: 'string',
          description:
            'the path it is intended for (e.g. src/order/tax.ts), used by the "file placement" rule; omit to skip that rule',
        },
      },
      required: ['code'],
    },
  },
]

/**
 * 响应这些工具调用时，`tool.call` 的 matcher 要用的全名。
 *
 * 显式标成模板字面量类型：引擎的 matcher 只接受内置工具名或
 * `mcp__<X>__<Y>` 这个形状，收成 string[] 就过不了校验。
 */
export const TOOL_MATCHERS = TOOL_SPECS.map(
  (spec): `mcp__${string}__${string}` => `mcp__${PLUGIN_NAME}__${spec.name}`,
)

export interface ToolRequest {
  tool: string
  /**
   * 工具调用的入参。
   *
   * 引擎把参数**平铺在事件对象上**（Edit 就是 `e.file_path`、`e.old_string`），
   * 不是塞在某个 `input` 字段里 —— 所以调用方传的是事件本身。
   */
  args: Record<string, unknown>
  run: RunCli
  cli: string
}

/** 执行一次工具调用，返回给模型看的文本 */
export async function serveTool(request: ToolRequest): Promise<string> {
  const outcome = request.tool.endsWith('check_snippet')
    ? await checkSnippetVia(request)
    : await checkFileViaCli(request.run, request.cli, String(request.args.file_path ?? ''))

  // 失败也要说清楚原因：只回一句「没能给出结果」，模型和人都不知道
  // 是 key 过期了还是接口挂了，只能反复重试
  return outcome.ok ? render(outcome.report) : `jev-lint could not complete the check: ${outcome.reason}`
}

function checkSnippetVia(request: ToolRequest) {
  const code = String(request.args.code ?? '')
  const fileName = String(request.args.file_name ?? 'snippet.ts')
  return checkSnippetViaCli(request.run, request.cli, code, fileName)
}

/** 工具返回的文本。没有违规时也明说，免得模型以为调用失败了 */
function render(report: Report): string {
  if (report.violations.length === 0) {
    const note = report.failures.length ? `(${report.failures.length} items could not be asked)` : ''
    return `${report.file}: no violations found${note}`
  }

  // 分两档：error 是必须改的，warning 只是建议看。混着列会让模型分不清该动哪个
  const groups = (['error', 'warning'] as const).flatMap(severity => {
    const group = report.violations.filter(v => v.severity === severity)
    if (group.length === 0) return []
    const label = severity === 'error' ? 'must fix' : 'worth a look'
    return [
      `  ${severity}（${label}）`,
      ...group.map(v => {
        const range = `L${v.startLine}-${v.endLine}`
        return `    ${v.confidence.toFixed(2)}  ${range.padEnd(12)} ${v.title}  ${v.target}`
      }),
    ]
  })

  return [`${report.file}: ${report.violations.length} hits`, ...groups].join('\n')
}
