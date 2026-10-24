/**
 * ZCode 客户端签名链路（client request signing）。
 *
 * 这个模块把 ZCode 桌面客户端的请求签名机制完整复现出来，使插件可以在
 * **不启动 ZCode agent** 的情况下发出被上游接受的请求。
 *
 * ## 为什么需要它
 *
 * `zcode.z.ai` 的套餐端点有 WAF 做请求签名校验：只带 `Authorization` 会被判成
 * 「异常活动」（`405 / 3012`），必须补齐 `X-Client-*` 一组签名头。这组头的生成逻辑
 * 只在客户端的 agent 二进制里，本模块按实测结果复现了它。
 *
 * ## 链路（全部字段级实测于 2026-10-24，客户端 3.16.3）
 *
 * 1. **换签名凭证**：账户的 OAuth access_token 可以换一个 project 级 signing JWT
 *
 *    ```
 *    POST {origin}/api/biz/v1/organization/{org}/projects/{proj}/api_keys/{apiKeyId}/access_tokens
 *    Authorization: <该账户家族的 access token>
 *    bigmodel-organization / bigmodel-project: <org> / <proj>
 *    body: { clientType: "zcode", clientVersion: "<ver>" }
 *    → { data: { accessToken: "<signing JWT>" } }
 *    ```
 *
 *    signing JWT 的形状固定：header `{typ:JWT, sign_type:SIGN, alg:HS256}`，
 *    payload 含 `api_key` / `token_use`，有效期约 5 小时。
 *
 * 2. **握手换私钥**：用 signing JWT 做一次 HKDF+HMAC 签名的握手，拿回被 AES-GCM
 *    包裹的 Ed25519 私钥
 *
 *    ```
 *    签名消息 = "get_sign_key\n{apiKeyId}\n{ts}\n{nonce}"
 *    HMAC key = HKDF(ikm=signingJwt, salt="WD_CLIENT_SIGN_KDF_SALT", info="getSignKey_hmac")
 *    POST {origin}/api/paas/c1f3a7e2/v2/client
 *    body: { accessToken: <jwt>, nonce, sig: base64(HMAC), ts }
 *    → { data: { privateCipher: "<base64>" } }
 *    ```
 *
 * 3. **解包私钥**：
 *
 *    ```
 *    AES key = HKDF(ikm=signingJwt, salt=SALT, info="ed25519_priv")
 *    iv  = cipherBytes[0..12)；ct = cipherBytes[12..]
 *    pkcs8 = AES-GCM-decrypt(key, iv, ct, aad=apiKeyId)
 *    → importKey("pkcs8", base64(pkcs8), "Ed25519")
 *    ```
 *
 * 4. **签每个业务请求**（headers 必须齐全，缺 `X-Session-Id` 客户端会直接拒绝）：
 *
 *    ```
 *    X-Client-Sig = base64(Ed25519(`${apiKeyId} ${ts} ${clientVersion} ${sessionId} ${nonce}`))
 *    X-Client-Pow = 见 solveProofOfWork
 *    X-Client-Ts / X-Client-Version / X-Client-Nonce / X-Session-Id / X-App-Id="zcode"
 *    ```
 *
 * ## 已知边界（务必先读）
 *
 * 复现成功后，带签名的请求能**穿过 WAF** 抵达业务层（实测返回业务码而不是 403/405）。
 * 但**能否真正消耗套餐额度，取决于 signing JWT 指向的那个套餐是否有效**：
 *
 * - 凭证里 `account-provider:coding-plan:<provider>:...:api-key` 对应的套餐若已过期，
 *   业务层回落 `1309 套餐已到期`，签名再正确也无用；
 * - `zai` 家族（`api.z.ai`）的 project token 需要该家族自己的 access_token，若它已过期
 *   （`oauth:zai:access_token` 常见情况），换不出 signing JWT，这条路由只能由 agent 走。
 *
 * 也就是说：本模块解决的是「怎么签」，不解决「套餐有没有额度」。
 *
 * @module dsh-connect-zcode/client-signing
 */

