/**
 * ZCode 账号的**登录授权**（设备码 OAuth），以及由此得到的凭证落地。
 *
 * 这个模块让插件**完全脱离 ZCode 客户端**自己完成登录：用户在浏览器里打开一个 URL 并确认，
 * 插件在本地轮询，拿回 `zcodejwttoken` 与家族会话 token。它不启动任何子进程、不需要本地
 * 监听端口、不需要注册自定义 URL scheme。
 *
 * ## 为什么是这条流程
 *
 * 用户的诉求是「像 trae / workbuddy 那样登录授权」，而 ZCode 桌面端自己就有两条授权路径：
 *
 * | | CLI/设备码模式（**本模块**） | 桌面 GUI 回调模式（**不用**） |
 * |---|---|---|
 * | authorize | `https://chat.z.ai/api/oauth/authorize` | 同 |
 * | `redirect_uri` | `https://zcode.z.ai/api/v1/oauth/cli/callback/<family>` | `zcode://oauth/callback` |
 * | 取 token | `GET /api/v1/oauth/cli/poll/{flow_id}` | `POST /api/v1/oauth/token` |
 * | 需要本地监听 | **否** | 是（Electron 注册 `zcode://`） |
 *
 * 桌面模式要求 `redirect_uri=zcode://oauth/callback`，插件无法注册该 scheme，所以只有设备码
 * 模式可行。它与 RFC 8628 的设备码**形似而不同**：ZCode 用自定义的 `flow_id` + `poll_token`
 * 语义，整个 bundle 里 `device_code` 零命中。
 *
 * ## 三步流程（全部实测于 2026-10-27，客户端 3.16.3）
 *
 * 1. **发起** `POST {origin}/api/v1/oauth/cli/init`
 *
 *    ```
 *    Authorization: Bearer <pollToken>       # crypto.randomBytes(32).toString('hex')，64 字符
 *    Content-Type: application/json
 *    {"provider":"zai"}                      # 只接受 "zai" | "bigmodel"；非法值 → 500 code:1000
 *    ```
 *
 *    返回 `{code:0, data:{flow_id, poll_token, authorize_url, expires_at, poll_interval_sec}}`。
 *    `authorize_url` 已带齐全部参数，调用方**直接打开**，不要自己拼。
 *
 * 2. **轮询** `GET {origin}/api/v1/oauth/cli/poll/{urlencode(flow_id)}`（同一个 Bearer）
 *
 *    ```
 *    {"data":{"status":"pending"}}
 *    {"data":{"status":"failed"}}
 *    {"data":{"status":"ready", "token":"<zcodejwttoken>", "user":{...}, "zai":{access_token, refresh_token?}}}
 *    ```
 *
 *    注意 `data[providerId]` 的 key 是**本次请求的 provider**，不是固定 `"zai"`。
 *    `3004 invalid_flow` 不可重试；408/429/5xx 可重试。
 *
 * 3. **落地**：`data.token` → `zcodejwttoken`；`data[providerId].access_token` →
 *    `oauth:<providerId>:access_token`。
 *
 * ## 关键事实：`zcodejwttoken` 是直接给的，不是换来的
 *
 * 常见误解是「先拿 access_token 再换 zcodejwttoken」。实际上 `poll` 的 `ready` 响应**同时**
 * 给出两者。而 `codingPlanApiKey`（bigmodel coding-plan 路由用的 `x-api-key`）是**另一条链路**，
 * 见 {@link resolveCodingPlanMaterial}。
 *
 * ## 凭证落地位置
 *
 * **绝不写回 ZCode 客户端的 `credentials.json`**：客户端的 `mutateRawCredentialRecord` 是进程内
 * 锁的「整文件读—改—写」，外部写入会被下一次客户端写入覆盖，反过来也可能被客户端覆盖。
 * 插件把自己拿到的凭证存在 DSH 自己的插件数据目录里（{@link PluginCredentialStore}）。
 *
 * 存储格式与客户端一致（`enc:v1:<iv>.<tag>.<data>`，AES-256-GCM），这样两边的解密逻辑可以复用；
 * 密钥是**纯机器指纹**，见 {@link credentialSecret}。
 *
 * @module lib/plan-auth
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { homedir, platform, userInfo } from 'node:os'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 默认端点 origin（与客户端 `resolveZCodeEndpointOrigin` 的默认值一致）。 */
export const DEFAULT_AUTH_ORIGIN = 'https://zcode.z.ai'

