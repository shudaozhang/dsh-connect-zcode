/**
 * ZCode 账号套餐额度（billing）的直连 HTTP 读取层。
 *
 * 这个模块只做一件事：把本机 ZCode 账号的 `zcodejwttoken` 变成一个「有没有额度、额度是什么」
 * 的结构化结果，供 DSH 侧展示（模型选择器、诊断面板、`dsh-connect-zcode` 的命令行）。
 * 它**不发起模型推理**（那是 `lib/plan-client.js`），也**不启动任何子进程**。
 *
 * ## 实测事实（2026-10-27，本机真实凭证，Windows / node 26）
 *
 * ```
 * GET https://zcode.z.ai/api/v1/zcode-plan/billing/current
 *   Authorization: Bearer <zcodejwttoken>
 * → 200 {"code":0,"msg":"","data":{"server_time":1793089474,"plans":[]},"logid":"…"}
 *
 * GET …/billing/current  （不带任何 query / 不带 X-Client-* 头）
 * → 200  同上            ← app_version / platform 不是必需的
 * GET …/billing/current  （Authorization 换成 oauth:bigmodel:access_token 或干脆不带）
 * → 401（空 body）
 *
 * GET …/billing/balance[?app_version=3.16.3&platform=win32-x64]
 *   + X-Device-Mid: <UUID>
 * → 200 {"code":0,"msg":"","data":{"server_time":…,"plans":[],"balances":[]},"logid":"…"}
 * GET …/billing/preview[?app_version=3.16.3&platform=win32-x64]
 *   + X-Device-Mid: <UUID>
 * → 200 {"code":0,"msg":"","data":{"server_time":…,"plans":[]},"logid":"…"}
 * 同上但**不带** X-Device-Mid
 * → 400 {"code":3001,"msg":"parameter error","logid":"…"}   ← 缺的是这个头，不是 app_version
 * POST …/billing/balance  /  POST …/billing/preview
 * → 404 "404 page not found"                                ← 这两个只有 GET 路由
 * ```
 *
 * 也就是说：`current` **不需要** `X-Device-Mid`，而 `balance` / `preview` **必须**带它。
 * 这个头是 2026-10-27 用控制变量实验定位出来的（16/16 带则 200、11/11 不带则 400；
 * 换成 `X-Device-Id` / `Device-Mid` / 任意其它头一律 400）——**不是**限流，也**不是**
 * `app_version` 的问题。详见 `docs/quota-api.md` 的「400 之谜」一节。
 *
 * `plans: []` 是**正确结果**而不是失败：它表示这个账号当前没有可用的套餐额度。任何把
 * 「空数组」当成异常的实现都会在本机（无额度账号）上误报。
 *
 * ## 字段口径（从客户端 3.16.3 的 `getManualClaimPlanPreviews` / `claimManualPlan` 抄来）
 *
 * - 所有时间戳一律是 **Unix 秒**（与 `server_time` 同单位）。要展示就 `* 1000`，
 *   本模块不做单位转换，避免把「秒/毫秒」这个最容易出错的约定埋进实现里。
 * - entitlement 的 `id` 取自 `entitlement_id`；**空 id 的 entitlement 直接丢弃**
 *   （客户端也是这么做的：`flatMap` + `if (!u) return []`）。
 * - 缺 `plan_id` 的 plan 也直接丢弃，理由同上。
 * - `grant_units` 用容忍式数字解析（数字或纯数字字符串），缺失记 `0`。
 * - `meter` / `unit_type` / `period` 是**服务端透传字符串**，不是枚举强校验：客户端对
 *   未知取值也是原样显示（`unitType === 'token' ? 本地化文案 : unitType`）。已知取值见
 *   {@link KNOWN_METERS} / {@link KNOWN_UNIT_TYPES} / {@link KNOWN_PERIODS}。
 *
 * ## 注入式设计
 *
 * 所有网络函数都接受 `fetchImpl`（默认 `globalThis.fetch`），{@link QuotaCache} 也把它
 * 放在构造参数里。模块顶层**绝不**触碰全局 `fetch`，因此单测可以在零网络的情况下跑完
 * 归一、汇总、缓存 TTL、失败不污染缓存等全部路径。
 *
 * @module lib/plan-quota
 */

import { createRequire } from 'node:module'
import { join as joinPath } from 'node:path'

/** 默认端点 origin（与客户端 `buildZCodeEndpointUrls` 的默认值一致）。 */
export const DEFAULT_BASE_ORIGIN = 'https://zcode.z.ai'

/** 默认客户端版本号（用于 query 与 `X-ZCode-App-Version`，与客户端硬编码的 `Pr` 一致）。 */
export const DEFAULT_APP_VERSION = '3.16.3'

/** 默认单次请求超时（毫秒，与客户端 `Js = 15e3` 一致）。 */
export const DEFAULT_TIMEOUT_MS = 15_000

/** 默认缓存 TTL（毫秒）。额度是低频数据，60 秒足够新。 */
export const DEFAULT_TTL_MS = 60_000

/**
 * 额度端点的路径（相对 {@link DEFAULT_BASE_ORIGIN}）。
 *
 * `current` 不需要 `X-Device-Mid`；`balance` / `preview` **必须**带（否则 400 `3001`）。
 */
export const QUOTA_ENDPOINTS = Object.freeze({
  current: '/api/v1/zcode-plan/billing/current',
  balance: '/api/v1/zcode-plan/billing/balance',
  preview: '/api/v1/zcode-plan/billing/preview',
})

/**
 * 已知的 `meter` 取值（实测非穷举）。
 *
 * - `model_usage`：模型 token 用量。这是**唯一**在客户端配置与渲染层计数逻辑里出现的值
 *   （`/api/v1/client/configs` 的 `startPlanPreview.entitlements[].meter`，以及渲染层
 *   `e.meter === 'model_usage'` 的额度条筛选）。
 *
 * 服务端是字符串透传，所以未知取值必须原样展示，不能因为不认识就丢掉整条 entitlement。
 */
export const KNOWN_METERS = Object.freeze(['model_usage'])

/**
 * 已知的 `unit_type` 取值（实测非穷举）。
 *
 * - `token`：计量单位是 token。客户端只对这一个值做本地化（`preview.unit.tokens` →
 *   `tokens` / `tokens`），其它值直接当标签显示。
 */
export const KNOWN_UNIT_TYPES = Object.freeze(['token'])

/**
 * 已知的 `period` 取值（实测非穷举）。
 *
 * - `daily`：按天重置。`/api/v1/client/configs` 的 `startPlanPreview` 实测就是 `daily`，
 *   客户端的文案键 `preview.period.daily`（`{unit}/日`、`{unit} per day`）也只覆盖了它。
 * - `one_time`：一次性额度（活动 / 赠送额度）。渲染层用它把耗尽提示切成
 *   「活动额度」而不是「套餐额度」（`quotaPeriod === 'one_time'`）。
 *
 * 注意：侧边栏用量条上的 `fiveHour` / `weekly` / `monthlyTool` / `mcp` 是**用量窗口标签**，
 * 来自另一条 bigmodel 监控接口，**不是** entitlement 的 `period`，不要把两者混为一谈。
 */
export const KNOWN_PERIODS = Object.freeze(['daily', 'one_time'])

/** `meter` 缺失时用于汇总分组的占位键，避免把 undefined 变成对象属性 `"undefined"`。 */
export const UNKNOWN_METER = 'unknown'

