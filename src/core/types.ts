/**
 * 三条链路上的公共类型：源码 → 函数片段 → 违规。
 *
 * 分开定义是因为它们的生产者和消费者完全不同：
 * FnSlice 由 extract 产出、check 消费；Violation 由 check 产出、适配层消费。
 */

/** 规则的作用范围：逐函数问，还是整个文件问一次 */
export type RuleScope = 'function' | 'file'

/** 一条规范。jev 对每条规范投一个问题，答案是「违规」的概率 */
export interface Rule {
  /** 稳定标识，写进报告和配置，改名会破坏历史记录的可比性 */
  id: string
  /** 人读的名字 */
  title: string
  /**
   * 这条规则问几遍。缺省是 function。
   *
   * 「文件位置是否合理」这类判断只在文件尺度上成立 —— 逐函数问 N 遍
   * 既浪费请求，答案也不准：单个函数看不出自己在哪一层目录。
   */
  scope: RuleScope
  /**
   * 向 jev 提的问题。**措辞即口径** ——
   * 问「是否违反单一职责」得到的是违规概率，问「是否只做一件事」得到的是合规概率，
   * 两者互补但阈值方向相反。改这句话必须同步改 warningThreshold / errorThreshold 的含义。
   */
  question: string
}

/** 一个待检查的函数片段 */
export interface FnSlice {
  /** 函数名。匿名回调没有名字，用它的行号兜底 */
  name: string
  /** 1-based，闭区间 */
  startLine: number
  endLine: number
  /** 带行号的源码，行号是它在原文件里的绝对位置 */
  numbered: string
}

/** 一条命中 */
export interface Violation {
  ruleId: string
  title: string
  /** 函数名 */
  target: string
  startLine: number
  endLine: number
  /** jev 给出的「违规」概率，0~1 */
  confidence: number
  /** 达到 error 线就是必须改，否则只是建议看 */
  severity: 'error' | 'warning'
}

/** 一次检查的配置 */
export interface GuardOptions {
  apiKey: string
  baseUrl?: string
  model?: string
  /**
   * warning 线：达到它才报出来，但只是提示。
   * 低于它连报都不报 —— 实测 0.7 以下几乎全是噪音。
   */
  warningThreshold?: number
  /**
   * error 线：达到它就是必须改的。
   * 实测 0.9 以上只有真命中，所以 CLI 只在这条线上才返回非 0 退出码。
   */
  errorThreshold?: number
}