/** 授权流程只接受这两个家族；服务端会校验枚举。 */
export const AUTH_FAMILIES = Object.freeze(['zai', 'bigmodel'])

/** 生产环境的 Z.AI OAuth client_id（从客户端常量表抄来）。 */
export const ZAI_OAUTH_CLIENT_ID = 'client_P8X5CMWmlaRO9gyO-KSqtg'

/** bigmodel 家族的 `appId`（两个环境相同）。 */
export const BIGMODEL_APP_ID = 'zcode'

/** 客户端给授权流程的总超时：300 秒（`Buc = 300 * 1e3`）。 */
export const DEFAULT_AUTH_TIMEOUT_MS = 300_000

/** 客户端给轮询间隔设的下限：1000ms（`juc`）。 */
export const MIN_POLL_INTERVAL_MS = 1_000

/** 单次 HTTP 请求超时。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

/** 客户端凭证密文前缀。 */
export const ENC_PREFIX = 'enc:v1:'

/** AES-GCM 参数（与客户端一致）。 */
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

/**
 * 授权流程的错误码（稳定机读值，调用方按 `code` 分流）。
 *
 * @typedef {'INVALID_FAMILY' | 'INIT_FAILED' | 'INIT_MALFORMED' | 'POLL_FAILED' | 'POLL_MALFORMED'
 *   | 'FLOW_INVALID' | 'AUTH_FAILED' | 'AUTH_TIMEOUT' | 'NETWORK' | 'TIMEOUT'
 *   | 'INVALID_RESPONSE' | 'CREDENTIAL_STORE' } AuthErrorCode
 */
export const AUTH_ERROR_CODES = /** @type {const} */ ([
  'INVALID_FAMILY',
  'INIT_FAILED',
  'INIT_MALFORMED',
  'POLL_FAILED',
  'POLL_MALFORMED',
  'FLOW_INVALID',
  'AUTH_FAILED',
  'AUTH_TIMEOUT',
  'NETWORK',
  'TIMEOUT',
  'INVALID_RESPONSE',
  'CREDENTIAL_STORE',
])

/**
 * 授权流程失败。`code` 是稳定机读值；`httpStatus` / `businessCode` 保留上游原始信息。
 */
export class PlanAuthError extends Error {
  /**
   * @param {string} message 人类可读描述。
   * @param {AuthErrorCode} code 稳定机读错误码。
   * @param {{ httpStatus?: number, businessCode?: number, retryable?: boolean }} [detail] 上游详情。
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'PlanAuthError'
    this.code = code
    if (detail.httpStatus !== undefined) this.httpStatus = detail.httpStatus
    if (detail.businessCode !== undefined) this.businessCode = detail.businessCode
    if (detail.retryable !== undefined) this.retryable = detail.retryable
  }
}

// ── 纯函数：可单测的部分 ───────────────────────────────────────────────────────

/**
 * 生成一次授权流程的 pollToken。
 *
 * 客户端：`randomBytes(32).toString('hex')` → 64 字符小写 hex。这个值是整段流程里唯一的身份，
 * 谁持有它谁就能取走 `ready` 后的 token，所以**只留在进程内**，不落盘、不写日志。
 *
 * @param {() => Buffer} [randomBytesImpl] 测试注入。
 * @returns {string} 64 字符 hex。
 */
export function createPollToken(randomBytesImpl = () => randomBytes(32)) {
  return randomBytesImpl().toString('hex')
}

/**
 * 校验并归一 family。
 *
 * @param {unknown} family 待校验值。
 * @returns {'zai' | 'bigmodel'} 归一后的 family。
 * @throws {PlanAuthError} 非法取值时抛出（`INVALID_FAMILY`）。
 */
export function normalizeFamily(family) {
  if (family === 'zai' || family === 'bigmodel') return family
  throw new PlanAuthError(
    `ZCode 授权只支持 zai / bigmodel 两个家族（收到 ${JSON.stringify(family)}）；服务端也会拒绝其它取值`,
    'INVALID_FAMILY',
  )
}

/**
 * `init` 请求的 URL。
 *
 * @param {string} [origin] 端点 origin，默认 {@link DEFAULT_AUTH_ORIGIN}。
 * @returns {string} 绝对 URL。
 */
export function initUrl(origin = DEFAULT_AUTH_ORIGIN) {
  return `${stripTrailingSlash(origin)}/api/v1/oauth/cli/init`
}

/**
 * `poll` 请求的 URL。`flow_id` 必须 URL 编码后拼进路径。
 *
 * @param {string} flowId 流程 id。
 * @param {string} [origin] 端点 origin。
 * @returns {string} 绝对 URL。
 */
export function pollUrl(flowId, origin = DEFAULT_AUTH_ORIGIN) {
  return `${stripTrailingSlash(origin)}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`
}

/**
 * 去掉 URL 末尾的斜杠（客户端 `normalizeBaseUrl` 同款）。
 *
 * @param {string} value 原始值。
 * @returns {string} 去尾斜杠的结果。
 */
export function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/u, '')
}

