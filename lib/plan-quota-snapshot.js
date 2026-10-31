/**
 * 套餐额度的**运行时快照**：把 `plan-quota` 的 HTTP 查询接进适配器的模型清单。
 *
 * ## 为什么单独一个模块
 *
 * `plan-quota.js` 只负责「怎么查、怎么归一」，它刻意不碰任何缓存策略之外的全局状态。
 * 而适配器需要的是一个**可以挂在 `listModels()` 里、失败也不影响列模型**的东西：
 *
 * - 额度查询要带 `X-Device-Mid`、要在拿到 token 之后、要能失败；
 * - `listModels()` 是 DSH 打开模型选择器就会调的热路径，**绝不能因为它挂了就列不出模型**；
 * - 额度是**按账号**的，不是按模型路由的，所以一个账号查一次就够，不需要每条路由查。
 *
 * 本模块把这三件事封起来：{@link QuotaSnapshot} 拿一次额度（带 TTL 缓存 + 失败退避），
 * {@link describeQuota}` 把结果压成一行给模型选择器用的文案。
 *
 * ## 额度能不能拿到，与「模型能不能用」是两件事
 *
 * 这是本模块最重要的契约：**任何失败都退化成"额度未知"，绝不抛出**。
 * 实测过的情况包括：token 缺失、网络不通、上游改字段、以及 2026-11-01 那次
 * `/v1/messages` 被 WAF 拦（`3012`）——那次额度接口（`billing/balance`）**仍然正常**，
 * 所以「模型调不通」时反而更需要把额度显示出来，而不是因为查不到就整块消失。
 *
 * @module dsh-connect-zcode/plan-quota-snapshot
 */

import { fetchBillingBalance, readDeviceMid } from './plan-quota.js'

/** 默认缓存 TTL：额度变化是慢过程，一分钟内重复开关选择器没必要重查。 */
export const DEFAULT_SNAPSHOT_TTL_MS = 60_000

/** 失败后的退避上限：连续失败时别把它变成每次 listModels 都打一次上游。 */
export const DEFAULT_RETRY_BACKOFF_MS = 5 * 60_000

/**
 * 一次额度查询的结果。
 *
 * @typedef {object} QuotaSnapshotState
 * @property {boolean} ok `billing/balance` 是否成功返回。
 * @property {number} fetchedAt 拉取时刻（毫秒）。
 * @property {string} [reason] 失败时的稳定机读原因（`token_missing` / `network` / `api_code` …）。
 * @property {string} [message] 失败时的人类可读说明。
 * @property {number} [serverTime] 上游 `server_time`（Unix 秒）。
 * @property {import('./plan-quota.js').NormalizedBalance[]} [balances] 归一后的余额条目。
 */

/**
 * 从一份 `billing/balance` 结果里挑出「这份账号的可用额度」。
 *
 * 同一个账号可能有多条 balance（不同套餐 / 不同模型），选择器只需要总量，所以：
 * - 拿 `available_units`（缺失时退回 `remaining_units`）求和；
 * - 总量拿 `total_units` 求和；
 * - 用「模型名」做分组，让文案能说出「这份额度对应哪个模型」。
 *
 * @param {import('./plan-quota.js').NormalizedBalance[]} balances 归一后的余额。
 * @returns {{ available: number, total: number, models: string[] }} 汇总。
 */
export function summarizeBalances(balances) {
  /** @type {string[]} */
  const models = []
  let available = 0
  let total = 0
  let sawNumber = false
  for (const balance of balances ?? []) {
    const left = balance.availableUnits ?? balance.remainingUnits
    if (typeof left === 'number' && Number.isFinite(left)) {
      available += left
      sawNumber = true
    }
    if (typeof balance.totalUnits === 'number' && Number.isFinite(balance.totalUnits)) {
      total += balance.totalUnits
      sawNumber = true
    }
    const label = balance.showName !== '' ? balance.showName : balance.entitlementId
    if (label !== '' && !models.includes(label)) models.push(label)
  }
  return { available: sawNumber ? available : 0, total, models }
}

/**
 * 把数字压成人类可读的紧凑形式（`499,755,434` → `4.998 亿`）。
 *
 * 选择器里的描述只有一行，完整数字会把候选链挤掉，所以这里用中文量级。
 *
 * @param {number} value 原值。
 * @returns {string} 紧凑文本。
 */