/**
 * 额度读取失败的错误码（稳定的机读值，调用方按 `code` 分流）。
 *
 * @typedef {'TOKEN_MISSING' | 'NETWORK' | 'TIMEOUT' | 'HTTP_STATUS' | 'INVALID_JSON' | 'API_CODE' | 'MISSING_DATA'} QuotaErrorCode
 */
export const QUOTA_ERROR_CODES = /** @type {const} */ ([
  'TOKEN_MISSING',
  'NETWORK',
  'TIMEOUT',
  'HTTP_STATUS',
  'INVALID_JSON',
  'API_CODE',
  'MISSING_DATA',
])

/**
 * 尽力而为的读取失败原因（{@link fetchBillingBalance} 等返回的 `reason`）。
 *
 * @typedef {'token_missing' | 'network' | 'timeout' | 'http_status' | 'invalid_json' | 'api_code' | 'missing_data'} QuotaFailureReason
 */

/**
 * 一条归一后的 entitlement。
 *
 * @typedef {object} NormalizedEntitlement
 * @property {string} id `entitlement_id`（已 trim；空 id 的条目不会出现在结果里）。
 * @property {string} showName `show_name`，给人看的名字（通常是模型名）。
 * @property {string} meter `meter`，计量口径（已知 `model_usage`，见 {@link KNOWN_METERS}）。
 * @property {string} unitType `unit_type`，计量单位（已知 `token`，见 {@link KNOWN_UNIT_TYPES}）。
 * @property {number} grantUnits `grant_units`，授予量（缺失记 0）。
 * @property {string} period `period`，重置周期（已知 `daily` / `one_time`，见 {@link KNOWN_PERIODS}）。
 * @property {string[]} capabilities `capabilities`，可用的模型/能力标识（已 trim 去空）。
 * @property {number} [effectiveAt] `effective_at`，Unix **秒**。
 */

/**
 * 一条归一后的 plan。
 *
 * `billing/current` 的 plan 形状是
 * `{ user_plan_id, plan_id, status, starts_at, ends_at, entitlements[{ entitlement_id, show_name, effective_at }] }`；
 * `billing/preview` 的 plan 多出 `name` / `description` / `priority`，entitlement 也更详细。
 * 两种都会归一成这个形状（缺失字段用空串 / 0 / undefined 填充）。
 *
 * `user_plan_id` 故意**不**归一进本结构：它只在 `claim` 之后才可能出现，而额度展示只需要
 * `plan_id`。需要它的人应该去 `lib/plan-client.js` / claim 流程里拿。
 *
 * @typedef {object} NormalizedPlan
 * @property {string} planId `plan_id`（已 trim）。
 * @property {string} name 套餐名（`current` 通常为空，`preview` 才有）。
 * @property {string} status `status`（`active` / `expired` / …；空串表示上游没给）。
 * @property {number} [startsAt] `starts_at`，Unix **秒**。
 * @property {number} [endsAt] `ends_at`，Unix **秒**。
 * @property {NormalizedEntitlement[]} entitlements 该 plan 的额度条目。
 */

/**
 * 归一后的额度余额（`billing/balance` 的 `data.balances[]`）。
 *
 * plan 说明"发了多少"，balance 说明"还剩多少" —— 判断能不能用必须看后者。
 *
 * @typedef {object} NormalizedBalance
 * @property {string} bucketId `bucket_id`（缺失的条目会被丢弃）。
 * @property {string} planId `plan_id`。
 * @property {string} entitlementId `entitlement_id`。
 * @property {string} showName `show_name`（通常就是模型名）。
 * @property {string} meter `meter`（如 `model_usage`）。
 * @property {string} unitType `unit_type`（如 `token`）。
 * @property {string[]} capabilities `capabilities`（如 `["model:glm-5.3-flash"]`）。
 * @property {number} [totalUnits] `total_units` 总授予量。
 * @property {number} [usedUnits] `used_units` 已用量。
 * @property {number} [remainingUnits] `remaining_units` 剩余量。
 * @property {number} [availableUnits] `available_units` 可用量。
 * @property {number} [expiresAt] `expires_at`，Unix **秒**。
 */

/**
 * {@link summarizeQuota} 的结果，供 UI 直接渲染。
 *
 * @typedef {object} QuotaSummary
 * @property {number} activePlans 有效 plan 数（无 `status` 视为有效；`expired` 不计）。
 * @property {number} totalEntitlements 有效 plan 下的 entitlement 条数。
 * @property {Record<string, { unitType: string, totalGranted: number, periods: string[] }>} byMeter
 *   按 `meter` 聚合：`unitType` 取该 meter 下第一个非空单位，`totalGranted` 是授予量之和，
 *   `periods` 是去重后的周期列表。
 */

/**
 * {@link fetchBillingCurrent} 的成功结果。
 *
 * @typedef {object} BillingCurrentResult
 * @property {number} [serverTime] 上游 `server_time`，Unix **秒**（缺失时不出现）。
 * @property {NormalizedPlan[]} plans 归一后的套餐列表；**空数组是合法结果**（本机无额度）。
 * @property {number | string | undefined} code 上游 `code`（成功时通常为 `0`）。
 * @property {string} message 上游 `msg`（已 trim）。
 * @property {string} [logid] 上游 `logid`，出问题时贴给客服的唯一凭据。
 */

/**
 * {@link fetchBillingPreview} 的成功结果。
 *
 * @typedef {object} BillingPreviewResult
 * @property {boolean} ok 恒为 `true`。
 * @property {number} status HTTP 状态码。
 * @property {number} [serverTime] 上游 `server_time`，Unix **秒**。
 * @property {NormalizedPlan[]} plans 归一后的可领取套餐列表。
 * @property {string} message 上游 `msg`。
 * @property {string} [logid] 上游 `logid`。
 * @property {string} body 原始响应体摘录（截断，仅诊断用）。
 */

/**
 * 尽力而为读取的失败结果（{@link fetchBillingBalance} / {@link fetchBillingPreview} 共用）。
 *
 * @typedef {object} QuotaFailure
 * @property {false} ok 恒为 `false`。
 * @property {QuotaFailureReason} reason 机读原因。
 * @property {number} status HTTP 状态（请求层失败为 0）。
 * @property {string} message 人类可读的失败描述（含上游文案）。
 * @property {number | string | undefined} code 上游业务码（若有）。
 * @property {string} [logid] 上游 `logid`。
 * @property {string} body 原始响应体摘录（截断，仅诊断用）。
 */

/**
 * {@link fetchBillingBalance} 的成功结果。`balances` 是**原始数组透传**：该端点参数形态
 * 仍未确定，所以在拿到真实响应前不对它做归一声明。
 *
 * @typedef {object} BillingBalanceResult
 * @property {true} ok 恒为 `true`。
 * @property {number} status HTTP 状态码。
 * @property {number} [serverTime] 上游 `server_time`，Unix **秒**。
 * @property {NormalizedPlan[]} plans 归一后的套餐列表。
 * @property {NormalizedBalance[]} balances 归一后的余额条目（"还剩多少"的权威来源）。
 * @property {number | string | undefined} code 上游 `code`。
 * @property {string} message 上游 `msg`。
 * @property {string} [logid] 上游 `logid`。
 */

/**
 * 请求层结果（内部结构，不导出）。
 *
 * @typedef {object} EnvelopeExchange
 * @property {number} status HTTP 状态码。
 * @property {boolean} httpOk 是否 2xx。
 * @property {Record<string, unknown> | undefined} envelope 解析出的 JSON 信封（含 code/msg/data/logid）。
 * @property {string} text 原始响应体。
 * @property {QuotaError} [failure] 请求层失败（网络 / 超时 / 非 JSON）。
 */