/**
 * 解析 `init` 的响应体，做与客户端 `parseInitData` 等价的硬校验。
 *
 * 客户端会拒绝：非 https 的 `authorize_url`、非有限的 `expires_at`、`poll_interval_sec < 1`。
 * 这里全部保留 —— 这些不是防御性编程，而是「拿不到合法值就说明上游变了」的信号。
 *
 * @param {unknown} payload 已 JSON.parse 的响应体。
 * @returns {{ flowId: string, pollToken: string, authorizeUrl: string, expiresAt: number, pollIntervalSec: number }} 归一结果。
 * @throws {PlanAuthError} 信封或字段不合法时抛出（`INIT_MALFORMED` / `INIT_FAILED`）。
 */
export function parseInitPayload(payload) {
  const envelope = asRecord(payload)
  const code = envelope?.code
  if (typeof code === 'number' && code !== 0) {
    throw new PlanAuthError(
      `ZCode 授权发起失败：code=${code}${typeof envelope?.msg === 'string' && envelope.msg.trim() !== '' ? ` ${envelope.msg.trim()}` : ''}`,
      'INIT_FAILED',
      { businessCode: code },
    )
  }
  const data = asRecord(envelope?.data)
  const flowId = readString(data?.flow_id)
  const pollToken = readString(data?.poll_token)
  const authorizeUrl = readString(data?.authorize_url)
  const expiresAt = data?.expires_at
  const pollIntervalSec = data?.poll_interval_sec
  if (flowId === undefined) throw new PlanAuthError('ZCode 授权响应缺少 flow_id', 'INIT_MALFORMED')
  if (authorizeUrl === undefined) throw new PlanAuthError('ZCode 授权响应缺少 authorize_url', 'INIT_MALFORMED')
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new PlanAuthError('ZCode 授权响应缺少合法的 expires_at', 'INIT_MALFORMED')
  }
  if (typeof pollIntervalSec !== 'number' || !Number.isFinite(pollIntervalSec) || pollIntervalSec < 1) {
    throw new PlanAuthError('ZCode 授权响应缺少合法的 poll_interval_sec', 'INIT_MALFORMED')
  }
  // 客户端硬校验：authorize_url 必须是 https。放宽它就等于允许把用户送去一个明文地址。
  let protocol
  try {
    protocol = new URL(authorizeUrl).protocol
  } catch {
    throw new PlanAuthError('ZCode 授权响应里的 authorize_url 不是合法 URL', 'INIT_MALFORMED')
  }
  if (protocol !== 'https:') {
    throw new PlanAuthError(`ZCode 授权响应里的 authorize_url 不是 https（${protocol}）`, 'INIT_MALFORMED')
  }
  return {
    flowId,
    pollToken: pollToken ?? '',
    authorizeUrl,
    expiresAt,
    pollIntervalSec,
  }
}

/**
 * 解析 `poll` 的响应体。
 *
 * `ready` 的结构按客户端 `parseReadyData` 还原，并且**兼容驼峰写法**（客户端两种都接受）：
 * `data.token` 必须有，`data.user.user_id` 必须有，`data[providerId].access_token` 必须有。
 *
 * @param {unknown} payload 已 JSON.parse 的响应体。
 * @param {'zai' | 'bigmodel'} family 本次流程的家族（决定 `data[family]` 的 key）。
 * @returns {{ status: 'pending' } | { status: 'failed' }
 *   | { status: 'ready', token: string, user: AuthUser, accessToken: string, refreshToken?: string }} 归一结果。
 * @throws {PlanAuthError} 信封或字段不合法时抛出（`POLL_MALFORMED` / `POLL_FAILED` / `FLOW_INVALID`）。
 */
