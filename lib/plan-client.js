/**
 * ZCode 计划额度的直连 HTTP 客户端（Anthropic Messages over plan endpoints）。
 *
 * 这个模块**不启动任何子进程**：它把本机 ZCode 账号的凭证直接变成一组 HTTP 请求头，
 * 打向计划端点自己的 `/v1/messages`，再把上游的 SSE 事件翻译成插件内部统一的事件流。
 * 它与 `lib/app-server.js`（托管 agent 子进程 + stdio JSON-RPC）是两条互斥通道。
 *
 * ## 为什么改成直连 HTTP，而不是继续托管 agent
 *
 * 托管 agent 那条路的成本全在「绕」：拉起客户端二进制、维护常驻会话、每回合重新灌
 * 上下文、通过 `session/event` 反解模型增量、还要用 `session/update` 之类的事件反推
 * 这一回合到底花了哪个通道的额度。而计划端点本身就是标准的 **Anthropic Messages**
 * 兼容接口 —— 既然凭证就在本机磁盘上，请求体我们自己就有，那就没必要让一个 15MB 的
 * 二进制在中间转手。
 *
 * 实测证据（2026-10-27，本机真实凭证，两个端点各发一次 `POST …/v1/messages`）：
 *
 * ```
 * POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
 *   Authorization: Bearer <zcodejwttoken>
 *   content-type: application/json
 *   anthropic-version: 2023-06-01
 *   {"model":"GLM-5.3-Flash","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}
 * → 200 {"code":1005,"msg":"exceed quota limit","logid":"…"}
 *   或 429 {"code":3009,"msg":"model concurrency limit exceeded","logid":"…"}
 *   ↑ 鉴权通过、entitled 通过，只是本机没有额度
 *
 * POST https://open.bigmodel.cn/api/anthropic/v1/messages
 *   x-api-key: <codingPlanApiKey>
 * → 429 {"type":"error","error":{"type":"rate_limit_error","code":"1309",
 *         "message":"[1309][您的GLM Coding Plan套餐已到期…]"},"request_id":"…"}
 *   ↑ 鉴权通过
 *
 * 交叉用错鉴权头（计划端点给 x-api-key / bigmodel 端点给 Bearer JWT）→ 401
 * ```
 *
 * 也就是说：**这几个路径不需要 `X-Client-*` 请求签名**。`lib/client-signing.js` 复现的
 * 那套 Ed25519 + proof-of-work 签名链针对的是被 WAF 拦掉的另一类路径；把它当成
 * 「计划端点必须先签名」的依据是错的（该模块的 README 结论已按实测推翻）。
 *
 * ## 由实测直接推出的两条实现约束
 *
 * 1. **鉴权形态按 providerId 族区分**，不能一套头打通所有端点：`start-plan` /
 *    `off-peak` / `highspeed` 走 `Authorization: Bearer <zcodejwttoken>`，
 *    `*-coding-plan` 走 `x-api-key: <codingPlanApiKey>`，组合形态两者都要。
 * 2. **HTTP 200 也可能是错误**：`zcode-plan` 端点用 200 携带业务错误码
 *    （`{code:1005,msg:"exceed quota limit"}`）。所以判定成败必须看 body，
 *    而不是只看 `response.ok` —— 本模块为此把「错误信封解析」抽成了纯函数
 *    {@link parseErrorEnvelope} / {@link classifyPlanError}。
 *
 * ## 本模块实现后的自测复核（同一天，同一台机器）
 *
 * 用本模块自己的 `resolvePlanRoute` + `buildHeaders` 重跑了一遍上面三条路径，结论一致：
 *
 * ```
 * account:zai-start-plan        → POST …/zcode-plan/anthropic/v1/messages
 *   headers: content-type, anthropic-version, accept, authorization
 *   200 {"code":1005,"msg":"exceed quota limit","logid":"2026102708261034…"}
 *
 * account:bigmodel-team-coding-plan → POST open.bigmodel.cn/api/anthropic/v1/messages
 *   headers: content-type, anthropic-version, accept, x-api-key
 *   429 {"type":"error","error":{"type":"rate_limit_error","code":"1309","message":"…套餐已到期…"}}
 *
 * 负控（必须失败才说明鉴权头是被区分的）：
 *   plan endpoint + x-api-key  → 401（空 body）
 *   bigmodel    + Bearer JWT   → 401 {"error":{"message":"令牌已过期或验证不正确","type":"401"}}
 * ```
 *
 * ## 本机现状（诚实记录）
 *
 * 本机账号的套餐已过期 / 无额度，所以真实网络验证能证明**链路通**（拿到业务码而不是
 * 401/403），但拿不到一次成功的内容流。`streamMessages` 对真实端点跑通的结果是
 * 抛 `PlanClientError{code:'QUOTA', detail:{kind:'quota', code:1005, logid:…}}` ——
 * 正是上表那条「HTTP 200 带业务错误」的路径，说明 200 判错的陷阱已被正确处理。
 * 流式细节因此靠单测覆盖：字节流 → SSE 事件 → 统一事件各段都是纯函数，
 * 测试里注入假 `Response` 即可跑完整条链路。
 *
 * @module lib/plan-client
 */

/** Anthropic Messages 协议版本头，两个端点的兼容层都按这个版本解析。 */
export const ANTHROPIC_VERSION = '2023-06-01'

/** 默认单次请求总超时（毫秒）。计划端点在无额度时会快速返回，留足余量给正常生成。 */
export const DEFAULT_TIMEOUT_MS = 120_000

/**
 * 端点键：计划种类，其中 `coding-plan` 再按凭证家族分成两个 baseUrl。
 *
 * @typedef {'start-plan' | 'coding-plan-zai' | 'coding-plan-bigmodel' | 'offpeak-idle-plan' | 'highspeed-card'} PlanEndpointKey
 */

/** 计划种类（与 providerId 的对应关系见 {@link resolvePlanRoute}）。 @typedef {'start-plan' | 'coding-plan' | 'offpeak-idle-plan' | 'highspeed-card'} PlanKind */

/**
 * 计划端点族 → baseUrl。baseUrl 已经含 `/anthropic` 段，`/v1/messages` 由
 * {@link messagesUrl} 追加。
 *
 * @type {Readonly<Record<PlanEndpointKey, string>>}
 */
export const PLAN_ENDPOINTS = {
  'start-plan': 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
  'coding-plan-zai': 'https://api.z.ai/api/anthropic',
  'coding-plan-bigmodel': 'https://open.bigmodel.cn/api/anthropic',
  'offpeak-idle-plan': 'https://zcode.z.ai/api/v1/off-peak/anthropic',
  'highspeed-card': 'https://zcode.z.ai/api/v1/highspeed/anthropic',
}