/** 额度读取失败（业务层可读的错误，带机读 `code`）。 */
export class QuotaError extends Error {
  /**
   * @param {string} message 人类可读的失败描述。
   * @param {QuotaErrorCode} code 稳定的机读错误码。
   * @param {{ status?: number, body?: string, upstreamCode?: number | string, logid?: string }} [details] 诊断细节。
   */
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'QuotaError'
    this.code = code
    /** @type {number | undefined} HTTP 状态码（请求层失败时为 undefined）。 */
    this.status = details.status
    /** @type {string | undefined} 原始响应体摘录（截断）。 */
    this.body = details.body
    /** @type {number | string | undefined} 上游业务码。 */
    this.upstreamCode = details.upstreamCode
    /** @type {string | undefined} 上游 `logid`。 */
    this.logid = details.logid
  }
}

// ------------------------------------------------------------------ 小工具

/** 诊断用 body 摘录长度上限。 */
const BODY_EXCERPT_LIMIT = 500

/**
 * 默认的同步读文件实现（延迟 require，避免模块顶层引入 `node:fs`）。
 *
 * @param {string} filePath 文件路径。
 * @returns {string} 文件内容。
 */
function defaultReadFile(filePath) {
  // 用 createRequire 而不是顶层 import：本模块的核心（归一 / 汇总 / 缓存）不该因为
  // 一个可选的 deviceMid 读取而在非 Node 环境（浏览器打包）里直接加载失败。
  const require = createRequire(import.meta.url)
  return /** @type {string} */ (require('node:fs').readFileSync(filePath, 'utf8'))
}

/**
 * 把任意值收敛成对象（数组与 null 视为空对象）。
 *
 * @param {unknown} value 待收敛的值。
 * @returns {Record<string, unknown>} 对象视图。
 */
function asRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * 保留「真的是对象」的 JSON 值，其余返回 undefined。
 *
 * @param {unknown} value 已 `JSON.parse` 的值。
 * @returns {Record<string, unknown> | undefined} 信封对象，或 undefined。
 */
function readEnvelope(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * 读字符串字段并 trim（非字符串返回空串）。
 *
 * @param {unknown} value 原始值。
 * @returns {string} trim 后的文本。
 */
function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 容忍式数字解析：接受有限数字与纯数字字符串，其它返回 undefined。
 *
 * @param {unknown} value 原始值。
 * @returns {number | undefined} 解析出的数字。
 */
function readFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 读字符串数组：过滤非字符串、trim、去空、去重（保序）。
 *
 * @param {unknown} value 原始值。
 * @returns {string[]} 清洗后的字符串数组。
 */
function readStringArray(value) {
  if (!Array.isArray(value)) return []
  /** @type {string[]} */
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

/**
 * 截断响应体，避免诊断日志被整页 HTML 撑爆。
 *
 * @param {string} text 原始响应体。
 * @returns {string} 摘录。
 */
function snippet(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > BODY_EXCERPT_LIMIT ? `${collapsed.slice(0, BODY_EXCERPT_LIMIT)}…` : collapsed
}

/**
 * 把任意异常收敛成一行可读文本。
 *
 * @param {unknown} error 异常值。
 * @returns {string} 描述。
 */
function describeError(error) {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  return String(error)
}

/**
 * 判断是否「被 abort」（超时或被调用方取消）。取消与超时都归到 TIMEOUT，理由见
 * {@link fetchBillingCurrent} 的 JSDoc：对额度读取而言，两者都只需重试，不需要分流。
 *
 * @param {unknown} error 异常值。
 * @returns {boolean} 是否 abort 形状。
 */
function isAbortError(error) {
  if (typeof error !== 'object' || error === null) return false
  const name = /** @type {{ name?: unknown }} */ (error).name
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * 合并调用方 signal 与超时 signal。
 *
 * @param {AbortSignal | undefined} signal 调用方取消信号。
 * @param {number} timeoutMs 超时毫秒。
 * @returns {AbortSignal} 合并后的信号。
 */
function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  return AbortSignal.any([signal, timeout])
}

// ------------------------------------------------------------------ 常量与 URL

/**
 * 客户端平台键（`${platform}-${arch}`）。
 *
 * 注意：客户端传的是 `win32-x64` 这种**带架构**的形态（`tM()`），不是 `win32`。
 * 实测两种都进不了 `balance`（都 400），所以这里只是保持与客户端一致。
 *
 * @param {string} [platformName] 平台名，默认 `process.platform`。
 * @param {string} [arch] 架构，默认 `process.arch`。
 * @returns {string} 平台键。
 */
export function defaultPlatformKey(platformName = process.platform, arch = process.arch) {
  return `${platformName}-${arch}`
}

/**
 * 构造额度端点 URL。
 *
 * `baseOrigin` 只接受 origin（`scheme://host[:port]`），不支持带路径前缀的反代；
 * 空串的 query 值会被丢弃（避免发出 `?plan_id=` 这种形态）。
 *
 * @param {string} endpoint {@link QUOTA_ENDPOINTS} 里的路径。
 * @param {object} [options] 参数。
 * @param {string} [options.baseOrigin] origin，默认 {@link DEFAULT_BASE_ORIGIN}。
 * @param {Record<string, string | number | undefined | null>} [options.query] 追加的 query 参数。
 * @returns {string} 绝对 URL。
 */
export function buildQuotaUrl(endpoint, options = {}) {
  const origin = (options.baseOrigin ?? DEFAULT_BASE_ORIGIN).trim().replace(/\/+$/, '')
  const url = new URL(endpoint, `${origin}/`)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null) continue
    const text = String(value)
    if (text === '') continue
    url.searchParams.set(key, text)
  }
  return url.toString()
}

/**
 * 构造额度读取请求头。
 *
 * 三类头：
 * 1. `accept` / `Authorization: Bearer <zcodejwttoken>`
 * 2. 客户端那对 `X-ZCode-App-Version` / `X-Platform`（与客户端行为对齐）
 * 3. **`X-Device-Mid`** —— `billing/balance` 与 `billing/preview` 的**必需头**。
 *    不带它固定 `400 {"code":3001,"msg":"parameter error"}`；带上任意合法 UUID 就 200。
 *    详见 `docs/quota-api.md` 的「400 之谜」一节（2026-10-27 实测，含控制变量实验）。
 *
 * 客户端 `claimManualPlan` 里还有一个 `...BL(t)`，经 asar 反查 `BL` = `Uc` =
 * `requestVerificationClaimHeaders`，展开是 `X-Aliyun-Captcha-Verify-Param` /
 * `X-Aliyun-Captcha-Verify-Region` —— 只在触发阿里云验证码挑战时才需要，额度读取用不到。
 *
 * @param {object} [options] 参数。
 * @param {string} [options.jwt] `zcodejwttoken`。
 * @param {string} [options.appVersion] 客户端版本，默认 {@link DEFAULT_APP_VERSION}。
 * @param {string} [options.platform] 平台键，默认 {@link defaultPlatformKey}。
 * @param {string} [options.deviceMid] 设备标识（UUID）。缺省时**不发送该头**（调用方可用
 *   {@link readDeviceMid} 从客户端数据目录取真实值；测试里也靠这个缺省来断言「不发送」）。
 * @returns {Record<string, string>} 请求头。
 */