export function parsePollPayload(payload, family) {
  const envelope = asRecord(payload)
  const code = envelope?.code
  if (typeof code === 'number' && code !== 0) {
    // 3004 invalid_flow：flow 过期或不存在，不可重试，必须重新 init。
    const retryable = code !== 3004
    throw new PlanAuthError(
      code === 3004
        ? 'ZCode 授权流程已失效（invalid_flow），请重新发起登录'
        : `ZCode 授权轮询失败：code=${code}${typeof envelope?.msg === 'string' && envelope.msg.trim() !== '' ? ` ${envelope.msg.trim()}` : ''}`,
      code === 3004 ? 'FLOW_INVALID' : 'POLL_FAILED',
      { businessCode: code, retryable },
    )
  }
  const data = asRecord(envelope?.data)
  const status = readString(data?.status)
  if (status === 'pending') return { status: 'pending' }
  if (status === 'failed') return { status: 'failed' }
  if (status !== 'ready') {
    throw new PlanAuthError(
      `ZCode 授权轮询返回了未知状态 ${JSON.stringify(status)}`,
      'POLL_MALFORMED',
    )
  }
  const token = readString(data?.token)
  const userRecord = asRecord(data?.user)
  const userId = readString(userRecord?.user_id)
  const familyRecord = asRecord(data?.[family])
  const accessToken = readString(familyRecord?.access_token) ?? readString(familyRecord?.accessToken)
  const refreshToken = readString(familyRecord?.refresh_token) ?? readString(familyRecord?.refreshToken)
  if (token === undefined) throw new PlanAuthError('ZCode 授权响应缺少 data.token', 'POLL_MALFORMED')
  if (userId === undefined) throw new PlanAuthError('ZCode 授权响应缺少 data.user.user_id', 'POLL_MALFORMED')
  if (accessToken === undefined) {
    throw new PlanAuthError(
      `ZCode 授权响应缺少 data.${family}.access_token`,
      'POLL_MALFORMED',
    )
  }
  /** @type {AuthUser} */
  const user = { userId }
  const name = readString(userRecord?.name)
  const email = readString(userRecord?.email)
  const avatar = readString(userRecord?.avatar)
  if (name !== undefined) user.name = name
  if (email !== undefined) user.email = email
  if (avatar !== undefined) user.avatar = avatar
  return {
    status: 'ready',
    token,
    user,
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  }
}

/**
 * 把一次 `ready` 结果翻译成 credentials.json 形状的键值对。
 *
 * 键名与 ZCode 客户端完全一致，这样 {@link encryptCredentialRecord} 写出的文件客户端也能读，
 * 反过来插件的 `lib/credentials.js` 也能读客户端写的文件。
 *
 * @param {{ token: string, user: AuthUser, accessToken: string, refreshToken?: string }} ready 归一后的 ready 结果。
 * @param {'zai' | 'bigmodel'} family 家族。
 * @returns {Record<string, string>} 键 → 明文值。
 */
export function toCredentialRecord(ready, family) {
  /** @type {Record<string, string>} */
  const record = {
    zcodejwttoken: ready.token,
    'oauth:active_provider': family,
    [`oauth:${family}:access_token`]: ready.accessToken,
    [`oauth:${family}:user_info`]: JSON.stringify({
      user_id: ready.user.userId,
      ...(ready.user.name === undefined ? {} : { name: ready.user.name }),
      ...(ready.user.email === undefined ? {} : { email: ready.user.email }),
      ...(ready.user.avatar === undefined ? {} : { avatar: ready.user.avatar }),
    }),
  }
  if (ready.refreshToken !== undefined) {
    record[`oauth:${family}:refresh_token`] = ready.refreshToken
  }
  return record
}