export function formatUnitCount(value) {
  if (!Number.isFinite(value)) return '?'
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`
  if (abs >= 1e4) return `${(value / 1e4).toFixed(1)} 万`
  return String(Math.round(value))
}

/**
 * 把额度快照压成一行给模型选择器用的文案。
 *
 * 设计原则：
 * - **成功时说出"还剩多少 / 一共多少"**，这是用户最想知道的；
 * - **失败时只说"额度未知"并给出原因**，不编造、不显示 0（0 会被误读成"没额度了"）；
 * - 没有余额条目时明确说"账号未报告余额"，而不是留空 —— 空字符串会让人以为功能没生效。
 *
 * @param {QuotaSnapshotState | undefined} state 额度快照。
 * @param {string} chain 原有的候选链描述（追加在后面）。
 * @param {string} [modelId] 只显示这个模型的额度（缺省时汇总全部）。
 * @returns {string} 描述文本。
 */
export function describeQuota(state, chain, modelId) {
  const base = typeof chain === 'string' ? chain : ''
  if (state === undefined) return base
  if (state.ok !== true) {
    const reason = state.reason === 'token_missing' ? 'no token' : (state.reason ?? 'unknown')
    return `${base} · quota unknown (${reason})`
  }
  const all = state.balances ?? []
  const wanted = typeof modelId === 'string' ? modelId.trim() : ''
  // 额度是按模型发的：一份 Start Plan 只给 GLM-5.3-Flash 额度，GLM-5.3 那条路由走的是
  // coding-plan。所以有 modelId 时只挑对应条目 —— 否则每个模型都显示同一个总量，
  // 用户会以为 GLM-5.3 也有这么多额度。
  const balances = wanted === ''
    ? all
    : all.filter((balance) => balanceMatchesModel(balance, wanted))
  if (balances.length === 0) {
    if (all.length === 0) return `${base} · quota: account reports no balance`
    // 有额度，但不属于这个模型 —— 这是重要信息，不能显示成"没额度"。
    return `${base} · quota: no plan for ${wanted}`
  }
  const { available, total } = summarizeBalances(balances)
  if (total > 0) {
    const pct = ((available / total) * 100).toFixed(0)
    return `${base} · quota ${formatUnitCount(available)}/${formatUnitCount(total)} (${pct}%)`
  }
  return `${base} · quota ${formatUnitCount(available)} left`
}

/**
 * 一条 balance 是否属于某个模型。
 *
 * 两条判据都试，因为上游只用其中一种：
 * - `capabilities` 里的 `model:<id>`（大小写不敏感，`glm-5.3-flash` ↔ `GLM-5.3-Flash`）；
 * - `show_name` 直接等于模型名。
 *
 * @param {import('./plan-quota.js').NormalizedBalance} balance 余额条目。
 * @param {string} modelId 上游模型 id。
 * @returns {boolean} 属于该模型时 true。
 */
export function balanceMatchesModel(balance, modelId) {
  const wanted = modelId.trim().toLowerCase()
  if (wanted === '') return false
  if (balance.showName !== '' && balance.showName.trim().toLowerCase() === wanted) return true
  for (const capability of balance.capabilities ?? []) {
    if (typeof capability !== 'string') continue
    const trimmed = capability.trim().toLowerCase()
    if (!trimmed.startsWith('model:')) continue
    if (trimmed.slice('model:'.length).trim() === wanted) return true
  }
  return false
}

/**
 * 带 TTL 的额度快照器。
 *
 * 与 `plan-quota` 的 `QuotaCache` 的区别：那个缓存的是**格式化好的 plan 列表**、并假定
 * 调用方一定想要成功结果；这个只关心「这份账号还剩多少」，并且**失败也要能回答**
 * （因为选择器要显示"额度未知"，不能因为失败就什么都不显示）。
 */
export class QuotaSnapshotter {
  /** @type {QuotaSnapshotState | undefined} */
  #state = undefined
  /** @type {Promise<QuotaSnapshotState> | undefined} */
  #inflight = undefined
  /** 连续失败次数，用于指数退避。 @type {number} */
  #failures = 0
  #ttlMs
  #backoffMs
  #now
  #fetchImpl
  #deviceMid
  #appVersion

  /**
   * @param {object} [options] 构造参数。
   * @param {number} [options.ttlMs] 成功结果的缓存时长。
   * @param {number} [options.backoffMs] 失败后的最长退避。
   * @param {() => number} [options.now] 时钟注入（测试用）。
   * @param {typeof fetch} [options.fetchImpl] fetch 注入（测试用）。
   * @param {string} [options.appVersion] 客户端版本。
   * @param {string} [options.deviceMid] 固定的 `X-Device-Mid`（缺省时按 dataBaseDir 读）。
   */
  constructor(options = {}) {
    this.#ttlMs = typeof options.ttlMs === 'number' ? options.ttlMs : DEFAULT_SNAPSHOT_TTL_MS
    this.#backoffMs = typeof options.backoffMs === 'number' ? options.backoffMs : DEFAULT_RETRY_BACKOFF_MS
    this.#now = typeof options.now === 'function' ? options.now : Date.now
    this.#fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : undefined
    this.#deviceMid = typeof options.deviceMid === 'string' ? options.deviceMid : undefined
    this.#appVersion = typeof options.appVersion === 'string' ? options.appVersion : undefined
  }

  /**
   * 只读地看一眼当前快照（不触发请求）。
   *
   * @returns {QuotaSnapshotState | undefined} 最近的快照。
   */
  peek() {
    return this.#state
  }

  /**
   * 取额度快照；必要时发起一次 HTTP 查询。**永不抛出**。
   *
   * @param {object} input 参数。
   * @param {string} input.token `zcodejwttoken`。
   * @param {string} [input.dataBaseDir] ZCode 数据根（用于读 `X-Device-Mid`）。
   * @param {boolean} [input.force] 跳过缓存。
   * @returns {Promise<QuotaSnapshotState>} 快照（失败也是合法结果）。
   */
  async get(input) {
    const now = this.#now()
    const cached = this.#state
    if (cached !== undefined && typeof input.force !== 'boolean') {
      const age = now - cached.fetchedAt
      const window = cached.ok ? this.#ttlMs : Math.min(this.#backoffMs, this.#ttlMs * 2 ** this.#failures)
      if (age >= 0 && age < window) return cached
    }
    if (this.#inflight !== undefined) return this.#inflight
    const pending = this.#fetch(input, now).finally(() => {
      this.#inflight = undefined
    })
    this.#inflight = pending
    return pending
  }

  /**
   * 真正发一次查询，并把结果记进 `#state`。
   *
   * @param {{ token?: string, dataBaseDir?: string, force?: boolean }} input 参数。
   * @param {number} now 取到的时刻。
   * @returns {Promise<QuotaSnapshotState>} 快照。
   */
  async #fetch(input, now) {
    const token = typeof input?.token === 'string' ? input.token.trim() : ''
    if (token === '') {
      return this.#remember({ ok: false, fetchedAt: now, reason: 'token_missing', message: '缺少 zcodejwttoken' })
    }
    const deviceMid = this.#deviceMid
      ?? (typeof input.dataBaseDir === 'string' && input.dataBaseDir !== '' ? readDeviceMid({ dataBaseDir: input.dataBaseDir }) : undefined)
    try {
      const result = await fetchBillingBalance({
        jwt: token,
        ...(this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl }),
        ...(deviceMid === undefined ? {} : { deviceMid }),
        ...(this.#appVersion === undefined ? {} : { appVersion: this.#appVersion }),
      })
      if (result.ok !== true) {
        return this.#remember({
          ok: false,
          fetchedAt: now,
          reason: result.reason ?? 'unknown',
          message: result.message ?? '',
        })
      }
      return this.#remember({
        ok: true,
        fetchedAt: now,
        ...(result.serverTime === undefined ? {} : { serverTime: result.serverTime }),
        // `fetchBillingBalance` 已经把上游 snake_case 归一过了，这里不能再归一一次：
        // 二次归一会在 `bucket_id`（此时已是 `bucketId`）上失配，把所有条目丢光。
        balances: result.balances,
      })
    } catch (/** @type {any} */ error) {
      return this.#remember({
        ok: false,
        fetchedAt: now,
        reason: 'network',
        message: error?.message ?? String(error),
      })
    }
  }

  /**
   * 记录快照并维护失败计数。
   *
   * @param {QuotaSnapshotState} state 新快照。
   * @returns {QuotaSnapshotState} 同一个对象。
   */
  #remember(state) {
    this.#state = state
    this.#failures = state.ok ? 0 : this.#failures + 1
    return state
  }
}