import { createHash, randomUUID } from 'node:crypto'
import { readCredentials } from './credentials.js'

/** HKDF 的固定 salt，源自客户端实现。 */
const KDF_SALT = 'WD_CLIENT_SIGN_KDF_SALT'
/** 握手签名用的 HKDF info。 */
const INFO_HANDSHAKE = 'getSignKey_hmac'
/** 解包私钥用的 HKDF info。 */
const INFO_PRIVATE_KEY = 'ed25519_priv'
/** 握手端点（相对 origin）。 */
const HANDSHAKE_PATH = '/api/paas/c1f3a7e2/v2/client'
/** 握手动作名，参与签名串。 */
const HANDSHAKE_ACTION = 'get_sign_key'
/** 业务请求的 app id。 */
const APP_ID = 'zcode'
/** PoW 难度：SHA-256 结果的前 8 bit 必须为 0。 */
const POW_BITS = 8
/** PoW 计数器上限，防死循环。 */
const POW_MAX_ITERATIONS = 1 << 22
/** 签名 JWT 提前多少毫秒视为过期，预留握手与请求的时间。 */
const EXPIRY_SKEW_MS = 60_000

const encoder = new TextEncoder()

/**
 * @typedef {object} SigningCredential
 * @property {string} signingJwt 握手用的 signing JWT。
 * @property {string} apiKeyId signing JWT 里的 `api_key`。
 * @property {number} expiresAt 过期时间（毫秒时间戳）。
 * @property {string} origin 该凭证所属的 origin。
 */

/**
 * @typedef {object} SigningSession
 * @property {string} apiKeyId
 * @property {string} origin
 * @property {string} clientVersion
 * @property {any} privateKey Ed25519 私钥（`CryptoKey`，不可导出）。用 any 是为了让
 *   `CryptoKey` 在只做类型检查、没有 DOM lib 的配置下也不被误当成构造函数类型。
 * @property {number} expiresAt signing JWT 的过期时间。
 */

/** @param {Uint8Array} bytes */
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64')

/** @param {string} text */
const fromBase64 = (text) => new Uint8Array(Buffer.from(text, 'base64'))

/**
 * 生成 `n` 字节随机数的十六进制表示。
 *
 * @param {number} n 字节数。
 * @returns {string} 十六进制串。
 */
export function randomHex(n) {
  const bytes = new Uint8Array(n)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * HKDF-SHA256 派生 256 bit。
 *
 * @param {string} ikm 输入密钥材料（即 signing JWT 本体）。
 * @param {string} info HKDF info 字符串。
 * @returns {Promise<Uint8Array>} 派生出的 32 字节。
 */
async function deriveBits(ikm, info) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(KDF_SALT), info: encoder.encode(info) },
    base,
    256,
  )
  return new Uint8Array(bits)
}

/**
 * 判断 SHA-256 结果的前 `bits` 位是否全为 0（与客户端实现一致）。
 *
 * @param {Uint8Array} digest 摘要。
 * @param {number} bits 位数。
 * @returns {boolean} 是否满足。
 */
function hasLeadingZeroBits(digest, bits) {
  const fullBytes = Math.floor(bits / 8)
  for (let i = 0; i < fullBytes; i += 1) {
    if (digest[i] !== 0) return false
  }
  const remainder = bits % 8
  if (remainder === 0) return true
  const mask = (255 << (8 - remainder)) & 255
  return ((digest[fullBytes] ?? 255) & mask) === 0
}