/**
 * 轮询调度：给定一次轮询函数，按客户端策略循环到 ready / failed / 超时。
 *
 * 从客户端 `pollUntilReady` 照抄的语义：
 * - 间隔 = `max(1000, poll_interval_sec * 1000)`
 * - 截止 = `min(now + timeoutMs, expires_at * 1000)`
 * - 只吞 408 / 429 / 5xx 的 HTTP 错误，其余直接抛
 * - `failed` → `AUTH_FAILED`；超时 → `AUTH_TIMEOUT`
 *
 * @param {object} input 调度参数。
 * @param {() => Promise<Awaited<ReturnType<typeof parsePollPayload>>>} input.poll 单次轮询。
 * @param {number} input.expiresAt 流程过期时间（Unix 秒）。
 * @param {number} input.pollIntervalSec 服务端建议间隔（秒）。
 * @param {number} [input.timeoutMs] 总超时，默认 {@link DEFAULT_AUTH_TIMEOUT_MS}。
 * @param {() => number} [input.now] 时钟注入。
 * @param {(ms: number) => Promise<void>} [input.sleep] 睡眠注入。
 * @param {AbortSignal} [input.signal] 中止信号。
 * @returns {Promise<{ token: string, user: AuthUser, accessToken: string, refreshToken?: string }>} ready 结果。
 * @throws {PlanAuthError} 失败、超时或中止时抛出。
 */
export async function pollUntilReady({
  poll,
  expiresAt,
  pollIntervalSec,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  now = Date.now,
  sleep = defaultSleep,
  signal,
}) {
  const startedAt = now()
  const deadline = Math.min(startedAt + timeoutMs, expiresAt * 1000)
  const interval = Math.max(MIN_POLL_INTERVAL_MS, pollIntervalSec * 1_000)
  while (now() < deadline) {
    throwIfAborted(signal)
    /** @type {Awaited<ReturnType<typeof parsePollPayload>> | undefined} */
    let result
    try {
      result = await poll()
    } catch (error) {
      if (isAbortError(error) || signal?.aborted === true) throw abortError()
      if (error instanceof PlanAuthError) {
        // 只有 408 / 429 / 5xx 可重试；3004（FLOW_INVALID）与字段不合法都必须立刻失败。
        const retryable = error.retryable === true
          || error.httpStatus === 408
          || error.httpStatus === 429
          || (error.httpStatus ?? 0) >= 500
        if (!retryable) throw error
      } else {
        throw error
      }
      result = undefined
    }
    if (result !== undefined) {
      if (result.status === 'ready') {
        return {
          token: result.token,
          user: result.user,
          accessToken: result.accessToken,
          ...(result.refreshToken === undefined ? {} : { refreshToken: result.refreshToken }),
        }
      }
      if (result.status === 'failed') {
        throw new PlanAuthError('ZCode 授权被拒绝或已失败，请重新发起登录', 'AUTH_FAILED')
      }
    }
    const remaining = deadline - now()
    if (remaining <= 0) break
    await sleep(Math.min(interval, remaining))
  }
  throw new PlanAuthError(
    `ZCode 授权超时（${Math.round((deadline - startedAt) / 1000)} 秒内未完成）`,
    'AUTH_TIMEOUT',
  )
}

// ── 凭证加解密（与 ZCode 客户端完全同构） ────────────────────────────────────────

/**
 * 复刻客户端的 `resolveCredentialSecret`：优先 `ZCODE_CREDENTIAL_SECRET`，否则纯机器指纹。
 *
 * 安全提示：这个方案**不是**操作系统级保护 —— 同一台机器上任何以该用户身份运行的进程都能
 * 推出同一把密钥。它防的是「文件被单独拷走」，防不了「同机同用户」。这里保持一致是为了让
 * 插件与客户端能互读同一个文件；不要把它当成安全的密钥保管方案。
 *
 * @param {string} [secretOverride] 显式密钥（测试用）。
 * @returns {string} 参与 AES 密钥派生的原始材料。
 */
