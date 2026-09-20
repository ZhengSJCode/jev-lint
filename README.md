# jev-guard

用 TypeSafe 的 jev 逐函数审查代码规范。规则写在 `rules.md` 里，作为 Claude Code mod 在一轮结束时自动审这一轮改过的文件。

## 结构

```
.claude-plugin/plugin.json   mod 清单
hooks/hooks.json             声明入口模块
hooks/register.ts            mod 入口：挂 4 个 hook
hooks/check-tools.ts         注册给模型的 check_file / check_snippet
hooks/run-cli.ts             子进程调 CLI（沙箱里没有 Node）
hooks/sources/               改动文件来源策略：contract + 两种实现
rules.md                     规则定义（改完下次运行即生效）
types/claude-code.d.ts       引擎类型声明（/plugin-types 生成）
tsconfig.hooks.json          hooks 的类型检查配置

src/                         核心与 CLI（mod 通过子进程调用它）
  core/
    types.ts     公共类型：Rule / FnSlice / Violation
    rules.ts     解析 rules.md
    extract.ts   源码 → 函数片段（TS AST）
    jev.ts       TypeSafe 客户端与提问
    check.ts     编排：抽函数 → 并发问 → 过滤阈值
    env.ts       API key 加载
    format.ts    报告渲染
  index.ts       CLI 入口
  adapters/      settings hook 版适配（备选路线）
```

## 规则写在 rules.md 里，不在代码里

规则、提问、判定标准全部定义在项目根的 `rules.md`：

```markdown
## srp

- 标题: 违反单一职责
- 提问: 这个函数是否违反单一职责——做了不止一件事，且这些事不属于同一抽象层次？
- 标准: 一个函数只做一件事。说成「先…然后…顺便…」就是两件事
```

改完**下次运行就生效**，不用重新编译 —— 每次检查都会重读这个文件。文档里的围栏代码块会被跳过，所以可以在开头随便写格式示例。

默认 **12 条** —— 清单不在这里重复列，就以上面那个文件为准。列一份在这里，改了规则就得记得改两处，迟早漂。

想加一条「留下调试输出」之类，在 `rules.md` 里追加一个小节即可。

> `提问` 的措辞即口径：问「是否违反单一职责」拿到的是**违规**概率，问「是否只做一件事」拿到的是**合规**概率。阈值方向正好相反，改措辞必须同步改阈值。

规则不是写完就算数 —— 每条都用**对照组**验过（同一种问题，一个该报一个不该报），验证结果与两条阈值线的来由见下面「阈值」一节。

## 为什么用 jev 判，而不是让 Claude 自己看

Claude 审自己刚写完的代码有三个问题：

1. **确认偏误** —— 它刚决定这么写，回头判「这么写好不好」天然偏向通过
2. **结果不稳定** —— 同一段代码问两次可能给不同结论，没有可复现的基线
3. **没有旋钮** —— 想让它更严或更松，只能改提示词，改完不知道影响面有多大

jev 给的是**概率标量**，配上两条线（error / warning）就能同时控制「报多少」和「拦多严」。判定本身是稳定的 ——
实测同一文件连跑三次，命中集合完全一致（`entropy-analyzer.ts` 2/2/2 条、`skeleton.ts` 3/3/3 条）。

唯一的例外是**概率恰好等于阈值的那个**：实测 `askChunk` 的 `srp` 连续两次给 `0.50`，第三次落到线下，
于是从 2 条变成 1 条。所以阈值最好停在命中聚集区间的边上，别正好切在峰上。

## 用法

### 命令行

```bash
npm install
npm run build

# 审一个文件
node dist/index.js src/core/check.ts

# 调阈值 / 输出 JSON
node dist/index.js src/core/check.ts --warning 0.6 --error 0.85 --json
```

有 **error 级**违规时退出码为 `1`（warning 只打印，不影响退出码）—— 可以直接接进 CI 或 pre-commit。

## 作为 Claude Code mod 使用（推荐）