/** 凭证家族。 @typedef {'zai' | 'bigmodel'} PlanFamily */

/** 鉴权头形态。 @typedef {'bearer-jwt' | 'api-key' | 'bearer-jwt+coding-plan-key' | 'bearer-jwt+coding-plan-key+card-id'} PlanAuthKind */

/** 错误类别。 @typedef {'quota' | 'concurrency' | 'auth' | 'param' | 'upstream'} PlanErrorKind */

/**
 * {@link resolvePlanRoute} 的入参。
 *
 * @typedef {object} PlanRouteInput
 * @property {string} providerId 路由 id，取自 DSH 模型选择的 `providerId`。
 * @property {Record<string, unknown> | null | undefined} [credentials]
 *   `lib/credentials.js` 的 `readCredentials()` 结果（键 → 明文值，解密失败处为 null）。
 * @property {string} [cardId] 高速通道卡片 id（`highspeed-card` 族必需）。
 * @property {string} [ticketId] 错峰票号（`offpeak-idle-plan` 族可选）。
 * @property {string} [baseUrl] 显式覆盖 baseUrl（测试 / 代理用）。
 */

/**
 * 一条已解析好的计划路由。
 *
 * @typedef {object} PlanRoute
 * @property {string} providerId 原始 providerId（保留大小写，便于日志对照）。
 * @property {PlanFamily} family 凭证家族。
 * @property {PlanKind} planKind 计划种类。
 * @property {PlanAuthKind} authKind 鉴权头形态（机读，便于诊断）。
 * @property {string} baseUrl 已含 `/anthropic` 的基址。
 * @property {(options?: { stream?: boolean, extra?: Record<string, string> }) => Record<string, string>} buildHeaders
 *   构造该路由的请求头。`buildHeaders()` 无参调用即可（默认非流式）。
 */

/**
 * 上游错误信封的统一形状（`code` / `message` 原样取自上游，不做改写）。
 *
 * @typedef {object} PlanErrorEnvelope
 * @property {number | string | undefined} code 上游原始业务码（`1005` / `'1309'` / `3001` …）。
 * @property {string} message 上游原始文案（缺失时为空串）。
 * @property {string | undefined} logid `zcode-plan` 端点的 `logid`。
 * @property {string | undefined} requestId `bigmodel` 端点的 `request_id`。
 * @property {string | undefined} upstreamType 上游错误类型（如 `rate_limit_error`）。
 */

/**
 * {@link classifyPlanError} 的结果。
 *
 * @typedef {object} PlanErrorResult
 * @property {PlanErrorKind} kind 归一后的错误类别。
 * @property {number | string | undefined} code 上游原始业务码，原样带出。
 * @property {string} message 上游原始文案（无信封时退化为 HTTP 状态描述 / body 摘录）。
 * @property {boolean} retryable 是否值得退避重试。
 * @property {number} status HTTP 状态码。
 * @property {string | undefined} logid 上游 `logid`。
 * @property {string | undefined} requestId 上游 `request_id`。
 * @property {string | undefined} upstreamType 上游错误类型。
 * @property {string} body 原始 body 摘录（截断到 500 字符，便于诊断且不撑爆日志）。
 */

/**
 * 统一事件流里的一种事件。
 *
 * @typedef {{ type: 'text', delta: string }
 *   | { type: 'reasoning', delta: string }
 *   | { type: 'tool_use_start', id: string, name: string }
 *   | { type: 'tool_use_delta', id: string, partialJson: string }
 *   | { type: 'usage', inputTokens: number, outputTokens: number }
 *   | { type: 'done', stopReason: string | null }} PlanStreamEvent
 */

/**
 * 一条解析出来的 SSE 事件。`event` 缺省为 `'message'`（SSE 规范默认值）。
 *
 * @typedef {object} SseEvent
 * @property {string} event `event:` 行的值。
 * @property {string} data `data:` 行按换行拼接后的值。
 */

/**
 * 一次路由尝试的结果（merged 模式的自动切换用）。
 *
 * @typedef {object} PlanRouteAttempt
 * @property {string} providerId 尝试的路由 id。
 * @property {string} baseUrl 该路由的端点。
 * @property {boolean} ok 是否成功（拿到内容或上游正常结束）。
 * @property {string} [code] 失败时的机读错误码。
 * @property {string} [message] 失败原因。
 * @property {boolean} [failover] 失败是否值得换下一条路由。
 */

/**
 * {@link streamMessagesAcrossRoutes} 的可选项。
 *
 * @typedef {object} PlanFailoverOptions
 * @property {AbortSignal} [signal] 调用方取消信号。
 * @property {number} [timeoutMs] **每次**尝试的总超时。
 * @property {typeof fetch} [fetchImpl] 注入用 fetch。
 * @property {(attempt: PlanRouteAttempt) => void} [onAttempt]
 *   每次尝试结束时回调（成功或失败），用于日志与诊断。
 */

/**
 * Anthropic Messages 请求体（本模块只负责透传，不解释 content 结构）。
 *
 * @typedef {object} AnthropicMessagesRequest
 * @property {string} model
 * @property {number} max_tokens
 * @property {Array<{ role: 'user' | 'assistant', content: unknown }>} messages
 * @property {unknown} [system]
 * @property {unknown} [tools]
 * @property {unknown} [tool_choice]
 * @property {unknown} [thinking]
 * @property {number} [temperature]
 * @property {number} [top_p]
 * @property {unknown[]} [stop_sequences]
 * @property {boolean} [stream]
 */

/**
 * {@link streamMessages} 的可选项。
 *
 * @typedef {object} PlanStreamOptions
 * @property {AbortSignal} [signal] 调用方取消信号。
 * @property {number} [timeoutMs] 总超时，默认 {@link DEFAULT_TIMEOUT_MS}；`<= 0` 表示不限。
 * @property {typeof fetch} [fetchImpl] 注入用 fetch（单测 / 自定义代理）。
 * @property {Record<string, string>} [headers] 额外请求头（覆盖同名的默认头）。
 */

/** 计划类错误码（机读）。 @type {readonly string[]} */
export const PLAN_ERROR_CODES = /** @type {const} */ ([
  'UNKNOWN_PROVIDER',
  'TOKEN_MISSING',
  'API_KEY_MISSING',
  'CARD_ID_MISSING',
  'TRANSPORT',
  'TIMEOUT',
  'ABORTED',
  'BAD_RESPONSE',
  'QUOTA',
  'CONCURRENCY',
  'AUTH',
  'PARAM',
  'UPSTREAM',
])

/**
 * 计划通道错误：路由/凭证问题用 `code` 区分，上游业务错误用 {@link PlanErrorResult} 带出。
 */