export function credentialSecret(secretOverride) {
  const fromEnv = secretOverride ?? process.env.ZCODE_CREDENTIAL_SECRET
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  let username = 'unknown'
  try {
    username = userInfo().username
  } catch {
    /* 用户名不可得时与客户端一致地降级 */
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`
}

/**
 * AES-256-GCM 密钥：`SHA-256(secret)`（单轮，无 salt，与客户端 `deriveCipherKey` 一致）。
 *
 * @param {string} [secret] 密钥材料，默认 {@link credentialSecret}。
 * @returns {Buffer} 32 字节密钥。
 */
export function deriveKey(secret = credentialSecret()) {
  return createHash('sha256').update(secret).digest()
}

/**
 * 加密一个明文值 → `enc:v1:<iv>.<tag>.<data>`（三段 base64url）。
 *
 * 这是客户端 `encryptString` 的等价实现。空串与 `undefined` 原样返回，不加密。
 *
 * @param {string} plaintext 明文。
 * @param {Buffer} [key] AES 密钥，默认 {@link deriveKey}。
 * @returns {string} 密文信封。
 */
export function encryptValue(plaintext, key = deriveKey()) {
  if (typeof plaintext !== 'string' || plaintext === '') return plaintext
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${data.toString('base64url')}`
}

/**
 * 解密一个 `enc:v1:` 值；非密文原样返回。
 *
 * @param {unknown} value 存储值。
 * @param {Buffer} [key] AES 密钥。
 * @returns {string | null} 明文；解密失败返回 `null`（不抛，单条失败不影响其它条目）。
 */
export function decryptValue(value, key = deriveKey()) {
  if (typeof value !== 'string') return null
  if (!value.startsWith(ENC_PREFIX)) return value
  const parts = value.slice(ENC_PREFIX.length).split('.')
  if (parts.length !== 3) return null
  const [ivB64, tagB64, dataB64] = parts
  const iv = Buffer.from(ivB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  const data = Buffer.from(dataB64, 'base64url')
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) return null
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * 把明文记录整份加密成 credentials.json 形状。
 *
 * @param {Record<string, string>} record 键 → 明文。
 * @param {Buffer} [key] AES 密钥。
 * @returns {Record<string, string>} 键 → `enc:v1:` 密文。
 */
export function encryptCredentialRecord(record, key = deriveKey()) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [entryKey, entryValue] of Object.entries(record)) {
    out[entryKey] = encryptValue(entryValue, key)
  }
  return out
}

// ── 插件自有的凭证存储 ──────────────────────────────────────────────────────────

/**
 * 插件自己的凭证文件（**不碰** ZCode 客户端的 credentials.json）。
 *
 * 为什么另存一份：客户端的写入是进程内锁的「整文件读—改—写」。插件从外部写同一个文件，
 * 要么被客户端下一次写入覆盖，要么覆盖掉客户端刚写进去的条目 —— 两边都不可靠。插件只需要
 * `zcodejwttoken` + 家族 token + user_info，存自己的文件最干净。
 *
 * 文件格式与客户端一致（JSON + `enc:v1:` 密文），所以解密逻辑完全复用 {@link decryptValue}。
 */
export class PluginCredentialStore {
  /**
   * @param {object} options 存储参数。
   * @param {string} options.filePath 凭证文件绝对路径。
   * @param {Buffer} [options.key] AES 密钥，默认 {@link deriveKey}。
   * @param {boolean} [options.encrypt] 是否加密落盘，默认 `true`。
   */
  constructor({ filePath, key = deriveKey(), encrypt = true }) {
    this.filePath = filePath
    this.key = key
    this.encrypt = encrypt
  }

  /**
   * 读取并解密全部条目。
   *
   * @returns {Record<string, string>} 键 → 明文；文件不存在时返回 `{}`。
   * @throws {PlanAuthError} 文件存在但无法解析时抛出（`CREDENTIAL_STORE`）。
   */
  read() {
    /** @type {string} */
    let text
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch (/** @type {any} */ error) {
      if (error?.code === 'ENOENT') return {}
      throw new PlanAuthError(`插件凭证文件读取失败：${this.filePath}：${error?.message ?? error}`, 'CREDENTIAL_STORE')
    }
    /** @type {unknown} */
    let raw
    try {
      raw = JSON.parse(text)
    } catch (/** @type {any} */ error) {
      throw new PlanAuthError(`插件凭证文件不是合法 JSON：${this.filePath}：${error?.message ?? error}`, 'CREDENTIAL_STORE')
    }
    const record = asRecord(raw)
    if (record === undefined) {
      throw new PlanAuthError(`插件凭证文件不是对象：${this.filePath}`, 'CREDENTIAL_STORE')
    }
    /** @type {Record<string, string>} */
    const out = {}
    for (const [entryKey, entryValue] of Object.entries(record)) {
      const plain = decryptValue(entryValue, this.key)
      if (plain !== null) out[entryKey] = plain
    }
    return out
  }

