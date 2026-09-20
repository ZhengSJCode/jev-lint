/**
 * Claude Code 的 PostToolUse hook 适配层。
 *
 * 契约：hook 进程从 stdin 收到一段 JSON，其中 tool_input.file_path 是刚被改的文件
 * （官方保证是绝对路径）。输出必须是 stdout 上的 JSON，见 emitContext 的说明。
 *
 * 三条「不做事」的规则，都是为了让这个 hook 不打扰人：
 *   1. 非代码文件直接退出
 *   2. 没有违规什么都不输出
 *   3. 任何异常都吞掉并以 0 退出 —— hook 挂掉不该让 Claude 的编辑失败
 *
 * 注意它拦不住工具调用（PostToolUse 时文件已经写入）。想「不通过就不让收工」，
 * 用同目录的 stop.ts。
 */

import { formatReports } from '../core/format.js'
import { emitContext, guardFiles, isCodeFile, readStdin } from './shared.js'

interface HookPayload {
  cwd?: string
  tool_input?: { file_path?: string }
}

async function main(): Promise<void> {
  const raw = await readStdin()
  if (!raw.trim()) {
    return
  }

  const payload = JSON.parse(raw) as HookPayload
  const filePath = payload.tool_input?.file_path
  if (!filePath || !isCodeFile(filePath)) {
    return
  }

  const cwd = payload.cwd ?? process.cwd()
  const { reports, failures } = await guardFiles([filePath], cwd)
  if (reports.length === 0) {
    return
  }

  emitContext('PostToolUse', formatReports(reports, failures))
}

// hook 里任何失败都不该冒泡成非 0 退出码 —— 那会被 Claude Code 当成阻断
main().catch(() => undefined)
