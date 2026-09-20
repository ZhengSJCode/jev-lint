import type { FileSource } from './contract.js'
import { filePathOf } from './file-path-of.js'

/**
 * 逐次累积编辑工具改过的文件。
 *
 * 精确到「这一轮」：pending 在 files() 里读完就清空，下一轮从零开始。
 * 这是它相对 git-diff 的全部价值 —— 聊天轮里工作区有旧改动，它不会误报。
 */
export function toolCallSource(): FileSource {
  let pending = new Set<string>()

  return {
    id: 'tool-call',

    observe(event, result) {
      // 子代理的编辑不算在主循环这一轮的头上
      if (event.agentId !== undefined) {
        return
      }
      const path = filePathOf(result)
      if (path !== null) {
        pending.add(path)
      }
    },

    files() {
      const files = [...pending]
      pending = new Set()
      return Promise.resolve(files)
    },
  }
}