  /**
   * 合并写入（读旧值 → 覆盖本次条目 → 原子替换）。
   *
   * 先写临时文件再 `rename`，避免进程在写一半时被杀导致文件损坏。
   *
   * @param {Record<string, string>} patch 要写入的明文条目。
   * @returns {Record<string, string>} 合并后的明文全量。
   * @throws {PlanAuthError} 写入失败时抛出（`CREDENTIAL_STORE`）。
   */
  merge(patch) {
    const existing = this.read()
    const merged = { ...existing, ...patch }
    const payload = this.encrypt ? encryptCredentialRecord(merged, this.key) : merged
    const tempPath = `${this.filePath}.tmp`
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tempPath, this.filePath)
    } catch (/** @type {any} */ error) {
      throw new PlanAuthError(`插件凭证文件写入失败：${this.filePath}：${error?.message ?? error}`, 'CREDENTIAL_STORE')
    }
    return merged
  }
}

// ── HTTP 客户端（注入式，便于单测） ─────────────────────────────────────────────

/**
 * 发起一次授权流程，返回 `authorize_url` 与一个 `poll()` 句柄。
 *
 * 调用方负责把 `authorizeUrl` 呈现给用户（浏览器 / 二维码 / 终端链接），然后反复调用
 * `poll()`，或者直接把它交给 {@link pollUntilReady}。
 *
 * @param {object} [options] 参数。
 * @param {'zai' | 'bigmodel'} [options.family] 家族，默认 `'zai'`。
 * @param {string} [options.origin] 端点 origin，默认 {@link DEFAULT_AUTH_ORIGIN}。
 * @param {number} [options.timeoutMs] 单次请求超时。
 * @param {typeof fetch} [options.fetchImpl] fetch 注入（单测用）。
 * @param {() => Buffer} [options.randomBytesImpl] 随机源注入（单测用）。
 * @param {AbortSignal} [options.signal] 中止信号。
 * @returns {Promise<{ family: 'zai' | 'bigmodel', flowId: string, authorizeUrl: string, expiresAt: number,
 *   pollIntervalSec: number, poll: () => Promise<Awaited<ReturnType<typeof parsePollPayload>>> }>} 流程句柄。
 * @throws {PlanAuthError} 发起失败时抛出。
 */
export async function startDeviceAuthorization(options = {}) {
  const {
    origin = DEFAULT_AUTH_ORIGIN,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    randomBytesImpl,
    signal,
  } = options
  const family = normalizeFamily(options.family ?? 'zai')
  const pollToken = createPollToken(randomBytesImpl)
  const response = await requestJson(fetchImpl, initUrl(origin), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${pollToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ provider: family }),
    timeoutMs,
    signal,
  })
  const init = parseInitPayload(response)
  return {
    family,
    flowId: init.flowId,
    authorizeUrl: init.authorizeUrl,
    expiresAt: init.expiresAt,
    pollIntervalSec: init.pollIntervalSec,
    poll: async () => {
      const polled = await requestJson(fetchImpl, pollUrl(init.flowId, origin), {
        method: 'GET',
        headers: { authorization: `Bearer ${pollToken}`, accept: 'application/json' },
        timeoutMs,
        signal,
      })
      return parsePollPayload(polled, family)
    },
  }
}

/**
 * 端到端登录：发起 → 呈现 `authorize_url` → 轮询到 ready。
 *
 * @param {object} options 参数。
 * @param {'zai' | 'bigmodel'} [options.family] 家族。
 * @param {string} [options.origin] 端点 origin。
 * @param {(url: string) => void | Promise<void>} [options.onAuthorizeUrl] 拿到授权地址时回调（给 UI 用）。
 * @param {(state: { status: string }) => void} [options.onPollStatus] 每次轮询回调。
 * @param {number} [options.timeoutMs] 总超时。
 * @param {typeof fetch} [options.fetchImpl] fetch 注入。
 * @param {AbortSignal} [options.signal] 中止信号。
 * @param {() => number} [options.now] 时钟注入。
 * @param {(ms: number) => Promise<void>} [options.sleep] 睡眠注入。
 * @returns {Promise<{ family: 'zai' | 'bigmodel', token: string, user: AuthUser, accessToken: string,
 *   refreshToken?: string, credentials: Record<string, string> }>} 登录结果与可落盘的凭证条目。
 * @throws {PlanAuthError} 登录失败时抛出。
 */
