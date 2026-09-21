import fs from 'node:fs'
import path from 'node:path'

/**
 * 找 API key。
 *
 * 顺序：环境变量 → 启动目录下的 .env。
 * 环境变量优先，是因为 hook 场景下 key 由 Claude Code 的 settings 注入更省事 ——
 * 不必要求每个被检查的项目都放一份 .env。
 */
export function loadApiKey(startDir: string): string {
  const fromEnv = process.env.TYPESAFE_API_KEY
  if (fromEnv) {
    return fromEnv
  }

  const envPath = path.join(startDir, '.env')
  if (fs.existsSync(envPath)) {
    const matched = fs.readFileSync(envPath, 'utf8').match(/^\s*TYPESAFE_API_KEY\s*=\s*(.+)$/m)
    if (matched) {
      return stripInlineComment(matched[1])
    }
  }

  throw new Error('TYPESAFE_API_KEY not found: set the environment variable, or put a .env in the current directory')
}

/**
 * 去掉值尾部的行内注释。
 *
 * `.env` 里写「KEY=sk-xxx # prod」是常见习惯，不剥掉的话 key 尾部会多出
 * 「 # prod」，报出来是 401 —— 排查方向会被整个带偏。
 * 引号包裹的值不动：那里的 # 是值的一部分。
 */
function stripInlineComment(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return trimmed.replace(/^["']|["']$/g, '')
  }
  const hash = trimmed.indexOf('#')
  return (hash >= 0 ? trimmed.slice(0, hash) : trimmed).trim()
}