/**
 * 解一次 proof-of-work。
 *
 * 算法：`prefix = hex(sha256("{apiKeyId} {appId} {sessionId} {ts}")).slice(0,32)`，
 * 然后从 12 字节随机 nonce 出发计数，找到使 `sha256("{prefix} {candidate}")` 前
 * {@link POW_BITS} 位为 0 的 candidate。期望约 256 次尝试，实测毫秒级。
 *
 * @param {object} input PoW 参数。
 * @param {string} input.apiKeyId signing JWT 的 `api_key`。
 * @param {string} input.sessionId 本次请求的会话 id。
 * @param {string} input.ts 毫秒时间戳字符串。
 * @returns {Promise<string>} 满足难度的 candidate 串。
 */
export async function solveProofOfWork({ apiKeyId, sessionId, ts }) {
  const seed = createHash('sha256').update(`${apiKeyId} ${APP_ID} ${sessionId} ${ts}`).digest('hex').slice(0, 32)
  const nonce = randomHex(12)
  for (let i = 0; i < POW_MAX_ITERATIONS; i += 1) {
    const candidate = nonce + i.toString(16).padStart(8, '0')
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${seed} ${candidate}`)))
    if (hasLeadingZeroBits(digest, POW_BITS)) return candidate
  }
  throw new Error('zcode: could not solve the client request proof of work')
}

/**
 * 解析 signing JWT，取出 `api_key` 与过期时间。
 *
 * @param {string} jwt signing JWT。
 * @returns {{ apiKeyId: string, expiresAt: number } | undefined} 解析结果；形状不符时 undefined。
 */
export function parseSigningJwt(jwt) {
  if (typeof jwt !== 'string') return undefined
  const parts = jwt.split('.')
  if (parts.length !== 3) return undefined
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    // 客户端只认这个形状；别把普通 token 当签名凭证用。
    if (header?.sign_type !== 'SIGN') return undefined
    const apiKeyId = typeof payload?.api_key === 'string' ? payload.api_key : ''
    if (apiKeyId === '') return undefined
    const exp = typeof payload?.exp === 'number' ? payload.exp * 1000 : Date.now() + 5 * 60 * 1000
    return { apiKeyId, expiresAt: exp }
  } catch {
    return undefined
  }
}

/**
 * 从凭证里挑出可以用作握手的账户 access token。
 *
 * 只有拿到**同一 origin、同一家族**的 access token，才能换出对应的 signing JWT；
 * 因此这里按 origin 精确匹配，不做跨家族的兜底猜测。
 *
 * @param {Record<string, unknown>} credentials 解密后的凭证。
 * @param {string} origin 目标 origin。
 * @returns {{ accessToken: string, location: { organizationId: string, projectId: string, apiKeyId: string } } | undefined}
 *   可用于换取签名凭证的组合。
 */
export function selectProjectTokenSource(credentials, origin) {
  /** @type {string | undefined} */
  let family
  /** @type {{ organizationId: string, projectId: string, apiKeyId: string } | undefined} */
  let location
  for (const key of Object.keys(credentials)) {
    if (!key.startsWith('project-key-location:v1:')) continue
    /** @type {string[]} */
    let scope
    try {
      scope = JSON.parse(decodeURIComponent(key.slice('project-key-location:v1:'.length)))
    } catch {
      continue
    }
    if (!Array.isArray(scope) || scope[0] !== origin) continue
    /** @type {any} */
    let entry
    try {
      entry = JSON.parse(/** @type {string} */ (credentials[key]))
    } catch {
      continue
    }
    if (typeof entry?.organizationId !== 'string' || typeof entry?.projectId !== 'string' || typeof entry?.apiKeyId !== 'string') continue
    family = String(scope[1] ?? '')
    location = { organizationId: entry.organizationId, projectId: entry.projectId, apiKeyId: entry.apiKeyId }
    break
  }
  if (location === undefined) return undefined
  const accessToken = family === 'zai'
    ? credentials['zcodejwttoken']
    : credentials['oauth:bigmodel:access_token']
  if (typeof accessToken !== 'string' || accessToken === '') return undefined
  return { accessToken, location }
}

/**
 * 用账户 access token 换取 project 级 signing JWT。
 *
 * @param {object} input 参数。
 * @param {string} input.origin 账户 origin（如 `https://bigmodel.cn`）。
 * @param {string} input.accessToken 该账户家族的 access token。
 * @param {{ organizationId: string, projectId: string, apiKeyId: string }} input.location project 定位。
 * @param {string} input.clientVersion 客户端版本，参与签名与 body。
 * @param {AbortSignal} [input.signal] 取消信号。
 * @returns {Promise<SigningCredential>} 签名凭证。
 * @throws {Error} 上游拒绝或返回体形状不符时抛出。
 */
export async function exchangeSigningCredential({ origin, accessToken, location, clientVersion, signal }) {
  const url = `${origin}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}` +
    `/projects/${encodeURIComponent(location.projectId)}/api_keys/${encodeURIComponent(location.apiKeyId)}/access_tokens`
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      Authorization: accessToken,
      'Content-Type': 'application/json',
      'bigmodel-organization': location.organizationId,
      'bigmodel-project': location.projectId,
    },
    body: JSON.stringify({ clientType: APP_ID, clientVersion }),
  })
  const text = await response.text()
  /** @type {any} */
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`zcode: signing credential exchange returned non-JSON (HTTP ${response.status})`)
  }
  if (body?.success !== true || typeof body?.data?.accessToken !== 'string') {
    // 上游用 code 401 / 404 区分「token 失效」与「project 不可用」，两者都不能靠重试解决。
    throw new Error(`zcode: signing credential exchange failed (code ${String(body?.code ?? '?')}: ${String(body?.msg ?? text).slice(0, 160)})`)
  }
  const parsed = parseSigningJwt(body.data.accessToken)
  if (parsed === undefined) throw new Error('zcode: upstream returned a token that is not a signing JWT')
  return { signingJwt: body.data.accessToken, apiKeyId: parsed.apiKeyId, expiresAt: parsed.expiresAt, origin }
}