export class PlanClientError extends Error {
  /**
   * @param {string} message 人类可读描述。
   * @param {string} code 稳定的机读错误码（见 {@link PLAN_ERROR_CODES}）。
   * @param {PlanErrorResult} [detail] 上游错误详情（仅上游错误有）。
   */
  constructor(message, code, detail) {
    super(message)
    this.name = 'PlanClientError'
    this.code = code
    /** @type {PlanErrorResult | undefined} */
    this.detail = detail
    this.retryable = detail?.retryable ?? false
    /**
     * 多路由自动切换时的完整尝试链（只有 `streamMessagesAcrossRoutes` 会填）。
     *
     * @type {PlanRouteAttempt[] | undefined}
     */
    this.attempts = undefined
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value 候选字段。
 * @returns {string} 去空白后的字符串；非字符串一律 ''。
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * @param {unknown} value 候选字段。
 * @returns {number | undefined} 有限数字（取整）；否则 undefined。
 */
function int(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

/**
 * 业务码归一：`0` / `'0'` / 空 / 非数字一律视为「没有错误码」。
 *
 * @param {unknown} value 上游 `code` 字段。
 * @returns {number | string | undefined} 原样保留的业务码。
 */
function codeValue(value) {
  const numeric = int(value)
  if (numeric !== undefined) return numeric === 0 ? undefined : numeric
  const asText = text(value)
  if (asText === '' || asText === '0') return undefined
  return asText
}

// ---------------------------------------------------------------------------
// 凭证 → 路由
// ---------------------------------------------------------------------------

/**
 * 从共享凭证里按 providerId 前缀匹配编码套餐 API Key。
 *
 * 存储键形如 `account-provider:coding-plan:account:<providerId>:account:<accountId>:api-key`
 * （与 `lib/account-sync.js` 的 `selectRuntimeAuth` 同一形态）。这里容忍一处差异：
 * 调用方给的 providerId 可能带或不带 `account:` 前缀，两种都试。
 *
 * @param {Record<string, unknown> | null | undefined} credentials 解密后的凭证表。
 * @param {string} providerId 路由 id。
 * @returns {string | undefined} 命中的 API Key，未命中时 undefined。
 */
export function pickCodingPlanApiKey(credentials, providerId) {
  if (credentials === null || typeof credentials !== 'object') return undefined
  const wanted = text(providerId)
  if (wanted === '') return undefined
  const record = credentials
  const bare = wanted.startsWith('account:') ? wanted.slice('account:'.length) : wanted
  const prefixes = [
    `account-provider:coding-plan:${wanted}:account:`,
    `account-provider:coding-plan:${bare}:account:`,
    `account-provider:coding-plan:account:${bare}:account:`,
  ]
  for (const prefix of prefixes) {
    for (const key of Object.keys(record)) {
      if (!key.startsWith(prefix) || !key.endsWith(':api-key')) continue
      const value = text(record[key])
      if (value !== '') return value
    }
  }
  return undefined
}

/**
 * providerId → 计划种类。顺序敏感：`off-peak` / `highspeed` 也含 plan 字样，
 * 必须先于 `start-plan` / `coding-plan` 判定。
 *
 * @param {string} providerId 路由 id。
 * @returns {PlanKind | undefined} 计划种类，未知路由 undefined。
 */
function planKindFor(providerId) {
  const lower = providerId.toLowerCase()
  if (lower.includes('offpeak') || lower.includes('off-peak')) return 'offpeak-idle-plan'
  if (lower.includes('highspeed')) return 'highspeed-card'
  if (lower.includes('start-plan') || lower.includes('start_plan')) return 'start-plan'
  if (lower.includes('coding-plan') || lower.includes('coding_plan')) return 'coding-plan'
  return undefined
}

/**
 * providerId → 凭证家族。
 *
 * @param {string} providerId 路由 id。
 * @returns {PlanFamily | undefined} 家族，无法判定时 undefined。
 */
function familyFor(providerId) {
  const lower = providerId.toLowerCase()
  if (lower.includes('bigmodel')) return 'bigmodel'
  if (lower.includes('zai')) return 'zai'
  return undefined
}

/**
 * 解析 providerId 对应的计划路由（baseUrl + 鉴权头构造器）。
 *
 * 表格来自 2026-10-27 的实测（见模块文档），`coding-plan` 的 baseUrl 再按家族分叉。
 *
 * | providerId 族 | baseUrl | 鉴权头 |
 * |---|---|---|
 * | `account:zai-start-plan` / `account:bigmodel-start-plan` | `…/zcode-plan/anthropic` | `Authorization: Bearer <jwt>` |
 * | `account:zai-*-coding-plan` | `https://api.z.ai/api/anthropic` | `x-api-key: <planKey>` |
 * | `account:bigmodel-*-coding-plan` | `https://open.bigmodel.cn/api/anthropic` | `x-api-key: <planKey>` |
 * | `account:*-offpeak-idle-plan` | `…/off-peak/anthropic` | Bearer + `X-Coding-Plan-Api-Key` |
 * | `account:*-highspeed-card` | `…/highspeed/anthropic` | 同上 + `X-Highspeed-Card-ID` |
 *
 * @param {PlanRouteInput} input 路由入参。
 * @returns {PlanRoute} 解析好的路由。
 * @throws {PlanClientError} providerId 无法识别，或该路由必需的凭证缺失。
 */
export function resolvePlanRoute(input) {
  const providerId = text(input?.providerId)
  if (providerId === '') {
    throw new PlanClientError('resolvePlanRoute 需要非空的 providerId', 'UNKNOWN_PROVIDER')
  }
  const planKind = planKindFor(providerId)
  const family = familyFor(providerId)
  if (planKind === undefined || family === undefined) {
    throw new PlanClientError(
      `无法识别的计划路由 providerId：${providerId}（已知形态：account:<zai|bigmodel>-<start-plan|coding-plan|offpeak-idle-plan|highspeed-card>）`,
      'UNKNOWN_PROVIDER',
    )
  }

  const credentials = input.credentials ?? undefined
  const record = credentials !== null && typeof credentials === 'object' ? credentials : {}
  const jwt = text(record['zcodejwttoken'])
  const apiKey = pickCodingPlanApiKey(record, providerId)

  /** @type {PlanAuthKind} */
  let authKind
  /** @type {PlanEndpointKey} */
  let endpointKey = /** @type {PlanEndpointKey} */ (planKind)
  if (planKind === 'start-plan') {
    authKind = 'bearer-jwt'
    if (jwt === '') {
      throw new PlanClientError(
        `计划路由 ${providerId} 需要 Bearer 鉴权，但共享凭证里没有 zcodejwttoken（ZCode 客户端未登录 Z.AI？）`,
        'TOKEN_MISSING',
      )
    }
  } else if (planKind === 'coding-plan') {
    authKind = 'api-key'
    endpointKey = family === 'bigmodel' ? 'coding-plan-bigmodel' : 'coding-plan-zai'
    if (apiKey === undefined) {
      throw new PlanClientError(
        `计划路由 ${providerId} 需要编码套餐 API Key（account-provider:coding-plan:${providerId}:account:<accountId>:api-key），共享凭证里没有`,
        'API_KEY_MISSING',
      )
    }
  } else {
    authKind = planKind === 'highspeed-card' ? 'bearer-jwt+coding-plan-key+card-id' : 'bearer-jwt+coding-plan-key'
    if (jwt === '') {
      throw new PlanClientError(`计划路由 ${providerId} 需要 Bearer 鉴权，但共享凭证里没有 zcodejwttoken`, 'TOKEN_MISSING')
    }
    if (apiKey === undefined) {
      throw new PlanClientError(`计划路由 ${providerId} 需要 X-Coding-Plan-Api-Key，共享凭证里没有对应 api-key`, 'API_KEY_MISSING')
    }
  }

  const override = text(input.baseUrl)
  const baseUrl = override !== '' ? override : PLAN_ENDPOINTS[endpointKey]
  const cardId = text(input.cardId)
  const ticketId = text(input.ticketId)

  /**
   * @param {{ stream?: boolean, extra?: Record<string, string> }} [options] 头部开关。
   * @returns {Record<string, string>} 请求头。
   * @throws {PlanClientError} `highspeed-card` 路由缺少 `cardId` 时抛出。
   */
  const buildHeaders = (options = {}) => {
    /** @type {Record<string, string>} */
    const headers = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      accept: options.stream === true ? 'text/event-stream' : 'application/json',
    }
    if (authKind === 'bearer-jwt') {
      headers.authorization = `Bearer ${jwt}`
    } else if (authKind === 'api-key') {
      headers['x-api-key'] = /** @type {string} */ (apiKey)
    } else {
      headers.authorization = `Bearer ${jwt}`
      headers['X-Coding-Plan-Api-Key'] = /** @type {string} */ (apiKey)
      // 错峰端点还认票号；没有票号时不编造（缺票时上游会以 3001/3102 拒绝，交给 classifyPlanError 报出来）。
      if (planKind === 'offpeak-idle-plan' && ticketId !== '') headers['X-Off-Peak-Ticket-ID'] = ticketId
      if (planKind === 'highspeed-card') {
        if (cardId === '') {
          throw new PlanClientError(
            `计划路由 ${providerId} 需要 X-Highspeed-Card-ID（传入 cardId 后重试）`,
            'CARD_ID_MISSING',
          )
        }
        headers['X-Highspeed-Card-ID'] = cardId
      }
    }
    if (options.extra !== undefined) Object.assign(headers, options.extra)
    return headers
  }

  return { providerId, family, planKind, authKind, baseUrl, buildHeaders }
}

/**
 * baseUrl → `/v1/messages` 完整地址（baseUrl 已含 `/anthropic`，这里只追加 `/v1/messages`）。
 *
 * @param {string} baseUrl 计划端点基址。
 * @returns {string} 完整 messages 地址。
 * @throws {PlanClientError} baseUrl 为空时抛出。
 */
export function messagesUrl(baseUrl) {
  const base = text(baseUrl).replace(/\/+$/u, '')
  if (base === '') throw new PlanClientError('messagesUrl 需要非空的 baseUrl', 'UNKNOWN_PROVIDER')
  if (base.endsWith('/v1/messages')) return base
  return `${base}/v1/messages`
}

// ---------------------------------------------------------------------------
// 错误信封解析 / 分类
// ---------------------------------------------------------------------------

/**
 * 从响应 body 里解析上游错误信封。
 *
 * 两种形状都要认（实测各出现一次）：
 *
 * ```
 * zcode-plan:        {"code":1005,"msg":"exceed quota limit","logid":"…"}
 * bigmodel anthropic: {"type":"error","error":{"type":"rate_limit_error","code":"1309","message":"…"},"request_id":"…"}
 * ```
 *
 * `{code:0,msg:""}` 这类成功 envelope 返回 undefined（没有错误可报）；
 * 同理 body 里有成功码却带了 `msg`（如 `{code:0,msg:"ok"}`）也不算错误。
 *
 * @param {unknown} bodyText 原始响应文本。
 * @returns {PlanErrorEnvelope | undefined} 解析出的错误信封；不是错误时 undefined。
 */
export function parseErrorEnvelope(bodyText) {
  const raw = typeof bodyText === 'string' ? bodyText.trim() : ''
  if (raw === '') return undefined
  /** @type {any} */
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined

  const nested = payload.error
  const fromNested = nested !== null && typeof nested === 'object' && !Array.isArray(nested)
  const code = fromNested ? codeValue(nested.code) ?? codeValue(payload.code) : codeValue(payload.code)
  // 判据只有两条：有非零业务码，或有嵌套的 error 对象。业务码 0 / 缺码的成功响应
  // （`{code:0,msg:""}`、`{code:0,msg:"ok"}`、`{data:{…}}`）一律没有错误可报。
  if (code === undefined && !fromNested) return undefined

  const message = fromNested
    ? text(nested.message) || text(nested.msg) || text(payload.message) || text(payload.msg)
    : text(payload.msg) || text(payload.message)
  return {
    code,
    message,
    logid: text(payload.logid) || undefined,
    requestId: text(payload.request_id) || text(payload.requestId) || undefined,
    upstreamType: fromNested ? text(nested.type) || undefined : text(payload.type) || undefined,
  }
}

/** 归到 `quota` 的业务码：1005 超额 / 1309 套餐到期 / 1113 余额不足。 */
const QUOTA_CODES = new Set(['1005', '1309', '1113'])
/** 归到 `concurrency` 的业务码：3009 并发上限 / 3105 错峰队列未就绪。 */
const CONCURRENCY_CODES = new Set(['3009', '3105'])
/** 归到 `param` 的业务码：3001 参数错误 / 3102 错峰票号无效。 */
const PARAM_CODES = new Set(['3001', '3102'])

/**
 * 把上游失败归一成插件可分流的结果。
 *
 * 纯函数：只吃 `(status, bodyText)`，不发请求、不读环境，单测直接覆盖。
 * 上游原始 `code` / `message` 原样带出，绝不吞掉 —— 用户看到的
 * `1005 exceed quota limit` 和 `1309 套餐已到期` 是完全不同的两件事。
 *
 * @param {number} status HTTP 状态码。
 * @param {unknown} bodyText 原始响应文本。
 * @returns {PlanErrorResult} 归一后的错误。
 */
export function classifyPlanError(status, bodyText) {
  const httpStatus = int(status) ?? 0
  const envelope = parseErrorEnvelope(bodyText)
  const rawBody = typeof bodyText === 'string' ? bodyText.trim() : ''
  const rawCode = envelope?.code
  const codeText = rawCode === undefined ? '' : String(rawCode)
  const message = envelope?.message !== undefined && envelope.message !== ''
    ? envelope.message
    : rawBody !== ''
      ? rawBody.slice(0, 300)
      : `HTTP ${httpStatus}`

  /** @type {PlanErrorResult} */
  const result = {
    kind: 'upstream',
    code: rawCode,
    message,
    retryable: false,
    status: httpStatus,
    logid: envelope?.logid,
    requestId: envelope?.requestId,
    upstreamType: envelope?.upstreamType,
    body: rawBody.slice(0, 500),
  }

  // 状态码优先：401/403 无论 body 写了什么都只能是鉴权问题。
  if (httpStatus === 401 || httpStatus === 403) return { ...result, kind: 'auth', retryable: false }
  if (QUOTA_CODES.has(codeText)) return { ...result, kind: 'quota', retryable: false }
  if (CONCURRENCY_CODES.has(codeText)) return { ...result, kind: 'concurrency', retryable: true }
  if (PARAM_CODES.has(codeText)) return { ...result, kind: 'param', retryable: false }
  if (httpStatus === 429) return { ...result, kind: 'concurrency', retryable: true }
  if (httpStatus === 400 || httpStatus === 404 || httpStatus === 422) return { ...result, kind: 'param', retryable: false }
  if (httpStatus >= 500) return { ...result, kind: 'upstream', retryable: true }
  return result
}

// ---------------------------------------------------------------------------
// SSE：字节流 → SSE 事件
// ---------------------------------------------------------------------------

/**
 * 增量 SSE 解析器（纯状态机，无 I/O）。
 *
 * 覆盖的边界：`data:` 多行拼接、`event:` 与 data 配对、`\r\n` / 单 `\r` / `\n` 归一、
 * 跨 chunk 的半行、跨 chunk 被切开的 `\r\n`、多字节 UTF-8 被切在字符中间。
 * `[DONE]` 不在这里特判 —— 它原样作为一条 data 事件冒出去，由上层翻译器处理，
 * 这样解析器只管 SSE 本身。
 *
 * @returns {{ push: (chunk: string | Uint8Array) => SseEvent[], flush: () => SseEvent[], pending: () => string }}
 *   三个方法：`push` 吃一块字节/字符串、`flush` 收尾、`pending` 看未完成的缓冲区。
 */
export function createSseParser() {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  /** @type {string} */
  let eventName = ''
  /** @type {string[]} */
  let dataLines = []

  /**
   * @param {SseEvent[]} out 事件收集器。
   */
  const dispatch = (out) => {
    if (dataLines.length === 0) {
      // 没有 data 的 event 行（或纯注释块）按 SSE 规范丢弃。
      eventName = ''
      return
    }
    out.push({ event: eventName === '' ? 'message' : eventName, data: dataLines.join('\n') })
    eventName = ''
    dataLines = []
  }

  /**
   * @param {string} line 一行（不含行尾）。
   * @param {SseEvent[]} out 事件收集器。
   */
  const handleLine = (line, out) => {
    if (line === '') {
      dispatch(out)
      return
    }
    if (line.startsWith(':')) return // 注释 / 心跳
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') eventName = value
    else if (field === 'data') dataLines.push(value)
  }

  /**
   * @param {boolean} final 是否已到流末尾（此时流末的孤立 `\r` 也该当行尾处理）。
   * @returns {SseEvent[]} 本次排空得到的事件。
   */
  const drain = (final) => {
    /** @type {SseEvent[]} */
    const out = []
    let start = 0
    for (let index = 0; index < buffer.length; index += 1) {
      const ch = buffer[index]
      if (ch !== '\n' && ch !== '\r') continue
      // 块尾的孤立 \r 可能是被切开的 \r\n 的前半，等下一块再判。
      if (ch === '\r' && index === buffer.length - 1 && !final) break
      handleLine(buffer.slice(start, index), out)
      let next = index + 1
      if (ch === '\r' && buffer[next] === '\n') next += 1
      start = next
      index = next - 1
    }
    buffer = buffer.slice(start)
    return out
  }

  return {
    /**
     * @param {string | Uint8Array} chunk 新到的一块数据。
     * @returns {SseEvent[]} 本次解析出的事件（可能为空）。
     */
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      return drain(false)
    },
    /**
     * @returns {SseEvent[]} 收尾时剩余的事件（含未以空行结束的最后一条）。
     */
    flush() {
      buffer += decoder.decode()
      /** @type {SseEvent[]} */
      const out = drain(true)
      // 流末既没有行尾也没有空行：把最后半行当成完整行处理。
      if (buffer !== '') {
        handleLine(buffer, out)
        buffer = ''
      }
      // 流末没有空行：把还没 dispatch 的 data 补出去。
      if (dataLines.length > 0) dispatch(out)
      return out
    },
    /** @returns {string} 尚未成行的缓冲内容（诊断用）。 */
    pending() {
      return buffer
    },
  }
}

// ---------------------------------------------------------------------------
// SSE 事件 → 统一事件
// ---------------------------------------------------------------------------

/**
 * Anthropic Messages 流式事件的翻译器（纯状态机）。
 *
 * 上游事件 → 本模块事件的对应关系：
 *
 * ```
 * message_start.message.usage          → usage
 * content_block_start (tool_use)       → tool_use_start（记住 index → id，供 delta 回填）
 * content_block_delta text_delta       → text
 * content_block_delta thinking_delta   → reasoning
 * content_block_delta input_json_delta → tool_use_delta
 * message_delta (usage / stop_reason)  → usage + done
 * message_stop                         → done（若还没发过）
 * [DONE]                               → done（若还没发过）
 * error                                → 记在 `failure` 上，由调用方抛
 * ```
 *
 * @returns {{
 *   push: (event: SseEvent) => PlanStreamEvent[],
 *   readonly finished: boolean,
 *   readonly failure: PlanErrorResult | undefined,
 * }}
 *   `finished` 表示已产出 done；`failure` 表示流内出现了 error 帧。
 */
export function createAnthropicTranslator() {
  /** @type {Map<number, { id: string, name: string }>} */
  const toolBlocks = new Map()
  let finished = false
  let inputTokens = 0
  /** @type {PlanErrorResult | undefined} */
  let failure

  /** @param {number} outputTokens 当前累计输出 token。 @returns {PlanStreamEvent[]} */
  const usageEvent = (outputTokens) => [{ type: 'usage', inputTokens, outputTokens }]

  /**
   * @param {string | null} stopReason 结束原因。
   * @returns {PlanStreamEvent[]} done 事件（已经发过则为空）。
   */
  const finish = (stopReason) => {
    if (finished) return []
    finished = true
    return [{ type: 'done', stopReason }]
  }

  return {
    get finished() {
      return finished
    },
    get failure() {
      return failure
    },
    /**
     * @param {SseEvent} event 一条 SSE 事件。
     * @returns {PlanStreamEvent[]} 翻译出的统一事件。
     */
    push(event) {
      /** @type {PlanStreamEvent[]} */
      const out = []
      if (finished) return out
      const data = typeof event.data === 'string' ? event.data : ''
      if (data === '[DONE]') return finish(null)

      /** @type {any} */
      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        // 空 data / 非 JSON 的心跳：静默跳过，绝不因此中断整条流。
        return out
      }
      if (payload === null || typeof payload !== 'object') return out

      const type = typeof payload.type === 'string' ? payload.type : event.event
      switch (type) {
        case 'message_start': {
          const usage = payload.message?.usage
          const input = int(usage?.input_tokens)
          const output = int(usage?.output_tokens) ?? 0
          inputTokens = input ?? 0
          // 只在上游确实报了 input token 时才发 usage，避免用 0 覆盖后续累计值。
          if (input !== undefined) out.push(...usageEvent(output))
          break
        }
        case 'content_block_start': {
          const index = int(payload.index) ?? 0
          const block = payload.content_block
          if (block?.type === 'tool_use') {
            const id = text(block.id)
            const name = text(block.name)
            toolBlocks.set(index, { id, name })
            out.push({ type: 'tool_use_start', id, name })
            const input = block.input
            if (input !== null && typeof input === 'object' && Object.keys(input).length > 0) {
              out.push({ type: 'tool_use_delta', id, partialJson: JSON.stringify(input) })
            }
          }
          break
        }
        case 'content_block_delta': {
          const index = int(payload.index) ?? 0
          const delta = payload.delta
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            out.push({ type: 'text', delta: delta.text })
          } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            out.push({ type: 'reasoning', delta: delta.thinking })
          } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            out.push({ type: 'tool_use_delta', id: toolBlocks.get(index)?.id ?? '', partialJson: delta.partial_json })
          }
          // signature_delta / redacted_thinking 之类对 DSH 无意义，丢弃。
          break
        }
        case 'message_delta': {
          const output = int(payload.usage?.output_tokens)
          if (output !== undefined) out.push(...usageEvent(output))
          const stopReason = typeof payload.delta?.stop_reason === 'string' ? payload.delta.stop_reason : null
          out.push(...finish(stopReason))
          break
        }
        case 'message_stop': {
          out.push(...finish(null))
          break
        }
        case 'error': {
          failure = classifyPlanError(200, data)
          finished = true
          break
        }
        default:
          break // ping / content_block_stop 等无需转发
      }
      return out
    },
  }
}

