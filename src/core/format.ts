import type { CheckReport } from './check.js'

/**
 * 报告只输出「哪一行的哪个函数踩了哪条规则」。
 *
 * 不带修复建议：jev 回答的是概率标量，它没有能力给出代码级建议，
 * 硬编一段模板话术就是拿模型的名义说它没说过的话。
 */
export function formatReport(report: CheckReport): string {
  const header = `jev-lint  ${report.file}  (${report.functions} 个函数)`

  if (report.violations.length === 0) {
    const note = report.failures.length ? `（${report.failures.length} 个函数没问成）` : ''
    return `${header}\n  未发现规范问题${note}`
  }

  const parts = [header]

  // 分两档列：error 是必须改的，warning 只是建议看 —— 混在一起列，
  // 读的人会分不清哪条真该动手
  for (const severity of ['error', 'warning'] as const) {
    const group = report.violations.filter(v => v.severity === severity)
    if (group.length === 0) continue

    const label = severity === 'error' ? '必须改' : '建议看'
    parts.push(`\n  ${severity}（${label}）`)
    for (const v of group) {
      const range = `L${v.startLine}-${v.endLine}`
      parts.push(
        `    ${v.confidence.toFixed(2)}  ${range.padEnd(12)} ${v.title.padEnd(10)} ${v.target}`,
      )
    }
  }

  if (report.failures.length) {
    parts.push(`\n  ! 未问成：${report.failures.slice(0, 3).join(' | ')}`)
  }
  return parts.join('\n')
}

export function toJson(report: CheckReport): string {
  return JSON.stringify(report, null, 2)
}

/**
 * 多份报告拼成一段。
 *
 * 单份的 formatReport 会印「未发现规范问题」，多份场景下那是噪音 ——
 * 调用方已经筛掉没违规的了，这里只拼有内容的。
 */
export function formatReports(reports: CheckReport[], failures: string[] = []): string {
  const parts = reports.map(formatReport)
  if (failures.length) {
    parts.push(`  ! ${failures.length} 个函数没问成：${failures.slice(0, 3).join(' | ')}`)
  }
  return parts.join('\n')
}