export function buildQuotaHeaders(options = {}) {
  const jwt = (options.jwt ?? '').trim()
  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json' }
  if (jwt !== '') headers.authorization = `Bearer ${jwt}`
  headers['X-ZCode-App-Version'] = options.appVersion ?? DEFAULT_APP_VERSION
  headers['X-Platform'] = options.platform ?? defaultPlatformKey()
  const deviceMid = (options.deviceMid ?? '').trim()
  if (deviceMid !== '') headers['X-Device-Mid'] = deviceMid
  return headers
}

/**
 * 从 ZCode 客户端数据目录读 `deviceMid`（`telemetry-state.json`）。
 *
 * `billing/balance` / `billing/preview` 必须带 `X-Device-Mid`，而这个值由客户端自己生成
 * 并落在 `<dataBaseDir>/.zcode/v2/telemetry-state.json` 的 `deviceMid` 字段里。
 * 本函数**只读**该文件；读不到就返回 `undefined`（调用方按「没有该头」处理，此时
 * `current` 仍可用，`balance` / `preview` 会拿到 400）。
 *
 * 之所以不在本模块里自己造一个随机 UUID：上游只校验「是不是 UUID 形状」，随机值也能过
 * （已实测），但用客户端的真值更贴近真实设备、也便于与客户端日志对账。
 *
 * @param {object} [options] 参数。
 * @param {string} options.dataBaseDir ZCode 数据根（含 `.zcode` 目录），例如 `D:\\AI\\zcode`。
 * @param {(filePath: string) => string} [options.readFileImpl] 读文件实现（测试注入点）。
 * @returns {string | undefined} deviceMid（UUID 字符串），读不到时 undefined。
 */