// ---------------------------------------------------------------------------
// 非流式 JSON → 统一事件
// ---------------------------------------------------------------------------

/**
 * 把非流式的 Anthropic Messages 响应体翻译成统一事件序列（纯函数）。
 *
 * @param {unknown} payload 已解析的响应 JSON。
 * @returns {PlanStreamEvent[]} 统一事件（以 done 结尾）。
 */
export function translateMessage(payload) {
  /** @type {PlanStreamEvent[]} */
  const out = []
  if (payload === null || typeof payload !== 'object') return out
  const message = /** @type {any} */ (payload)
  const content = Array.isArray(message.content) ? message.content : []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', delta: block.text })
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      out.push({ type: 'reasoning', delta: block.thinking })
    } else if (block.type === 'tool_use') {
      const id = text(block.id)
      out.push({ type: 'tool_use_start', id, name: text(block.name) })
      if (block.input !== undefined) out.push({ type: 'tool_use_delta', id, partialJson: JSON.stringify(block.input) })
    }
  }
  const inputTokens = int(message.usage?.input_tokens) ?? 0
  const outputTokens = int(message.usage?.output_tokens) ?? 0
  if (message.usage !== undefined) out.push({ type: 'usage', inputTokens, outputTokens })
  out.push({ type: 'done', stopReason: typeof message.stop_reason === 'string' ? message.stop_reason : null })
  return out
}

