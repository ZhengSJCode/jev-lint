/**
 * 通过子进程调用 CLI。
 *
 * mod 的沙箱里没有 Node、没有文件系统 —— core 那套（TS AST、TypeSafe SDK）
 * 在 hook 模块里根本跑不起来。所以检查一律交给 `dist/index.js` 做，
 * 这里只负责传参和收结果，hook 与 tool 两条链路共用。
 */

export interface Report {
  file: string
  functions: number
  violations: Array<{
    ruleId: string
    title: string
    target: string
    startLine: number
    endLine: number
    confidence: number
    severity: 'error' | 'warning'
  }>
  failures: string[]
}

/**
 * 一次检查的结果。
 *
 * 不用 `Report | null`：那样「检查通过了」和「根本没查成」都是 null，
 * 而这两种情况对使用者意味着完全相反的事 —— 前者可以放心，
 * 后者说明这道门已经废了（key 过期、接口挂了），却一个字都不显示。
 */
export type CheckOutcome = { ok: true; report: Report } | { ok: false; reason: string }

/**
 * 调用方在 `$` 的调用点绑好的运行器。
 *
 * 收的是参数和 init，不是 `$` 本身 —— 后者传出去会被引擎校验拒掉。
 * init 与 `$.process.run` 的第二参数一致：`{ cwd, env, stdin, timeoutMs }`。
 */
export type RunCli = (
  argv: string[],
  init?: { cwd?: string; stdin?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/**
 * 子进程超时，故意给到引擎允许的上限（十分钟）而不是它的默认 30 秒。
 *
 * 这条链路一个文件就要跑「函数数 ÷ 4」波，每波 SDK 单次超时 60s —— 20 个函数
 * 必然超过 30s。超时后子进程被杀，结果只剩空报告，而使用者会以为代码是干净的。
 */
const CLI_TIMEOUT_MS = 600_000

/** 审一个已存在的文件 */
export async function checkFileViaCli(
  run: RunCli,
  cli: string,
  fileName: string,
): Promise<CheckOutcome> {
  return parse(await safeRun(run, ['node', cli, fileName, '--json']))
}

/** 审一段还没落盘的代码。走 CLI 的 --stdin，不必先写文件 */
export async function checkSnippetViaCli(
  run: RunCli,
  cli: string,
  code: string,
  fileName: string,
): Promise<CheckOutcome> {
  return parse(await safeRun(run, ['node', cli, '--stdin', '--name', fileName, '--json'], code))
}

async function safeRun(
  run: RunCli,
  argv: string[],
  stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    // stdin 走 init 而不是 shell 重定向：代码里什么字符都可能有，
    // 拼命令行就得处理引号、heredoc 定界符这些，交给引擎传更稳
    return await run(argv, {
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: CLI_TIMEOUT_MS,
    })
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: String(error) }
  }
}

function parse(result: { exitCode: number; stdout: string; stderr: string }): CheckOutcome {
  // CLI 约定：有 error 级违规退 1，没违规退 0，其余是它自己出错
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    const detail = tail(result.stderr) || tail(result.stdout) || `退出码 ${result.exitCode}`
    return { ok: false, reason: detail }
  }

  try {
    return { ok: true, report: JSON.parse(result.stdout) as Report }
  } catch {
    return { ok: false, reason: `输出不是合法 JSON：${tail(result.stdout)}` }
  }
}

/** 截一小段给人看 —— 完整输出可能几百行 */
function tail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed
}
