# jev

一句话：**jev 是 TypeSafe 的旗舰模型**，一个**结构化问答接口** —— 给它一份材料、一组事先定好的问题，它给回一组可以直接参与计算的答案。

官方自己的说法：

> a frontier-intelligence function call: unstructured state in, typed probabilistic decisions out

「一次前沿智能的**函数调用**」——进去是非结构化的材料，出来是**带类型的概率判断**。注意它说的是 function call，不是 chat。

## 名字的来由

| 名字 | 取自 | 为什么 |
|---|---|---|
| **System One**（模型类别） | 卡尼曼《思考，快与慢》里的「系统 1」 | 快、直觉，与慢推理的「系统 2」相对 |
| **jev**（具体型号） | 经济学家 William Stanley Jevons | 杰文斯悖论：成本每降一个数量级，用量反而涨 |

类别的定位是 "a class of AI models built to make fast, structured decisions that **software** can use directly" —— 它是给**程序**用的判断，不是给人看的回答。

## 和对话模型的差别

| | 对话模型 | jev |
|---|---|---|
| 问题在哪 | 提示词里，边聊边改 | 事先写在代码里，形状固定 |
| 给回什么 | 一段自然语言 | 数字 / 标签 / 分数 |
| 拿到之后 | 还得再解析一遍 | 直接比大小、进 if |
| 同一份输入 | 措辞可能变 | 概率值，可复现 |

使用姿势一句话概括：**你把判断标准写死，让它按标准给分**，而不是让它自由发挥。

| | |
|---|---|
| 接口 | `POST https://api.typesafe.ai/v1/systemone`（全站**只有这一个端点**） |
| SDK | `@typesafe-ai/sdk`，本项目用 0.6.0（Node 20+，MIT） |
| 模型 | 文档站目前只收录 **Jev 1.13**（ID `jev-1.13.0`），别名 `jev-latest` / `jev-preview` |
| 官方文档 | docs.typesafe.ai |

## 一次请求的形状