mod 是 Claude Code 的定制机制：一个插件，行为写在 TypeScript 的 hooks 模块里。本项目的 `.claude-plugin/plugin.json` + `hooks/register.ts` 就是一个 mod。

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /Volumes/Lenovo/code/jev-guard
```

它挂四个 hook，两种形态：

| hook | 做什么 |
|---|---|
| `session.start` | 注册 `check_file` / `check_snippet` 两个工具（模型主动调的形态） |
| `tool.call`（`Edit` / `Write` / `NotebookEdit`） | 只把被编辑的文件路径记下来，微秒级，不做判断 |
| `tool.call`（`mcp__jev-guard__*`） | 模型调上面那两个工具时执行检查 |
| `turn.complete` | 一轮结束，把记下的攒一起审一遍，命中写在该轮回答的下方 |

**为什么这比 settings hook 准**：它审的是**这一轮真正被编辑的文件**。settings hook 只能靠 `git status` 猜，看到的是工作区里所有历史未提交改动 —— 聊天轮里有旧改动也会被误审。

三条防打扰的规则：

1. **子代理不审** —— `e.agentId` 有值就原样放行（子代理的编辑不记在主循环头上）
2. **没正常答完不审** —— `e.reason !== 'answer'` 时跳过：中断、拒绝、报错三种收尾里代码多半没改完
3. **没有命中就不输出** —— 第一原则是不打扰

### 改动文件的两种取法（策略模式）

插件选项 `fileSource` 决定「这一轮改了哪些文件」怎么算：

| 值 | 取法 | 优点 | 代价 |
|---|---|---|---|
| `tool-call`（默认） | 逐次累积 Claude 调过的编辑工具 | **精确到本轮** —— 聊天轮里工作区有旧改动也不会误报 | 看不见 Bash 改的文件（`sed -i`、`> file`） |
| `git-diff` | 问 git 要工作区改动 | 看得见 Bash 的改动，结构稳定 | 看到的是**一切**未提交改动，分不清是不是这轮产生的 |

配置方式（用户级 `~/.claude/settings.json`）：

```json
{
  "pluginConfigs": {
    "jev-guard": {
      "options": { "fileSource": "git-diff" }
    }
  }
}
```

认不出的值退回 `tool-call` 而不是报错 —— 这是配置项，打错一个字就让整个 hook 罢工，比用默认值更糟。

两个策略都在 `hooks/sources/` 下，各自一个文件，共用 `contract.ts` 定义的形状：`observe` 决定要不要记（`git-diff` 留空），`files` 负责出结果。加第三种取法只需要实现这一个接口。

> 接口**刻意不接收 `$`**。引擎校验禁止把 `$` 整体传出去（原话：
> `$ itself is passed as an argument (bound, passed, spread, returned or read)`），
> 只允许在调用点写 `$.noun.event(...)`。所以 `files()` 收的是一个在调用点绑好的普通函数。

本地校验：

```bash
claude plugin validate .          # 引擎按它实际加载的方式读清单和 hooks，报告会被拒绝的地方
npx tsc -p tsconfig.hooks.json    # 类型检查
```

> ⚠️ function hooks 是**早期访问**，官方明说这个接口可能在版本间无预警变化。
> `types/claude-code.d.ts` 是引擎的声明文件，由 `/plugin-types` 生成 —— 升级 Claude Code 后建议重新生成一份。

## 备选：settings hook

不想启用 function hooks，也可以走传统的 `settings.json`：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /Volumes/Lenovo/code/jev-guard/dist/adapters/stop.js",
            "timeout": 300
          }
        ]
      }
    ]
  }
}
```

它的改动文件只能靠 `git status --porcelain` 取（Stop 的输入里没有文件路径，官方也明确警告不要解析 transcript），所以：只在 git 仓库里生效、看到所有未提交改动、超过 20 个文件就跳过。

`decision`/`reason` 是**顶层**字段，放进 `hookSpecificOutput` 会被静默忽略。

想每改一个文件就立刻看反馈，把 `Stop` 换成 `PostToolUse` + `matcher: "Edit|Write"` + `dist/adapters/hook.js` 即可（代价是每个文件一次模型调用）：

> ⚠️ PostToolUse 下 **exit 0 的纯文本 stdout 只进 debug log**，Claude 根本看不见
> （进上下文的例外名单只有 `UserPromptSubmit`、`SessionStart` 那几个）。必须包成
> `hookSpecificOutput.additionalContext`。

## 阈值：error / warning 两级

分数决定一切，规则本身不动。两条线：

| 级别 | 默认线 | 什么意思 | 实测依据 |
|---|---|---|---|
| **error** | ≥ `0.9` | **必须改** —— CLI 返回非 0，能拦住 CI | 0.9 以上**只有真命中** |
| **warning** | ≥ `0.7` | 建议看 —— 只列出来，不拦任何东西 | 0.7 以下是噪音；0.7~0.9 是「值得扫一眼」的区间 |