/**
 * 判断一段文本是不是 SSE（用于 content-type 撒谎时兜底).
 *
 * @param {string} body 响应文本。
 * @returns {boolean} 看起来像 SSE 时为 true。
 */
function looksLikeSse(body) {
  return /^(?:data|event|id|retry):/mu.test(body.slice(0, 200))
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/**
 * 组合「调用方取消 + 总超时」成一个 signal。
 *
 * 不用 `AbortSignal.any` / `AbortSignal.timeout`，避免依赖较新的运行时/类型定义。
 *
 * @param {AbortSignal | undefined} signal 调用方 signal。
 * @param {number} timeoutMs 超时毫秒；`<= 0` 表示不限。
 * @returns {{ signal: AbortSignal, timedOut: () => boolean, dispose: () => void }} 组合结果。
 */
function createRequestSignal(signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`计划端点请求超时（${timeoutMs}ms）`))
    }, timeoutMs)
    // 不要因为这个定时器拖住进程退出。
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
  }
  const onAbort = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * @param {Response} response 上游响应。
 * @returns {Promise<string>} 文本 body（读失败时 ''）。
 */
async function readBodyText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/**
 * @param {PlanErrorResult} detail 分类结果。
 * @returns {PlanClientError} 带上游详情的错误。
 */