```ts
const { answers, usage } = await client.systemOne({
  state: 材料,                                    // 被判的东西
  questions: {
    srp: noul('这个函数是否违反了单一职责？'),      // 名字 → 问题
  },
  model: 'jev-latest',                            // 可省，走客户端默认
})

answers.srp.noul   // → 0.87
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `state` | 字符串 / 对象 / 数组 / `null` | 一次请求**只有一份** |
| `questions` | `{ 名字: Question }`，不能为空 | 名字只用于你取结果，官方明确它「不发给模型、不参与推理」 |
| `model` | 字符串，可省 | 不写继承客户端的 `defaultModel` |

**上限（官方给的）**：

| 项 | 值 |
|---|---|
| 单个请求 | 64k tokens |
| `state` + **最长的那一个问题** | 32k tokens |
| 多模态 | **不支持** —— 图片、音频、视频都不行，只有文本 |

`state` 建议用**对象**而不是一坨裸字符串：官方说这类模型「受过理解结构的训练」，而且各部分有名字、关系清楚时判得更准。还把内容与判断分开 —— `state` 放材料与支撑事实，`questions` 放判断本身。

## 三种问题类型

问题不是一句话，是一个**带 `type` 判别字段的对象**。SDK 提供三个构造器，官方明确「只有三种，没有第四种」：

| 构造器 | 问什么 | 答什么 | 读法 | 上限 |
|---|---|---|---|---|
| `noul(问题, criteria?)` | 是 / 否 | **yes 的概率**，0~1 | `answers.x.noul` | — |
| `choice(问题, {标签: 描述})` | 从命名选项里选一个 | 选中的标签 + 置信度 + 全量概率 | `answers.x.choice` | **最多 255 个选项** |
| `score(问题, [0 级描述, 1 级描述, …])` | 按有序量尺打分 | 期望分（可带小数）+ 置信度 + 量尺 | `answers.x.score` | **2 ~ 10 级** |

`noul` **没有** `confidence` 字段 —— 二值分布已经被那一个数穷尽了，没有多余的可以报。

`instructions` / `criteria` 可以是结构化的 JSON，对象里能用反引号引用键名（`` `field` ``）指向 state 里的具体字段。

> `noul` 这个词，官方只给定义（yes/no 原语）不给词源，别去猜它是什么缩写。

### `noul` 的措辞就是口径

这是最容易踩的一条：`noul` 返回的是**「是」的概率**，而「是」是什么由你问的那句话决定。

| 你问 | 拿到的是 | 阈值方向 |
|---|---|---|
| 「这个函数**是否违反**单一职责？」 | **违规**概率 | 越高越可疑 |
| 「这个函数**是否只做**一件事？」 | **合规**概率 | 越高越没问题 |

两句互补，但阈值方向正好相反。改措辞必须同步改阈值的含义。

`choice` 和 `score` 没这个坑：一个给标签，一个给分数，语义不会因为措辞翻转。

## 多个问题是**并行**的

官方原话：

> The state is ingested once, then all questions are evaluated **in parallel**.

所以「一次带 N 个问题」不只是省 token，也是**真的并发** —— 只是并发发生在服务端，不是客户端发多个请求。

四条实测性质：

1. **state 只消化一次**，N 个问题共用。
2. **加问题几乎不增加响应时间** —— 官方说 "adding more questions usually has little effect on response time"，多出来的只有每个问题自己的 token 成本。
3. **答案互不影响** —— "each question is scored on its own against the document, so its answer doesn't depend on what else is in the request"。官方做过 5 次重复测试，标准差 0.0。
4. **数量上限没有明文**。文档里最大的例子是一批 13 个问题，另一个例子里排了 182 个技能 —— 那些是**用例，不是上限**。

> 别把这一层和「函数级并发」搞混。本项目的并发单位是**函数**（一个函数一个请求），问题级并行是 jev 白送的。

## 答案之外

`systemOne` 返回一个 `APIPromise`，解出来是：

| 字段 | 内容 |
|---|---|
| `answers` | 按问题名索引的答案，类型由问题类型推导 |
| `model` | 实际使用的模型 |
| `usage` | `{ input_tokens, output_tokens }` |

`APIPromise` 本身还挂着 `response`（原始 Response）和 `requestId`。SDK 的第二个可选参数 `options` 能覆盖单次的超时、重试、取消信号和请求头。

## 限额与成本

| 项 | 值 |
|---|---|
| 速率限制 | **250,000 tokens/秒** 和 **1,200 请求/分钟**，超出返回 `429` |
| 定价 | **按 input token 计费，output tokens 免费**（$42 / Btok ≈ $0.042 / Mtok） |
| 单次超时 | SDK 默认 **10 秒**；**没有总重试预算** —— 只限单次，不限总时长 |
| 重试次数 | 2 次（初始尝试之外） |
| 重试退避 | 500ms 起，翻倍，上限 5s，带 25% 抖动 |
| 重试哪些 | 408、429、500~599；遵守 `Retry-After`，上限 60s |
| 错误码 | `401` key 无效、`422` 请求体校验失败、`429` 限流、`529` 服务过载 |

两条要留心的：

- 官方警告**限流是动态调整的**，高负载时可能无通知变动 —— 所以别把并发数顶到极限，本项目默认 4 就是这个考虑。
- **output 免费、input 计费**，意味着成本几乎只跟 `state` 的长度挂钩。往里塞的每一份材料都要钱，塞重复的材料就是重复付钱。

## 为什么这套形状适合判代码

三条，都是从 jev 的能力反推出来的：

1. **概率是可以切线的**。`noul` 给 0~1 的连续值，你可以同时控制「报多少」（warning 线）和「拦多严」（error 线）。是非题做不到 —— 只有「报」和「不报」两个状态，调松调紧只能改问题本身，改完不知道影响面。
2. **判定是可复现的**。每个问题独立评分，不依赖同批次里还有什么别的问题，所以概率值能当 CI 的门槛用。
3. **一次请求带 N 个问题**。材料只传一次、只计费一次，N 个问题并行出结果。

## 本项目怎么用它

这一节是 jev 的一个具体用例，不是 jev 的说明书。

**一条规则 = 一个 `noul` 问题**。`rules.md` 里每条规则给出一句「提问」和一句「标准」，前者变成问题，后者进 state：

```
state     = { 说明, 判定标准（全部规则的标准）, 代码 }
questions = { srp: noul('…'), long-function: noul('…'), … }
```

**为什么判定标准进 state 而不是进每个问题**：一次请求里有 N 个问题。标准放 state 只出现**一份**；放进每个问题的 `criteria`，就是 N 份。而 input token 是按量计费的，这直接是成本。

**两个请求函数，因为 state 该给的东西不同**：

| 函数 | state 里有什么 | 为什么 |
|---|---|---|
| `askFunction` | 说明 + 标准 + 函数源码 | 逐函数问，每个函数一次请求 |
| `askFile` | 说明 + 标准 + **文件路径** + 全文 | 「这个文件放在这个路径下合不合理」只有看到路径才答得上，而函数级的问题看到路径反而是噪音 |

**答案缺失按 0 处理**（`jev.ts`）：宁可漏报，也不拿一个凭空的值去指控用户。

## 官方怎么看这类用例

值得知道：**官方文档里没有一页专门讲代码审查**。最接近的是 use-case-map 里的一句话，把 Jev 查询当作

> automated semantic lints to code and writing

—— 在 CI 里跑团队规范检查、标出违规。剩下的都是可迁移的方法论（分类、护栏、引用校验），不是代码场景。

所以这个项目做的事**在官方是边角用例**：路子对得上（语义 lint），但细节没有现成答案可抄，都得自己验。

## 边界与坑

1. **中文的准确率不是最高的**。官方说英语是主要训练语言、准确率最高；**CJK 等其他语言接受，但准确率更低**。本项目的规则、提问、判定标准全是中文 —— 命中率怎么受影响，得自己拿对照组量，不能假定和英文样例一样。
2. **一次请求只有一份 `state`**。想判定两份不同的材料（比如「A 和 B 哪个更好」），要么合并进同一份 state，要么发两次请求。
3. **`state` + 最长的问题不能超过 32k tokens**。这个项目把「全部规则的标准」+「完整源码」都塞进 state，规则一多、文件一大就会顶到上限 —— 现在没有任何截断保护（文件级那条只截了行数，不是按 token）。
4. **它只答问题，不给建议**。回答的形状是你事先声明的，它没有能力输出代码级修复建议。报告里也不该编一段模板话术冒充它的意见。
5. **不在问题清单里的事，它不会主动说**。问漏了的规则不会「顺便提一句」。
6. **概率贴着阈值时不稳定**。实测某函数连续两次给 `0.50`，第三次落到线下，报出的条数从 2 变 1。所以阈值要停在命中聚集区间的边上，别正好切在峰上。
7. **`questions` 不能为空**，空着会被 `At least one question is required` 拒掉 —— 拦截的时候记得处理，否则会读成「没问题」。

## 最小可用示例

```ts
import { noul, TypeSafeClient } from '@typesafe-ai/sdk'

const client = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY })

const { answers, usage } = await client.systemOne({
  state: 'function sum(a, b) { return a + b }',
  questions: {
    long: noul('这个函数是否超过 30 行？', {
      true: '超过 30 行',        // 描述「是」那一头是什么意思，
      false: '没有超过',          // 让判定有据可依而不是靠猜
    }),
  },
})

console.log(answers.long.noul, usage.input_tokens)
```

## 依据

- 官方文档站 docs.typesafe.ai：`concepts/system-one`、`concepts/state`、`concepts/use-case-map`、`primitives/*`、`models`、`api`、`patterns/fan-out`
- 官网博客 typesafe.ai/blog/introducing-system-one-models-and-jev（「jev」命名来由只出现在这里，文档站没有）
- 本地 SDK：`@typesafe-ai/sdk` 0.6.0 的类型定义与实现

未能查到的：`noul` 的词源；一次请求的问题数上限；RLCD（训练方法）的技术细节 —— 官网只有一句缩写展开，文档站完全不提。