export async function loginDeviceFlow(options = {}) {
  const flow = await startDeviceAuthorization(options)
  await options.onAuthorizeUrl?.(flow.authorizeUrl)
  const ready = await pollUntilReady({
    poll: async () => {
      const result = await flow.poll()
      options.onPollStatus?.({ status: result.status })
      return result
    },
    expiresAt: flow.expiresAt,
    pollIntervalSec: flow.pollIntervalSec,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return {
    family: flow.family,
    ...ready,
    credentials: toCredentialRecord(ready, flow.family),
  }
}

/**
 * 一次 JSON 请求，带超时、中止与信封解析。
 *
 * @param {typeof fetch} fetchImpl fetch 实现。
 * @param {string} url 绝对 URL。
 * @param {{ method: string, headers: Record<string, string>, body?: string, timeoutMs: number, signal?: AbortSignal }} init 请求参数。
 * @returns {Promise<unknown>} 已解析的响应体。
 * @throws {PlanAuthError} 网络、超时、HTTP 状态或 JSON 解析失败时抛出。
 */
export async function requestJson(fetchImpl, url, init) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs)
  const signal = init.signal === undefined ? controller.signal : anySignal([init.signal, controller.signal])
  /** @type {Response} */
  let response
  try {
    response = await fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal,
    })
  } catch (/** @type {any} */ error) {
    clearTimeout(timer)
    if (isAbortError(error)) {
      throw new PlanAuthError(`ZCode 授权请求超时（${init.timeoutMs}ms）：${init.method} ${url}`, 'TIMEOUT')
    }
    throw new PlanAuthError(
      `ZCode 授权请求失败：${init.method} ${url}：${error?.cause?.code ?? error?.message ?? error}`,
      'NETWORK',
    )
  }
  /** @type {string} */
  let text
  try {
    text = await response.text()
  } catch (/** @type {any} */ error) {
    clearTimeout(timer)
    throw new PlanAuthError(`ZCode 授权响应读取失败：${error?.message ?? error}`, 'NETWORK')
  }
  clearTimeout(timer)
  /** @type {unknown} */
  let parsed
  try {
    parsed = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new PlanAuthError(
      `ZCode 授权响应不是合法 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`,
      'INVALID_RESPONSE',
      { httpStatus: response.status },
    )
  }
  if (!response.ok) {
    const envelope = asRecord(parsed)
    const businessCode = typeof envelope?.code === 'number' ? envelope.code : undefined
    const message = typeof envelope?.msg === 'string' && envelope.msg.trim() !== ''
      ? envelope.msg.trim()
      : text.slice(0, 200)
    throw new PlanAuthError(
      `ZCode 授权请求被拒绝（HTTP ${response.status}${businessCode === undefined ? '' : `, code=${businessCode}`}）：${message}`,
      'POLL_FAILED',
      { httpStatus: response.status, ...(businessCode === undefined ? {} : { businessCode }) },
    )
  }
  return parsed
}

// ── 小工具 ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} AuthUser
 * @property {string} userId 账号 id。
 * @property {string} [name] 显示名。
 * @property {string} [email] 邮箱。
 * @property {string} [avatar] 头像 URL。
 */

/**
 * 把未知值收敛成对象，非对象返回 `undefined`。
 *
 * @param {unknown} value 任意值。
 * @returns {Record<string, any> | undefined} 对象或 `undefined`。
 */
function asRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return /** @type {Record<string, any>} */ (value)
}

/**
 * 读取一个非空字符串（去空白后），否则 `undefined`。
 *
 * @param {unknown} value 任意值。
 * @returns {string | undefined} 非空字符串或 `undefined`。
 */
function readString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 默认睡眠。
 *
 * @param {number} ms 毫秒。
 * @returns {Promise<void>} 睡眠结束。
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 判断是否为中止类错误。
 *
 * @param {unknown} error 错误。
 * @returns {boolean} 是否中止。
 */
function isAbortError(error) {
  return typeof error === 'object' && error !== null
    && (/** @type {any} */ (error).name === 'AbortError' || /** @type {any} */ (error).name === 'TimeoutError')
}

/**
 * 构造一个中止错误。
 *
 * @returns {PlanAuthError} 中止错误。
 */
function abortError() {
  return new PlanAuthError('ZCode 授权被调用方中止', 'AUTH_TIMEOUT')
}

/**
 * 若信号已中止则抛出。
 *
 * @param {AbortSignal | undefined} signal 信号。
 * @returns {void}
 * @throws {PlanAuthError} 已中止时抛出。
 */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError()
}

/**
 * 合并多个中止信号。
 *
 * @param {AbortSignal[]} signals 信号列表。
 * @returns {AbortSignal} 合并后的信号。
 */
function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}