function errorForDetail(detail) {
  const label = {
    quota: '计划额度不足',
    concurrency: '上游并发受限',
    auth: '计划鉴权失败',
    param: '上游认为请求参数有问题',
    upstream: '上游返回错误',
  }[detail.kind]
  return new PlanClientError(
    `${label}（${detail.kind}${detail.code === undefined ? '' : ` ${String(detail.code)}`}）：${detail.message}`,
    /** @type {string} */ ({ quota: 'QUOTA', concurrency: 'CONCURRENCY', auth: 'AUTH', param: 'PARAM', upstream: 'UPSTREAM' }[detail.kind]),
    detail,
  )
}

/**
 * 直连计划端点跑一次 Messages 请求，产出统一事件流。
 *
 * 请求体是 Anthropic Messages 形态，`stream` 一律被强制成 `true`。
 * 失败时抛 {@link PlanClientError}：
 *   - 传输/超时/取消：`TRANSPORT` / `TIMEOUT` / `ABORTED`
 *   - 上游业务错误：`QUOTA` / `CONCURRENCY` / `AUTH` / `PARAM` / `UPSTREAM`，详情在 `error.detail`
 *
 * 关键细节：`zcode-plan` 端点会用 **HTTP 200** 携带业务错误码，所以 200 也要检查 body
 * （见 {@link parseErrorEnvelope}）；`stream` 为 true 但上游回了普通 JSON 时，
 * 这里会退化成一次性翻译，而不是报错。
 *
 * @param {PlanRoute} route 已解析路由（见 {@link resolvePlanRoute}）。
 * @param {AnthropicMessagesRequest} request Anthropic Messages 请求体。
 * @param {PlanStreamOptions} [options] 取消/超时/注入。
 * @returns {AsyncGenerator<PlanStreamEvent, void, unknown>} 统一事件流。
 */