/**
 * 握手并解包出 Ed25519 私钥，建立可复用的签名会话。
 *
 * @param {object} input 参数。
 * @param {SigningCredential} input.credential 上一步换到的签名凭证。
 * @param {string} input.clientVersion 客户端版本。
 * @param {AbortSignal} [input.signal] 取消信号。
 * @returns {Promise<SigningSession>} 可直接用于签业务请求的会话。
 * @throws {Error} 握手失败或私钥无法解包时抛出。
 */
export async function openSigningSession({ credential, clientVersion, signal }) {
  const ts = String(Date.now())
  const nonce = randomHex(16)
  const message = [HANDSHAKE_ACTION, credential.apiKeyId, ts, nonce].join('\n')

  const hmacKey = await crypto.subtle.importKey(
    'raw',
    await deriveBits(credential.signingJwt, INFO_HANDSHAKE),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(message))))

  const response = await fetch(credential.origin + HANDSHAKE_PATH, {
    method: 'POST',
    signal,
    headers: { Authorization: credential.signingJwt, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: credential.signingJwt, nonce, sig: signature, ts }),
  })
  const text = await response.text()
  /** @type {any} */
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`zcode: signing handshake returned non-JSON (HTTP ${response.status})`)
  }
  if (body?.success !== true || typeof body?.data?.privateCipher !== 'string') {
    throw new Error(`zcode: signing handshake failed (code ${String(body?.code ?? '?')}: ${String(body?.msg ?? text).slice(0, 160)})`)
  }

  const cipher = fromBase64(body.data.privateCipher)
  if (cipher.byteLength <= 12 + 16) throw new Error('zcode: handshake returned a truncated privateCipher')
  const aesKey = await crypto.subtle.importKey('raw', await deriveBits(credential.signingJwt, INFO_PRIVATE_KEY), 'AES-GCM', false, ['decrypt'])
  // AES-GCM 的附加数据就是 apiKeyId：换别的值解出来是乱码，importKey 会失败。
  const pkcs8 = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: cipher.slice(0, 12), additionalData: encoder.encode(credential.apiKeyId), tagLength: 128 },
    aesKey,
    cipher.slice(12),
  )
  const der = fromBase64(new TextDecoder().decode(new Uint8Array(pkcs8)))
  const privateKey = await crypto.subtle.importKey('pkcs8', der, 'Ed25519', false, ['sign'])

  return {
    apiKeyId: credential.apiKeyId,
    origin: credential.origin,
    clientVersion,
    privateKey,
    expiresAt: credential.expiresAt,
  }
}

