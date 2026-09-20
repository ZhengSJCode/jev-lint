#!/usr/bin/env node
import fs from 'node:fs'

import { checkFile, checkSource } from './core/check.js'
import { loadApiKey } from './core/env.js'
import { formatReport, toJson } from './core/format.js'

const USAGE = `用法: jev-guard <文件> [选项]
      cat foo.ts | jev-guard --stdin --name src/foo.ts

选项:
  --stdin           从标准输入读代码，而不是读文件
  --name <path>     --stdin 时给它一个路径，供「文件位置」规则判断
  --warning <n>     warning 线，达到才报，默认 0.7
  --error <n>       error 线，达到即必须改，默认 0.9
  --model <name>    模型，默认 jev-latest
  --json            输出 JSON 而不是文本
  -h, --help        显示本帮助`

interface Args {
  file: string
  name: string
  stdin: boolean
  warning: number
  error: number
  model: string
  json: boolean
}

/** 阈值必须是有限数 —— NaN 会让 confidence >= NaN 恒为 false，静默放行一切 */
function readThreshold(raw: string | undefined, flag: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`${flag} 需要一个数字，收到「${raw ?? ''}」`)
  }
  return value
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    file: '',
    name: '',
    stdin: false,
    warning: 0.7,
    error: 0.9,
    model: 'jev-latest',
    json: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') {
      args.json = true
    } else if (arg === '--stdin') {
      args.stdin = true
    } else if (arg === '--warning') {
      args.warning = readThreshold(argv[++i], '--warning')
    } else if (arg === '--error') {
      args.error = readThreshold(argv[++i], '--error')
    } else if (arg === '--name') {
      args.name = argv[++i] ?? ''
    } else if (arg === '--model') {
      args.model = argv[++i]
    } else if (!arg.startsWith('-')) {
      // 多余的裸参数直接报错，不静默覆盖：静默的话 `jev-guard a.ts b.ts`
      // 只会审 b.ts，而人以为两个都审了
      if (args.file) {
        throw new Error(`多余的参数「${arg}」：一次只审一个文件`)
      }
      args.file = arg
    }
  }
  return args
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('-h') || argv.includes('--help') || argv.length === 0) {
    console.log(USAGE)
    process.exit(argv.length === 0 ? 1 : 0)
  }

  const args = parseArgs(argv)
  if (!args.stdin && !args.file) {
    console.error('缺少文件参数\n\n' + USAGE)
    process.exit(1)
  }

  const report = args.stdin ? await checkStdin(args) : await checkOnDisk(args)

  console.log(args.json ? toJson(report) : formatReport(report))

  // 只有 error 才拦：warning 是「建议看一眼」，拿它拦 CI 是把人训练成无视警告
  const hasError = report.violations.some(v => v.severity === 'error')

  // 检查没做全就不能算通过。key 过期时每个函数都 401 → 零违规 → 退出码 0，
  // 于是一道已经废掉的门在 CI 里永远绿着 —— 这比误报危险得多
  if (report.failures.length > 0) {
    console.error(`有 ${report.failures.length} 项没检查成，结果不完整：`)
    for (const failure of report.failures.slice(0, 3)) {
      console.error(`  ${failure}`)
    }
  }

  // 用 exitCode 而不是 process.exit()：stdout 是管道时（mod 正是这么调的）
  // 写是异步的，立刻 exit 会不等 flush，报告尾部可能被截断
  process.exitCode = hasError || report.failures.length > 0 ? 1 : 0
}

/** 审标准输入里的代码 —— 「还没落盘的片段」走这条 */
async function checkStdin(args: Args) {
  const code = fs.readFileSync(0, 'utf8')
  return checkSource(code, args.name || 'snippet.ts', {
    apiKey: loadApiKey(process.cwd()),
    warningThreshold: args.warning,
    errorThreshold: args.error,
    model: args.model,
  })
}

async function checkOnDisk(args: Args) {
  return checkFile(args.file, {
    apiKey: loadApiKey(process.cwd()),
    warningThreshold: args.warning,
    errorThreshold: args.error,
    model: args.model,
  })
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
})