export async function* streamMessages(route, request, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new PlanClientError('当前运行时不提供 fetch（需要 Node >= 22）', 'TRANSPORT')
  }
  const url = messagesUrl(route.baseUrl)
  const headers = route.buildHeaders({ stream: true, ...(options.headers === undefined ? {} : { extra: options.headers }) })
  const body = JSON.stringify({ ...request, stream: true })
  const composed = createRequestSignal(options.signal, timeoutMs)

  /** @type {Response} */
  let response
  try {
    response = await fetchImpl(url, { method: 'POST', headers, body, signal: composed.signal })
  } catch (/** @type {any} */ error) {
    if (composed.timedOut()) {
      throw new PlanClientError(`计划端点请求超时（${timeoutMs}ms）：${url}`, 'TIMEOUT')
    }
    if (options.signal?.aborted === true) {
      throw new PlanClientError(`计划端点请求已取消：${error?.message ?? String(error)}`, 'ABORTED')
    }
    throw new PlanClientError(`计划端点请求失败（${url}）：${error?.message ?? String(error)}`, 'TRANSPORT')
  }

  try {
    if (!response.ok) {
      const detail = classifyPlanError(response.status, await readBodyText(response))
      throw errorForDetail(detail)
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (contentType.includes('text/event-stream')) {
      yield* pumpSse(response)
      return
    }

    // 非 SSE：可能是一次性 JSON 成功响应，也可能是 200 包装的业务错误。
    const text = await readBodyText(response)
    if (looksLikeSse(text)) {
      yield* pumpSse(text)
      return
    }
    /** @type {any} */
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new PlanClientError(`计划端点返回了无法解析的 body：${text.slice(0, 200)}`, 'BAD_RESPONSE')
    }
    const envelope = parseErrorEnvelope(text)
    if (envelope !== undefined && (envelope.code !== undefined || envelope.message !== '')) {
      throw errorForDetail(classifyPlanError(response.status, text))
    }
    if (payload !== null && typeof payload === 'object' && Array.isArray(payload.content)) {
      for (const event of translateMessage(payload)) yield event
      return
    }
    throw new PlanClientError(`计划端点返回了未预期的 body：${text.slice(0, 200)}`, 'BAD_RESPONSE')
  } finally {
    composed.dispose()
  }
}

/**
 * 把 SSE 字节流泵成统一事件。
 *
 * @param {Response | string} source 上游响应（或已读到的 SSE 文本）。
 * @returns {AsyncGenerator<PlanStreamEvent, void, unknown>} 统一事件流。
 */
async function* pumpSse(source) {
  const parser = createSseParser()
  const translator = createAnthropicTranslator()

  /**
   * @param {SseEvent[]} events 一批 SSE 事件。
   * @returns {PlanStreamEvent[]} 翻译结果。
   */
  const translateAll = (events) => {
    /** @type {PlanStreamEvent[]} */
    const out = []
    for (const event of events) out.push(...translator.push(event))
    return out
  }

  if (typeof source === 'string') {
    for (const event of translateAll(parser.push(source))) yield event
    for (const event of translateAll(parser.flush())) yield event
    if (translator.failure !== undefined) throw errorForDetail(translator.failure)
    if (!translator.finished) yield { type: 'done', stopReason: null }
    return
  }

  const reader = source.body?.getReader()
  if (reader === undefined) {
    // body 为空（例如 204）：当作上游没给内容。
    throw new PlanClientError('计划端点响应没有可读的事件流 body', 'BAD_RESPONSE')
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) {
        for (const event of translateAll(parser.push(value))) yield event
      }
      if (translator.failure !== undefined) break
    }
    if (translator.failure === undefined) {
      for (const event of translateAll(parser.flush())) yield event
    }
    if (translator.failure !== undefined) throw errorForDetail(translator.failure)
    if (!translator.finished) yield { type: 'done', stopReason: null }
  } finally {
    // 消费方提前 return / 抛错时把连接放掉，别把上游留成悬挂连接。
    try {
      await reader.cancel()
    } catch {
      /* 已关闭的流 cancel 会抛，忽略 */
    }
  }
}

/**
 * 哪些失败值得换下一条路由。
 *
 * 判据是「换一条路由**可能**就好了」：
 * - `QUOTA` / `CONCURRENCY`：这条套餐的额度/并发满了，另一条套餐未必满 —— 这就是自动切换的
 *   主要场景；
 * - `AUTH` / `TOKEN_MISSING` / `API_KEY_MISSING` / `CARD_ID_MISSING`：这条路由的凭证形态
 *   缺了（例如没登录 bigmodel、没有高速卡），别的路由可能齐全；
 * - `UPSTREAM`（5xx）/ `TRANSPORT` / `TIMEOUT`：上游或网络抖了，换端点有意义。
 *
 * 明确**不**切换的：
 * - `PARAM`：请求体本身有问题（模型 id 不被接受、图片格式不对），换端点只会得到同样的
 *   400，还会把真正的原因藏起来；
 * - `ABORTED`：用户取消，必须立刻停；
 * - `BAD_RESPONSE`：上游返回了我们解析不了的东西，换端点同样无法保证，且掩盖问题。
 *
 * @type {ReadonlySet<string>}
 */
const FAILOVER_CODES = new Set([
  'QUOTA',
  'CONCURRENCY',
  'AUTH',
  'TOKEN_MISSING',
  'API_KEY_MISSING',
  'CARD_ID_MISSING',
  'UPSTREAM',
  'TRANSPORT',
  'TIMEOUT',
])

/**
 * 判断一个错误是否值得换路由重试。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {boolean} 是否切换。
 */
export function isFailoverError(error) {
  if (error instanceof PlanClientError) {
    if (typeof error.code !== 'string') return false
    return FAILOVER_CODES.has(error.code)
  }
  return false
}