低于 warning 线连报都不报。

**每条规则还能自带一条线**（在 `rules.md` 里写 `- 阈值: 0.9`），覆盖全局的 warning 线。这不是可选项 —— 实测各条规则的分布差得很远：

| 规则 | 真命中 | 误报 | 给它设的线 |
|---|---|---|---|
| `srp` | 0.69 ~ 0.87 | 0.05 ~ 0.15（编排函数） | **0.65** |
| `stringly-typed` | 0.96 | 0.74 ~ 0.88（正当的字符串处理） | **0.9** |
| 其余 | — | — | 全局 0.7 |

一条全局线分不开这两类：按 `stringly-typed` 设 0.9，`srp` 该报的就漏了；按 `srp` 设 0.65，`stringly-typed` 的误报就全进来了。

**为什么退出码只看 error**：拿 warning 去拦 CI，会把所有人都训练成无视警告 —— 分级的意义正在这儿。同一个项目跑下来：阈值 0.5 报 18 条（几乎全是噪音）、0.9 报 1 条（真命中）。

```bash
node dist/index.js src/foo.ts --warning 0.6 --error 0.85
```

### 别用改规则的方式降误报

走过一遍。教训是：那样会把通用的业界规则改成越来越长的特例集合（「`fs`/`process` 不算」「工厂函数不算」「排版宽度不算」……），而且每条规则的最佳阈值还各不相同，最后没有一个统一的旋钮。

**误报与漏报的取舍，全部交给这两条线。**

唯一的例外是**判据本身不可判** —— 那时候要改的不是措辞，而是规则的去留：

| 症状 | 例子 | 处置 |
|---|---|---|
| 需要看调用方才知道对不对 | `swallow`（吞异常）：错误降级后上边有没有兜底，函数里看不出来 | **删掉规则**（`rules.md` 里留了记录） |
| 判据是主观印象 | `side-effect` 原本问「名字是否**暗示**只读」，反例 `syncUser` 被判 0.88 | **换成可枚举的判据** —— 改成「前缀是不是 `get`/`calc`」，同一批样本 0.96 对 0.03 |

### 哪些规则验证过

每条都用**对照组**验过（同一种问题，一个该报一个不该报）—— 除了 `dead` / `dup` 这两条最早写的规则，它们没单独跑过对照组，下面这张表里也就不列：

| 规则 | 对照结果 | 结论 |
|---|---|---|
| `flag-arg` | 0.97 vs 0.04 | 可靠 |
| `output-arg` | 0.98 vs 0.01 | 可靠 |
| `new-dep` | 0.98 vs 0.02 | 可靠 |
| `side-effect` | 0.96/0.94 vs 0.03/0.02/0.10 | 可靠（判据必须用前缀） |
| `mixed-return` | 0.95 vs 0.11 | 可靠 |
| `magic` | 0.93 vs 0.37 | 可靠 |
| `srp` | 0.87 vs 0.18 | 可用，但真实项目上误报偏多（编排函数会被判多职责） |
| `placement` | ① 0.92 vs 0.04 ② 两个真实项目 | 可靠：marauder 40 个领域目录文件 **0 报**；vscode-hide-comments 23 个文件报出 7 个且**全在 `utils/`** |
| `swallow` | 空 `catch` 判成不违规、有交代的反判违规 | **不可靠，已删** |

**写新规则前的自检**：判它所需的全部信息，都在这一个函数里吗？把函数原样挪到另一个调用点，结论会不会翻转？会翻转的就不该进来 —— `swallow` 就是这么被拦下的。

## 已知限制

- **只支持 TS/JS**。Python 的 AST 与 TS 解析器不兼容，要用得另写 `extract`
- **每个函数一次请求**。20 个函数的文件就是 20 次调用，并发 4 跑大约 4 秒 —— 挂在大文件上会明显拖慢编辑
- **不出修复建议**。jev 只回答概率标量，它没有能力给出代码级建议；报告里也不会编一段模板话术冒充它的意见
- **不审匿名回调**。`arr.map(x => ...)` 这类嵌套回调不单独成片，真正体现职责的是顶层函数和类方法

核心（`core/`）不依赖 Claude Code 的任何东西。想换成 MCP server、skill 或别的编辑器插件，换一个薄适配层即可。