export function readDeviceMid(options) {
  const baseDir = typeof options?.dataBaseDir === 'string' ? options.dataBaseDir.trim() : ''
  if (baseDir === '') return undefined
  const readFileImpl = options?.readFileImpl ?? defaultReadFile
  // 用 path.join 而不是手拼 `/`：Windows 上 `fs.readFileSync` 虽然两种分隔符都收，
  // 但调用方（和测试）看到的路径应当与平台一致，否则日志里的路径会对不上。
  const filePath = joinPath(baseDir.replace(/[\\/]+$/, ''), '.zcode', 'v2', 'telemetry-state.json')
  let raw
  try {
    raw = readFileImpl(filePath)
  } catch {
    return undefined
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const value = /** @type {{ deviceMid?: unknown }} */ (parsed).deviceMid
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

// ------------------------------------------------------------------ 归一

/**
 * 归一单条 entitlement。空 `entitlement_id` 返回 undefined（客户端同样会丢弃这类条目）。
 *
 * @param {unknown} raw 上游原始 entitlement。
 * @returns {NormalizedEntitlement | undefined} 归一结果。
 */
export function normalizeEntitlement(raw) {
  const record = asRecord(raw)
  const id = readText(record.entitlement_id)
  if (id === '') return undefined
  /** @type {NormalizedEntitlement} */
  const entitlement = {
    id,
    showName: readText(record.show_name),
    meter: readText(record.meter),
    unitType: readText(record.unit_type),
    grantUnits: readFiniteNumber(record.grant_units) ?? 0,
    period: readText(record.period),
    capabilities: readStringArray(record.capabilities),
  }
  const effectiveAt = readFiniteNumber(record.effective_at)
  if (effectiveAt !== undefined) entitlement.effectiveAt = effectiveAt
  return entitlement
}

/**
 * 归一单条 balance（`billing/balance` 的 `data.balances[]`）。
 *
 * 与 plan 的关系：plan 的 `entitlements[].grant_units` 是"一共发了多少"，balance 的
 * `total_units` / `used_units` / `remaining_units` 才是"还剩多少"。额度是否可用看的是
 * balance，所以这两者必须分开读。
 *
 * 实测形状（2026-10-30，真实 Start Plan 到账后）：
 *
 * ```
 * {"bucket_id":"bucket_…","plan_id":"zcode-v3-start-plan-1030-wk",
 *  "entitlement_id":"ent-…-1","show_name":"GLM-5.3-Flash","meter":"model_usage",
 *  "unit_type":"token","capabilities":["model:glm-5.3-flash"],
 *  "total_units":500000000,"used_units":244566,"remaining_units":499755434,
 *  "available_units":499755434,"expires_at":1793581200}
 * ```
 *
 * @param {unknown} raw 上游原始 balance。
 * @returns {NormalizedBalance | undefined} 归一结果；`bucket_id` 缺失时 undefined。
 */
export function normalizeBalance(raw) {
  const record = asRecord(raw)
  const bucketId = readText(record.bucket_id)
  if (bucketId === '') return undefined
  /** @type {NormalizedBalance} */
  const balance = {
    bucketId,
    planId: readText(record.plan_id),
    entitlementId: readText(record.entitlement_id),
    showName: readText(record.show_name),
    meter: readText(record.meter),
    unitType: readText(record.unit_type),
    capabilities: readStringArray(record.capabilities),
  }
  const totalUnits = readFiniteNumber(record.total_units)
  const usedUnits = readFiniteNumber(record.used_units)
  const remainingUnits = readFiniteNumber(record.remaining_units)
  const availableUnits = readFiniteNumber(record.available_units)
  const expiresAt = readFiniteNumber(record.expires_at)
  if (totalUnits !== undefined) balance.totalUnits = totalUnits
  if (usedUnits !== undefined) balance.usedUnits = usedUnits
  if (remainingUnits !== undefined) balance.remainingUnits = remainingUnits
  if (availableUnits !== undefined) balance.availableUnits = availableUnits
  if (expiresAt !== undefined) balance.expiresAt = expiresAt
  return balance
}

/**
 * 批量归一 balances（丢弃 `bucket_id` 缺失的条目）。
 *
 * @param {unknown} rawBalances 上游 `data.balances`。
 * @returns {NormalizedBalance[]} 归一结果。
 */
export function normalizeBalances(rawBalances) {
  if (!Array.isArray(rawBalances)) return []
  /** @type {NormalizedBalance[]} */
  const out = []
  for (const item of rawBalances) {
    const balance = normalizeBalance(item)
    if (balance !== undefined) out.push(balance)
  }
  return out
}

/**
 * 归一单条 plan。
 *
 * `plan_id` 缺失时返回的 `planId` 是空串 —— 单条归一不做丢弃决策，批量归一
 * （{@link normalizePlans}）才按客户端行为丢弃无名 plan。
 *
 * @param {unknown} raw 上游原始 plan。
 * @returns {NormalizedPlan} 归一结果。
 */
export function normalizePlan(raw) {
  const record = asRecord(raw)
  const rawEntitlements = Array.isArray(record.entitlements) ? record.entitlements : []
  /** @type {NormalizedEntitlement[]} */
  const entitlements = []
  for (const item of rawEntitlements) {
    const entitlement = normalizeEntitlement(item)
    if (entitlement !== undefined) entitlements.push(entitlement)
  }
  /** @type {NormalizedPlan} */
  const plan = {
    planId: readText(record.plan_id),
    name: readText(record.name),
    status: readText(record.status),
    entitlements,
  }
  const startsAt = readFiniteNumber(record.starts_at)
  const endsAt = readFiniteNumber(record.ends_at)
  if (startsAt !== undefined) plan.startsAt = startsAt
  if (endsAt !== undefined) plan.endsAt = endsAt
  return plan
}

/**
 * 批量归一，并按客户端行为丢弃 `plan_id` 为空、`entitlements` 全被过滤掉的空壳 plan。
 *
 * 注意：**保留** `entitlements` 为空的 plan 与 `plans: []` 的空列表 —— 前者可能是
 * 上游阶段性数据（plan 存在但额度还没发放），后者在本机上就是正确答案。
 *
 * @param {unknown[] | unknown} rawPlans 上游 `data.plans`。
 * @returns {NormalizedPlan[]} 归一后的 plan 列表。
 */
export function normalizePlans(rawPlans) {
  if (!Array.isArray(rawPlans)) return []
  /** @type {NormalizedPlan[]} */
  const out = []
  for (const item of rawPlans) {
    const plan = normalizePlan(item)
    if (plan.planId === '') continue
    out.push(plan)
  }
  return out
}

/**
 * 从 entitlement 的 `capabilities` 里取出模型 id。
 *
 * 客户端的两条真实实现（`eY` / `resolveZaiStartPlanBalanceModelIds`）都是
 * **只认 `model:` 前缀**：把 `model:GLM-5.3` 剥成 `GLM-5.3`，非 `model:` 的条目
 * （例如 `other`）一律丢弃；只有在**一条 `model:` 都没有**时才退回 `show_name`。
 * 这里照抄该语义，但把「退回 show_name」留给调用方（本函数只处理 capabilities），
 * 于是退回行为是「退回裸字符串条目」——这样既能满足 `balance` 的实测形状
 * （`["model:GLM-5.3"]` → `["GLM-5.3"]`），也不至于让只给裸模型名的 `preview`
 * 变体整条丢失。
 *
 * 前缀匹配大小写不敏感，id 本身保持原大小写。
 *
 * @param {NormalizedEntitlement} entitlement 归一后的 entitlement。
 * @returns {string[]} 模型 id 列表（去重，保序）。
 */
export function capabilityModelIds(entitlement) {
  const capabilities = entitlement.capabilities ?? []
  /** @type {string[]} */
  const prefixed = []
  /** @type {string[]} */
  const bare = []
  for (const capability of capabilities) {
    if (typeof capability !== 'string') continue
    const trimmed = capability.trim()
    if (trimmed === '') continue
    if (trimmed.toLowerCase().startsWith('model:')) {
      const id = trimmed.slice('model:'.length).trim()
      if (id !== '' && !prefixed.includes(id)) prefixed.push(id)
      continue
    }
    if (!bare.includes(trimmed)) bare.push(trimmed)
  }
  // 有 `model:` 条目时它是权威来源；一条都没有才退回裸条目（兼容 preview 的裸模型名变体）。
  return prefixed.length > 0 ? prefixed : bare
}

// ------------------------------------------------------------------ 汇总

/**
 * 判断 plan 是否有效：`status` 为空视为有效（`preview` 不给 status），`expired` 之类的明确
 * 状态不计。
 *
 * @param {NormalizedPlan} plan 归一后的 plan。
 * @returns {boolean} 是否有效。
 */
function isActivePlan(plan) {
  const status = plan.status.trim().toLowerCase()
  return status === '' || status === 'active'
}

/**
 * 把归一后的 plan 列表汇总成 UI 可直接渲染的形态。
 *
 * ```
 * summarizeQuota([])
 * → { activePlans: 0, totalEntitlements: 0, byMeter: {} }
 * ```
 *
 * 这是本机（无额度）的**正常**结果，不是错误。
 *
 * @param {NormalizedPlan[] | unknown} plans 归一后的 plan 列表（{@link normalizePlans} 的结果）。
 * @returns {QuotaSummary} 汇总结果。
 */
export function summarizeQuota(plans) {
  const list = Array.isArray(plans) ? plans : []
  let activePlans = 0
  let totalEntitlements = 0
  /** @type {Record<string, { unitType: string, totalGranted: number, periods: string[] }>} */
  const byMeter = {}
  for (const plan of list) {
    if (!isActivePlan(plan)) continue
    activePlans += 1
    for (const entitlement of plan.entitlements) {
      totalEntitlements += 1
      const meter = entitlement.meter === '' ? UNKNOWN_METER : entitlement.meter
      const bucket = byMeter[meter] ?? { unitType: '', totalGranted: 0, periods: [] }
      if (bucket.unitType === '' && entitlement.unitType !== '') bucket.unitType = entitlement.unitType
      bucket.totalGranted += entitlement.grantUnits
      if (entitlement.period !== '' && !bucket.periods.includes(entitlement.period)) {
        bucket.periods.push(entitlement.period)
      }
      byMeter[meter] = bucket
    }
  }
  return { activePlans, totalEntitlements, byMeter }
}

// ------------------------------------------------------------------ 信封读取

/**
 * 读上游业务码（`code`），数字与纯数字字符串都收敛成数字。
 *
 * @param {Record<string, unknown> | undefined} envelope 上游信封。
 * @returns {number | string | undefined} 业务码。
 */
function readApiCode(envelope) {
  if (envelope === undefined) return undefined
  const value = envelope.code
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return typeof value === 'string' ? value : undefined
}

/**
 * 上游是否把这次响应当成功（`code` 缺失、`0`、`'0'` 都算成功）。
 *
 * @param {number | string | undefined} code 业务码。
 * @returns {boolean} 是否成功。
 */
function isSuccessCode(code) {
  return code === undefined || code === 0 || code === '0'
}

/**
 * 读上游 `msg`。
 *
 * @param {Record<string, unknown> | undefined} envelope 上游信封。
 * @returns {string} 文案（空串表示上游没给）。
 */
function readApiMessage(envelope) {
  return envelope === undefined ? '' : readText(envelope.msg)
}

/**
 * 读上游 `logid`。
 *
 * @param {Record<string, unknown> | undefined} envelope 上游信封。
 * @returns {string | undefined} logid。
 */
function readLogid(envelope) {
  const logid = envelope === undefined ? '' : readText(envelope.logid)
  return logid === '' ? undefined : logid
}

/**
 * 读上游 `data`（只接受对象）。
 *
 * @param {Record<string, unknown> | undefined} envelope 上游信封。
 * @returns {Record<string, unknown> | undefined} data 对象。
 */
function readData(envelope) {
  return envelope === undefined ? undefined : readEnvelope(envelope.data)
}

/**
 * 发一次 GET 并把响应体解析成信封。**不抛异常**：所有失败都装进返回值的 `failure`。
 *
 * @param {string} url 绝对 URL。
 * @param {object} options 请求参数。
 * @param {string} options.jwt `zcodejwttoken`。
 * @param {typeof globalThis.fetch} options.fetchImpl fetch 实现（测试注入点）。
 * @param {AbortSignal | undefined} options.signal 取消信号。
 * @param {number} options.timeoutMs 超时毫秒。
 * @param {string} options.appVersion 客户端版本。
 * @param {string} options.platform 平台键。
 * @param {string | undefined} options.deviceMid 设备标识（`X-Device-Mid`；`balance`/`preview` 必需）。
 * @returns {Promise<EnvelopeExchange>} 请求结果。
 */
async function requestQuotaEnvelope(url, options) {
  /** @type {Response} */
  let response
  try {
    response = await options.fetchImpl(url, {
      method: 'GET',
      headers: buildQuotaHeaders({
        jwt: options.jwt,
        appVersion: options.appVersion,
        platform: options.platform,
        deviceMid: options.deviceMid,
      }),
      signal: combineSignals(options.signal, options.timeoutMs),
    })
  } catch (error) {
    return {
      status: 0,
      httpOk: false,
      envelope: undefined,
      text: '',
      failure: new QuotaError(
        `额度请求失败：${describeError(error)}`,
        isAbortError(error) ? 'TIMEOUT' : 'NETWORK',
      ),
    }
  }

  /** @type {string} */
  let text
  try {
    text = await response.text()
  } catch (error) {
    return {
      status: response.status,
      httpOk: false,
      envelope: undefined,
      text: '',
      failure: new QuotaError(`响应体读取失败：${describeError(error)}`, 'NETWORK', { status: response.status }),
    }
  }

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // 空 body 的非 2xx 是**鉴权失败**的实测形态（未登录 / 用错凭证 → `401` + 空 body），
    // 不是「返回了非 JSON」。两者对调用方的含义完全不同（要重新登录 vs 上游异常），
    // 所以这里必须先分流，否则最常见的「没登录」会被误报成协议漂移。
    if (!response.ok && text.trim() === '') {
      return {
        status: response.status,
        httpOk: false,
        envelope: undefined,
        text,
        failure: new QuotaError(`上游返回 HTTP ${response.status}（空响应体）`, 'HTTP_STATUS', {
          status: response.status,
        }),
      }
    }
    return {
      status: response.status,
      httpOk: response.ok,
      envelope: undefined,
      text,
      failure: new QuotaError(
        `上游返回非 JSON 响应（HTTP ${response.status}）：${snippet(text)}`,
        'INVALID_JSON',
        { status: response.status, body: snippet(text) },
      ),
    }
  }

  return { status: response.status, httpOk: response.ok, envelope: readEnvelope(parsed), text }
}

/**
 * 把异常映射成尽力而为接口的 `reason`。
 *
 * @param {unknown} error 异常值。
 * @returns {QuotaFailureReason} 机读原因。
 */
function failureReason(error) {
  if (!(error instanceof QuotaError)) return 'network'
  switch (error.code) {
    case 'TIMEOUT': return 'timeout'
    case 'INVALID_JSON': return 'invalid_json'
    case 'HTTP_STATUS': return 'http_status'
    case 'API_CODE': return 'api_code'
    case 'MISSING_DATA': return 'missing_data'
    case 'TOKEN_MISSING': return 'token_missing'
    default: return 'network'
  }
}

/**
 * 校验并 trim token。
 *
 * @param {unknown} jwt 凭证。
 * @returns {string} trim 后的 token。
 * @throws {QuotaError} token 为空时抛出（code `TOKEN_MISSING`）。
 */
function requireToken(jwt) {
  const token = typeof jwt === 'string' ? jwt.trim() : ''
  if (token !== '') return token
  throw new QuotaError(
    '缺少 zcodejwttoken（ZCode 客户端未登录？读不到共享凭证就无法查额度）',
    'TOKEN_MISSING',
  )
}

// ------------------------------------------------------------------ 公共 API

/**
 * 读取当前账号的套餐列表（**主路径**，唯一已验证可用的额度端点）。
 *
 * 成功语义：
 * - `plans: []` —— 账号没有可用套餐额度（本机现状，**不是**错误）。
 * - `plans: [{ planId, status: 'active', entitlements: [...] }]` —— 有额度。
 *
 * 失败语义（抛 {@link QuotaError}）：
 * - `TOKEN_MISSING`：token 为空。
 * - `NETWORK` / `TIMEOUT`：连不上 / 超时 / 被取消。
 * - `HTTP_STATUS`：非 2xx 且无可解析业务码（实测未鉴权是 `401` + 空 body）。
 * - `API_CODE`：上游用 200/4xx 携带业务错误码（`code !== 0`）。
 * - `INVALID_JSON`：响应不是 JSON（例如 WAF 的 HTML 拦截页）。
 * - `MISSING_DATA`：信封里没有 `data`。
 *
 * @param {object} [options] 参数。
 * @param {string} [options.jwt] `zcodejwttoken`（必填）。
 * @param {AbortSignal} [options.signal] 取消信号。
 * @param {string} [options.baseOrigin] origin 覆盖（测试 / 反代），默认 {@link DEFAULT_BASE_ORIGIN}。
 * @param {Record<string, string | number | undefined | null>} [options.query] 额外 query。
 * @param {typeof globalThis.fetch} [options.fetchImpl] fetch 实现（测试注入点）。
 * @param {string} [options.appVersion] 客户端版本，默认 {@link DEFAULT_APP_VERSION}。
 * @param {string} [options.platform] 平台键，默认 {@link defaultPlatformKey}。
 * @param {string} [options.deviceMid] 设备标识（`X-Device-Mid`）。可用 {@link readDeviceMid} 取。
 * @param {number} [options.timeoutMs] 超时毫秒，默认 {@link DEFAULT_TIMEOUT_MS}。
 * @returns {Promise<BillingCurrentResult>} 归一后的套餐列表。
 * @throws {QuotaError} 见上。
 */
export async function fetchBillingCurrent(options = {}) {
  const jwt = requireToken(options.jwt)
  const url = buildQuotaUrl(QUOTA_ENDPOINTS.current, {
    baseOrigin: options.baseOrigin,
    query: { app_version: options.appVersion ?? DEFAULT_APP_VERSION, platform: options.platform ?? defaultPlatformKey(), ...(options.query ?? {}) },
  })
  const exchange = await requestQuotaEnvelope(url, {
    jwt,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    appVersion: options.appVersion ?? DEFAULT_APP_VERSION,
    platform: options.platform ?? defaultPlatformKey(),
    deviceMid: options.deviceMid,
  })
  if (exchange.failure !== undefined) throw exchange.failure

  const code = readApiCode(exchange.envelope)
  const message = readApiMessage(exchange.envelope)
  const logid = readLogid(exchange.envelope)
  if (!isSuccessCode(code)) {
    throw new QuotaError(
      `上游返回业务错误码 ${String(code)}${message === '' ? '' : `：${message}`}`,
      'API_CODE',
      { status: exchange.status, upstreamCode: code, logid, body: snippet(exchange.text) },
    )
  }
  if (!exchange.httpOk) {
    throw new QuotaError(
      `上游返回 HTTP ${exchange.status}${message === '' ? '' : `：${message}`}`,
      'HTTP_STATUS',
      { status: exchange.status, logid, body: snippet(exchange.text) },
    )
  }
  const data = readData(exchange.envelope)
  if (data === undefined) {
    throw new QuotaError('上游响应缺少 data 字段', 'MISSING_DATA', {
      status: exchange.status,
      logid,
      body: snippet(exchange.text),
    })
  }

  /** @type {BillingCurrentResult} */
  const result = {
    plans: normalizePlans(data.plans),
    code,
    message,
  }
  const serverTime = readFiniteNumber(data.server_time)
  if (serverTime !== undefined) result.serverTime = serverTime
  if (logid !== undefined) result.logid = logid
  return result
}

/**
 * {@link fetchBillingBalance} / {@link fetchBillingPreview} 的公共参数。
 *
 * @typedef {object} QuotaFetchOptions
 * @property {string} [jwt] `zcodejwttoken`。
 * @property {AbortSignal} [signal] 取消信号。
 * @property {string} [baseOrigin] origin 覆盖。
 * @property {Record<string, string | number | undefined | null>} [query] 额外 query（会与 `app_version` / `platform` 合并）。
 * @property {typeof globalThis.fetch} [fetchImpl] fetch 实现（测试注入点）。
 * @property {string} [appVersion] 客户端版本。
 * @property {string} [platform] 平台键。
 * @property {string} [deviceMid] 设备标识（`X-Device-Mid`；`balance`/`preview` 必需）。
 * @property {number} [timeoutMs] 超时毫秒。
 */

/**
 * 尽力而为地读取额度余额（`billing/balance`）。**永不抛异常**。
 *
 * 调用条件（2026-10-27 实测，见 `docs/quota-api.md`）：除了 `Authorization: Bearer <jwt>`
 * 还必须带 **`X-Device-Mid: <UUID>`**。不带该头固定 `400 {"code":3001,"msg":"parameter error"}`；
 * 带上任意合法 UUID（不必是客户端真值）就 `200`。所以调用方应先
 * {@link readDeviceMid} 取真值，取不到时**本端点必然失败**，但 `current` 不受影响。
 *
 * @param {QuotaFetchOptions} [options] 参数。
 * @returns {Promise<BillingBalanceResult | QuotaFailure>} 成功或失败结果。
 */
export async function fetchBillingBalance(options = {}) {
  const token = typeof options.jwt === 'string' ? options.jwt.trim() : ''
  if (token === '') {
    return {
      ok: false,
      reason: 'token_missing',
      status: 0,
      message: '缺少 zcodejwttoken（ZCode 客户端未登录？）',
      code: undefined,
      body: '',
    }
  }
  const url = buildQuotaUrl(QUOTA_ENDPOINTS.balance, {
    baseOrigin: options.baseOrigin,
    query: {
      app_version: options.appVersion ?? DEFAULT_APP_VERSION,
      platform: options.platform ?? defaultPlatformKey(),
      ...(options.query ?? {}),
    },
  })
  const exchange = await requestQuotaEnvelope(url, {
    jwt: token,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    appVersion: options.appVersion ?? DEFAULT_APP_VERSION,
    platform: options.platform ?? defaultPlatformKey(),
    deviceMid: options.deviceMid,
  })
  return unwrapBestEffort(exchange)
}

/**
 * 尽力而为地读取「可领取套餐预览」（`billing/preview`）。**永不抛异常**。
 *
 * 与 {@link fetchBillingBalance} 一样，**必须带 `X-Device-Mid`** 才不是 400
 * （2026-10-27 实测，同一套控制变量实验）。它的响应比 `current` 更详细
 * （含 `meter` / `unit_type` / `grant_units` / `period`），是本模块归一逻辑的主要设计依据。
 *
 * @param {QuotaFetchOptions} [options] 参数（同 {@link fetchBillingBalance}）。
 * @returns {Promise<BillingPreviewResult | QuotaFailure>} 成功或失败结果。
 */
export async function fetchBillingPreview(options = {}) {
  const token = typeof options.jwt === 'string' ? options.jwt.trim() : ''
  if (token === '') {
    return {
      ok: false,
      reason: 'token_missing',
      status: 0,
      message: '缺少 zcodejwttoken（ZCode 客户端未登录？）',
      code: undefined,
      body: '',
    }
  }
  const url = buildQuotaUrl(QUOTA_ENDPOINTS.preview, {
    baseOrigin: options.baseOrigin,
    query: {
      app_version: options.appVersion ?? DEFAULT_APP_VERSION,
      platform: options.platform ?? defaultPlatformKey(),
      ...(options.query ?? {}),
    },
  })
  const exchange = await requestQuotaEnvelope(url, {
    jwt: token,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    appVersion: options.appVersion ?? DEFAULT_APP_VERSION,
    platform: options.platform ?? defaultPlatformKey(),
    deviceMid: options.deviceMid,
  })
  return unwrapBestEffort(exchange)
}

/**
 * {@link unwrapBestEffort} 的成功结果：`balance` 与 `preview` 两个成功形状的**并集**。
 *
 * 两个端点共用同一段摊平逻辑，所以这里一次性给全（`balances` 与 `body` 都在）。多出来的
 * 字段不影响结构化赋值：`balance` 忽略 `body`，`preview` 忽略 `balances`。
 *
 * @typedef {object} BestEffortSuccess
 * @property {true} ok
 * @property {number} status
 * @property {number} [serverTime]
 * @property {NormalizedPlan[]} plans
 * @property {NormalizedBalance[]} balances
 * @property {number | string | undefined} code
 * @property {string} message
 * @property {string} [logid]
 * @property {string} body
 */

/**
 * 把请求层结果摊平成「成功结果 / 失败结果」二选一（供两个尽力而为的端点共用）。
 *
 * @param {EnvelopeExchange} exchange 请求层结果。
 * @returns {BestEffortSuccess | QuotaFailure} 摊平后的结果。
 */
function unwrapBestEffort(exchange) {
  if (exchange.failure !== undefined) {
    return {
      ok: false,
      reason: failureReason(exchange.failure),
      status: exchange.status,
      message: exchange.failure.message,
      code: undefined,
      body: '',
    }
  }
  const code = readApiCode(exchange.envelope)
  const message = readApiMessage(exchange.envelope)
  const logid = readLogid(exchange.envelope)
  if (!isSuccessCode(code)) {
    return {
      ok: false,
      reason: 'api_code',
      status: exchange.status,
      message: message === '' ? `上游返回业务错误码 ${String(code)}` : message,
      code,
      body: snippet(exchange.text),
      ...(logid === undefined ? {} : { logid }),
    }
  }
  if (!exchange.httpOk) {
    return {
      ok: false,
      reason: 'http_status',
      status: exchange.status,
      message: message === '' ? `上游返回 HTTP ${exchange.status}` : message,
      code,
      body: snippet(exchange.text),
      ...(logid === undefined ? {} : { logid }),
    }
  }
  const data = readData(exchange.envelope)
  if (data === undefined) {
    return {
      ok: false,
      reason: 'missing_data',
      status: exchange.status,
      message: '上游响应缺少 data 字段',
      code,
      body: snippet(exchange.text),
      ...(logid === undefined ? {} : { logid }),
    }
  }
  const balances = normalizeBalances(data.balances)
  return {
    ok: true,
    status: exchange.status,
    plans: normalizePlans(data.plans),
    balances,
    code,
    message,
    body: snippet(exchange.text),
    ...(readFiniteNumber(data.server_time) === undefined ? {} : { serverTime: /** @type {number} */ (readFiniteNumber(data.server_time)) }),
    ...(logid === undefined ? {} : { logid }),
  }
}

// ------------------------------------------------------------------ 缓存

/**
 * 一条缓存快照。
 *
 * @typedef {object} QuotaCacheEntry
 * @property {string} key 该快照对应的 token（换 token 视为换账号，直接失效）。
 * @property {number} fetchedAt 拉取时刻（`now()` 口径，毫秒）。
 * @property {number} expiresAt 过期时刻（`fetchedAt + ttlMs`）。
 * @property {number} [serverTime] 上游 `server_time`（Unix 秒）。
 * @property {NormalizedPlan[]} plans 归一后的 plan 列表。
 * @property {QuotaSummary} summary 汇总结果。
 */

/**
 * {@link QuotaCache.get} 的成功结果。
 *
 * @typedef {object} QuotaCacheHit
 * @property {true} ok 恒为 `true`。
 * @property {boolean} fromCache 是否直接命中缓存（`false` = 本次真的发了请求）。
 * @property {number} fetchedAt 该快照的拉取时刻（毫秒）。
 * @property {number} [serverTime] 上游 `server_time`（Unix 秒）。
 * @property {NormalizedPlan[]} plans 归一后的 plan 列表。
 * @property {QuotaSummary} summary 汇总结果。
 */

/**
 * {@link QuotaCache.get} 的失败结果。**不会**写坏缓存：失败时缓存内容原样保留。
 *
 * @typedef {object} QuotaCacheMiss
 * @property {false} ok 恒为 `false`。
 * @property {QuotaFailureReason} reason 机读原因。
 * @property {string} message 人类可读描述。
 * @property {number} [status] HTTP 状态（若有）。
 * @property {number | string} [upstreamCode] 上游业务码（若有）。
 * @property {string} [logid] 上游 `logid`（若有）。
 * @property {{ fetchedAt: number, serverTime: number | undefined, plans: NormalizedPlan[], summary: QuotaSummary }} [lastKnown]
 *   失败前缓存里的上一份快照（若有），调用方可据此「显示旧值 + 提示过期」。
 */

/**
 * {@link QuotaCache} 的构造参数。**所有依赖都可注入**，因此单测不需要网络也不需要真时钟。
 *
 * @typedef {object} QuotaCacheOptions
 * @property {number} [ttlMs] 缓存 TTL（毫秒），默认 {@link DEFAULT_TTL_MS}。`0` 表示永不复用。
 * @property {() => number} [now] 时钟（毫秒），默认 `Date.now`。
 * @property {typeof globalThis.fetch} [fetchImpl] fetch 实现，默认 `globalThis.fetch`。
 * @property {string} [baseOrigin] origin 覆盖。
 * @property {string} [appVersion] 客户端版本。
 * @property {string} [platform] 平台键。
 * @property {string} [deviceMid] 设备标识（`X-Device-Mid`）。`balance`/`preview` 需要它。
 * @property {number} [timeoutMs] 超时毫秒。
 */

/**
 * 带 TTL 的额度缓存。
 *
 * 设计要点：
 * 1. **失败不污染缓存**：只有成功结果才写缓存；失败时旧快照原样保留（并在返回值里以
 *    `lastKnown` 带出），所以一次网络抖动不会让 UI 从「有额度」跳成「查不到」。
 * 2. **失败不抛异常**：`get()` 永不 reject —— 它返回判别式结果（`ok: true` / `ok: false`），
 *    调用方不需要 try/catch。
 * 3. **token 变了就失效**：缓存键是调用方传入的 token，换账号不会看到上一个账号的额度。
 * 4. **forceRefresh** 跳过读缓存，但仍写缓存（成功时）。
 * 5. **无单飞（single-flight）**：并发调用会各发一次请求。额度查询是低频调用，不值得为
 *    它引入 in-flight 去重带来的取消语义复杂度。
 *
 * @example
 * const cache = new QuotaCache({ fetchImpl: fakeFetch, now: () => clock })
 * const hit = await cache.get({ jwt: 'token' })
 * if (hit.ok) console.log(hit.summary.activePlans, hit.summary.byMeter)
 */
export class QuotaCache {
  #ttlMs
  #now
  #fetchImpl
  #baseOrigin
  #appVersion
  #platform
  #deviceMid
  #timeoutMs
  /** @type {QuotaCacheEntry | undefined} */
  #entry = undefined

  /**
   * @param {QuotaCacheOptions} [options] 构造参数。
   */
  constructor(options = {}) {
    this.#ttlMs = readFiniteNumber(options.ttlMs) ?? DEFAULT_TTL_MS
    this.#now = options.now ?? Date.now
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.#baseOrigin = options.baseOrigin
    this.#appVersion = options.appVersion
    this.#platform = options.platform
    this.#deviceMid = options.deviceMid
    this.#timeoutMs = readFiniteNumber(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS
  }

  /** @returns {number} 当前 TTL（毫秒）。 */
  get ttlMs() {
    return this.#ttlMs
  }

  /**
   * 只读地看一眼缓存条目（不触发请求、不改状态）。
   *
   * @returns {QuotaCacheEntry | undefined} 缓存条目（可能已过期）。
   */
  peek() {
    return this.#entry
  }

  /** 清空缓存。 */
  clear() {
    this.#entry = undefined
  }

  /**
   * 取额度快照。
   *
   * @param {object} [options] 参数。
   * @param {string} [options.jwt] `zcodejwttoken`（必填；为空直接返回 `token_missing`）。
   * @param {boolean} [options.forceRefresh] 跳过读缓存（成功仍会写缓存）。
   * @param {AbortSignal} [options.signal] 取消信号。
   * @returns {Promise<QuotaCacheHit | QuotaCacheMiss>} 判别式结果（**永不 reject**）。
   */
  async get(options = {}) {
    const token = typeof options.jwt === 'string' ? options.jwt.trim() : ''
    if (token === '') {
      return { ok: false, reason: 'token_missing', message: '缺少 zcodejwttoken（ZCode 客户端未登录？）' }
    }
    const cached = this.#entry
    const sameAccount = cached !== undefined && cached.key === token
    const now = this.#now()
    if (options.forceRefresh !== true && sameAccount && now < cached.expiresAt) {
      return hit(cached, true)
    }

    try {
      const result = await fetchBillingCurrent({
        jwt: token,
        signal: options.signal,
        baseOrigin: this.#baseOrigin,
        fetchImpl: this.#fetchImpl,
        appVersion: this.#appVersion,
        platform: this.#platform,
        deviceMid: this.#deviceMid,
        timeoutMs: this.#timeoutMs,
      })
      const fetchedAt = this.#now()
      /** @type {QuotaCacheEntry} */
      const entry = {
        key: token,
        fetchedAt,
        expiresAt: fetchedAt + this.#ttlMs,
        plans: result.plans,
        summary: summarizeQuota(result.plans),
        ...(result.serverTime === undefined ? {} : { serverTime: result.serverTime }),
      }
      this.#entry = entry
      return hit(entry, false)
    } catch (error) {
      /** @type {QuotaCacheMiss} */
      const miss = {
        ok: false,
        reason: failureReason(error),
        message: describeError(error),
      }
      if (error instanceof QuotaError) {
        if (error.status !== undefined) miss.status = error.status
        if (error.upstreamCode !== undefined) miss.upstreamCode = error.upstreamCode
        if (error.body !== undefined) miss.message = error.message
        if (error.logid !== undefined) miss.logid = error.logid
      }
      // 失败不覆盖缓存：把上一份快照原样带出，供调用方「显示旧值 + 标注过期」。
      if (sameAccount && cached !== undefined) {
        miss.lastKnown = {
          fetchedAt: cached.fetchedAt,
          serverTime: cached.serverTime,
          plans: cached.plans,
          summary: cached.summary,
        }
      } else if (cached !== undefined) {
        // 换了账号：旧账号的数据不能外泄给新账号，但也不需要提示，直接不带。
      }
      return miss
    }
  }
}

/**
 * 把缓存条目摊平成命中结果（避免把 `key` / `expiresAt` 这类内部字段泄漏给调用方）。
 *
 * @param {QuotaCacheEntry} entry 缓存条目。
 * @param {boolean} fromCache 是否来自缓存。
 * @returns {QuotaCacheHit} 命中结果。
 */
function hit(entry, fromCache) {
  /** @type {QuotaCacheHit} */
  const result = { ok: true, fromCache, fetchedAt: entry.fetchedAt, plans: entry.plans, summary: entry.summary }
  if (entry.serverTime !== undefined) result.serverTime = entry.serverTime
  return result
}