/**
 * 去掉候选链里**实际发出的请求完全相同**的路由，保留优先级最高的一条。
 *
 * 为什么必须去重：`account:zai-start-plan` 与 `account:bigmodel-start-plan` 在实测 release 里
 * 指向**同一个 baseUrl**（`zcode.z.ai/api/v1/zcode-plan/anthropic`），而 `zcodejwttoken` 只有
 * 一个 —— 两条路由拼出来的请求头逐字节相同。同一份凭证、同一个端点、同一个模型，换路由
 * 没有任何意义：必然得到同一个结果，只是多花一次往返。
 *
 * 判据是「请求签名」而不是 providerId：baseUrl + 全部请求头。这样：
 * - start-plan 的两个家族被合并（同端点同 Bearer）；
 * - coding-plan 的 bigmodel / zai 保留（同路径不同 baseUrl，且 api-key 不同）；
 * - offpeak / highspeed 的两个家族各自保留（端点相同，但 api-key 与卡号不同）。
 *
 * `buildHeaders()` 可能抛（`highspeed-card` 没有卡号）：抛的那条无法比较，**保留**它 ——
 * 它在真正请求时会被判为 `CARD_ID_MISSING` 并按普通失败处理，不该在这里被静默丢掉。
 *
 * @param {readonly PlanRoute[]} routes 候选路由链（有序，优先级高的在前）。
 * @returns {PlanRoute[]} 去重后的链，保持原顺序。
 */
export function dedupeRoutes(routes) {
  const list = Array.isArray(routes) ? routes : []
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {PlanRoute[]} */
  const out = []
  for (const route of list) {
    if (route === null || typeof route !== 'object') continue
    /** @type {string} */
    let signature
    try {
      const headers = route.buildHeaders({ stream: true })
      // accept 只区分流式/非流式，同一次请求里恒为 text/event-stream，不参与身份。
      const keys = Object.keys(headers).filter((key) => key !== 'accept').sort()
      signature = `${route.baseUrl}\n${keys.map((key) => `${key}:${headers[key]}`).join('\n')}`
    } catch {
      signature = `unbuildable:${route.providerId}:${out.length}`
    }
    if (seen.has(signature)) continue
    seen.add(signature)
    out.push(route)
  }
  return out
}

/**
 * 按候选链依次尝试路由，直到某一条真正产出内容。
 *
 * merged 模式（一个模型只出现一次）靠这个函数实现「套餐之间自动切换」：候选链由
 * `lib/plan-routes.js` 的 `routesForModel` 给出，按套餐优先级排序（start-plan →
 * coding-plan → offpeak → highspeed）。
 *
 * ## 为什么必须先缓冲
 *
 * 一旦把内容发给 DSH 就不能再换路由了 —— 换了会得到两段互相矛盾的回复。所以这里对每条
 * 路由先**缓冲**事件，直到确认「这条路由真的产出了内容」才放行并转为直通；在此之前失败
 * 一律视为「这条路由不可用」，安静地换下一条。
 *
 * 「产出了内容」的判据是 text / reasoning / tool_use_start 中的任意一个。空流（上游
 * 正常结束但一个内容块都没有）也算这条路由失败，同样换下一条 —— 这与 adapter 对空响应
 * 的处理一致，只是这里还有别的路由可以试。
 *
 * 所有路由都失败时抛最后一个错误（它通常最能说明问题：优先级最低的那条也失败了），
 * 并把整条尝试链挂在 `error.attempts` 上供诊断。
 *
 * @param {readonly PlanRoute[]} routes 候选路由链（有序）。
 * @param {AnthropicMessagesRequest} request Anthropic Messages 请求体。
 * @param {PlanFailoverOptions} [options] 取消/超时/注入/回调。
 * @returns {AsyncGenerator<PlanStreamEvent, void, unknown>} 统一事件流。
 * @throws {PlanClientError} 全部路由失败；`error.attempts` 带完整尝试链。
 */
export async function* streamMessagesAcrossRoutes(routes, request, options = {}) {
  const raw = Array.isArray(routes) ? routes.filter((route) => route !== null && typeof route === 'object') : []
  if (raw.length === 0) {
    throw new PlanClientError('没有可用的计划路由（候选链为空）', 'UNKNOWN_PROVIDER')
  }
  // 去重：两条路由若拼出的请求逐字节相同（同端点、同凭证），换过去只会白跑一趟。
  const chain = dedupeRoutes(raw)
  /** @type {PlanRouteAttempt[]} */
  const attempts = []
  /** @type {unknown} */
  let lastError

  /**
   * @param {PlanRouteAttempt} attempt 本次尝试结果。
   */
  const record = (attempt) => {
    attempts.push(attempt)
    try {
      options.onAttempt?.(attempt)
    } catch {
      /* 回调自己的异常不该影响通道 */
    }
  }

  for (let position = 0; position < chain.length; position += 1) {
    const route = chain[position]
    const isLast = position === chain.length - 1
    /** @type {PlanStreamEvent[]} */
    let buffered = []
    let committed = false
    /** @type {string | null} */
    let stopReason = null
    let sawContent = false

    try {
      for await (const event of streamMessages(route, request, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      })) {
        if (event.type === 'done') {
          stopReason = event.stopReason
          continue
        }
        if (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool_use_start') {
          sawContent = true
          if (!committed) {
            // 第一条内容事件出现：这条路由成功了，把缓冲一次性放出去，之后直通。
            committed = true
            for (const pending of buffered) yield pending
            buffered = []
          }
        }
        if (committed) yield event
        else buffered.push(event)
      }
    } catch (/** @type {any} */ error) {
      const failover = !committed && !isLast && isFailoverError(error)
      record({
        providerId: route.providerId,
        baseUrl: route.baseUrl,
        ok: false,
        code: typeof error?.code === 'string' ? error.code : 'UPSTREAM',
        message: error?.message === undefined ? String(error) : String(error.message),
        failover,
      })
      if (!failover) {
        if (error instanceof PlanClientError && attempts.length > 1) error.attempts = attempts
        throw error
      }
      lastError = error
      continue
    }

    if (!sawContent) {
      // 上游正常结束但一个内容块都没有。还有下一条路由就换它；没有下一条时**不**在这里抛 ——
      // 把 `done` 交回上层，由 adapter 统一报 `EMPTY_RESPONSE`（那是 DSH 认识的重试码，
      // 在这里换成 BAD_RESPONSE 反而丢掉了这个更精确的语义）。
      record({
        providerId: route.providerId,
        baseUrl: route.baseUrl,
        ok: false,
        code: 'EMPTY_RESPONSE',
        message: '计划端点返回了空响应（没有任何内容块）',
        failover: !isLast,
      })
      if (!isLast) continue
      yield { type: 'done', stopReason }
      return
    }

    record({ providerId: route.providerId, baseUrl: route.baseUrl, ok: true })
    yield { type: 'done', stopReason }
    return
  }

  // 走到这里说明所有路由都以「不可切换」以外的原因失败了，且最后一条也没成功。
  if (lastError instanceof PlanClientError) {
    lastError.attempts = attempts
    throw lastError
  }
  const exhausted = new PlanClientError('所有候选计划路由都不可用', 'UPSTREAM')
  exhausted.attempts = attempts
  throw exhausted
}