/**
 * 为一次业务请求生成完整的签名头。
 *
 * 返回值可直接 `Object.assign` 进 `fetch` 的 headers。注意 `X-Session-Id` 是**必需**的：
 * 客户端实现里缺了它会直接抛 `Client request signing requires X-Session-Id.`。
 *
 * @param {SigningSession} session 签名会话。
 * @param {object} [options] 可选项。
 * @param {string} [options.sessionId] 复用已有会话 id；缺省随机生成。
 * @param {number} [options.now] 覆盖时间戳（测试用）。
 * @returns {Promise<Record<string, string>>} 一组签名头。
 */
export async function signRequestHeaders(session, options = {}) {
  const sessionId = options.sessionId ?? randomUUID()
  const ts = String(options.now ?? Date.now())
  const nonce = randomHex(16)
  // 参与签名的字段顺序固定，改顺序上游验签就会失败。
  const message = `${session.apiKeyId} ${ts} ${session.clientVersion} ${sessionId} ${nonce}`
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', session.privateKey, encoder.encode(message)))
  const pow = await solveProofOfWork({ apiKeyId: session.apiKeyId, sessionId, ts })
  return {
    'X-Client-Ts': ts,
    'X-Client-Version': session.clientVersion,
    'X-Client-Sig': toBase64(signature),
    'X-Session-Id': sessionId,
    'X-Client-Nonce': nonce,
    'X-App-Id': APP_ID,
    'X-Client-Pow': pow,
  }
}

/**
 * 建立签名会话的完整入口：读凭证 → 选 project → 换 JWT → 握手 → 解包私钥。
 *
 * @param {object} input 参数。
 * @param {string} input.origin 目标 origin。
 * @param {string} input.clientVersion 客户端版本。
 * @param {string} [input.dataBaseDir] ZCode 数据根（默认自动探测）。
 * @param {{ expiresAt: number, privateKey: any } | undefined} [input.previous]
 *   上一次的会话；未过期则直接复用，避免每次请求都握手。
 * @param {AbortSignal} [input.signal] 取消信号。
 * @returns {Promise<SigningSession>} 签名会话。
 * @throws {Error} 任一环节失败时抛出，错误信息带上游的 code/msg。
 */
export async function createSigningSession({ origin, clientVersion, dataBaseDir, previous, signal }) {
  if (previous !== undefined && previous.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return /** @type {SigningSession} */ (/** @type {unknown} */ (previous))
  }
  const credentials = readCredentials(dataBaseDir)
  const source = selectProjectTokenSource(credentials, origin)
  if (source === undefined) {
    throw new Error(`zcode: no project signing source cached for ${origin} (sign in with the ZCode client first)`)
  }
  const credential = await exchangeSigningCredential({ origin, accessToken: source.accessToken, location: source.location, clientVersion, signal })
  return await openSigningSession({ credential, clientVersion, signal })
}

/**
 * 签名会话是否仍可用（未进入过期缓冲区）。
 *
 * @param {{ expiresAt: number } | undefined} session 待检查的会话。
 * @returns {boolean} 仍可用时为 true。
 */
export function isSessionFresh(session) {
  return session !== undefined && session.expiresAt - EXPIRY_SKEW_MS > Date.now()
}
