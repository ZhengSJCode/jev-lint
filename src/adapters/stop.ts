/**
 * Claude Code 的 Stop hook 适配层 —— 真正的「质量门」。
 *
 * 与 PostToolUse 的分别：PostToolUse 面对的是已经写完的文件，只能追加信息；
 * Stop 能**拦住不让收工**（decision: block），Claude 会带着你给的理由继续干活。
 *
 * 输入里没有文件列表（官方给的 Stop 专属字段只有 stop_hook_active /
 * last_assistant_message / background_tasks / session_crons），而且官方明确警告
 * 不要解析 transcript —— 那是内部格式、随版本变。所以改动文件从 git 取。
 *
 * 三道保险，防止它变成甩不掉的循环：
 *   1. stop_hook_active 为 true 直接放行：本轮已经是「被拦下后继续」的产物
 *   2. 只有 error 级违规才拦（与 CLI 的退出码同口径），warning 只做提示 ——
 *      拿一条边缘误报把 Claude 逼回去改代码，比漏报更糟
 *   3. 官方另有「连续 8 次拦截后强制放行」的兜底
 */

import type { CheckReport } from '../core/check.js'
import { formatReports } from '../core/format.js'
import { changedFiles } from './changed.js'
import { emitContext, guardFiles, readStdin } from './shared.js'

interface StopPayload {
  cwd?: string
  stop_hook_active?: boolean
}

/**
 * decision / reason 是**顶层**字段。
 * 误放进 hookSpecificOutput 不会报错，会被静默忽略 —— 那样就变成「什么都没发生」。
 */
function writeBlock(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
}

async function main(): Promise<void> {
  const cwd = await stopCwd()
  if (cwd === null) {
    return
  }

  const files = changedFiles(cwd)
  if (files.length === 0) {
    return
  }

  const { reports, failures } = await guardFiles(files, cwd)
  report(reports, failures)
}

/**
 * 该从哪个目录找改动。
 *
 * 返回 null 表示这次不该做事：没输入、这次触发本身是「被上一个 Stop 拦下后继续」
 * （`stop_hook_active`，防死循环的关键）。
 */
async function stopCwd(): Promise<string | null> {
  const raw = await readStdin()
  if (!raw.trim()) {
    return null
  }

  const payload = JSON.parse(raw) as StopPayload
  return payload.stop_hook_active ? null : (payload.cwd ?? process.cwd())
}

/**
 * 把结果说出去。
 *
 * 三条出口，按「该不该拦」选：
 *   error   拦住不让收工（decision: block）
 *   其余    只提示（additionalContext），不拦
 *   全没查成 也必须说 —— 静默放行的话，一道已经废掉的门会一直「通过」下去
 */
function report(reports: CheckReport[], failures: string[]): void {
  if (reports.length === 0) {
    if (failures.length > 0) {
      emitContext('Stop', `jev-lint could not check any file:\n  ${failures.join('\n  ')}`)
    }
    return
  }

  const text = formatReports(reports, failures)
  // 口径与 CLI 的退出码一致：只有 error 才拦人。曾经在这里自定过一条 0.8 的线，
  // 结果 0.8~0.9（正好是 warning 区间）会被拦下、在 CLI 里却放行 ——
  // 两条链路对同一份结果给出相反判断，本身就是坑
  const canBlock = reports.some(r => r.violations.some(v => v.severity === 'error'))

  if (canBlock) {
    writeBlock(`${text}\n(the above comes from jev-lint's function-by-function check)`)
  } else {
    emitContext('Stop', text)
  }
}

main().catch(() => undefined)
