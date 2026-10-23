/**
 * ZCode 客户端共享凭证的解密（读取 Start Plan 的 OAuth token）。
 *
 * zcode.cjs 的凭证存储（~/.zcode/v2/credentials.json）：
 *   - 每个值形如 `enc:v1:<iv>.<tag>.<data>`（base64url 三段）
 *   - AES-256-GCM，密钥 = SHA-256(ZCODE_CREDENTIAL_SECRET ?? 机器指纹)
 *   - 机器指纹 = `zcode-credential-fallback:<platform>:<homedir>:<username>`
 *     （与 zcode.cjs 的 resolveCredentialSecret 完全一致）
 *
 * 关联凭证键（2026-09-30 实测）：
 *   - `zcodejwttoken`：ZCode JWT —— **Start Plan 端点的鉴权凭证**（requestAuth.apiKey 用它，
 *     agent 在其上计算 coding-plan 请求签名）。`oauth:zai:access_token` 是 OAuth 会话 token，
 *     长期不刷新已过期（401），只作兜底。
 *   - `oauth:zai:access_token`：Z.AI OAuth 会话 token（已过期的兜底）
 *   - `oauth:active_provider`：当前登录的家族（"zai" | "bigmodel"）
 *
 * @module lib/credentials
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { userInfo, platform, homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { resolveZcodeDataRoot } from './zcode-runtime.js'

const ENC_PREFIX = 'enc:v1:'
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

/** 凭证读取/解密失败的错误码（稳定的机读值，调用方按 code 分流）。 */
export const CREDENTIAL_ERROR_CODES = /** @type {const} */ ([
  'CIPHER_FORMAT',
  'CIPHER_IV',
  'CIPHER_TAG',
  'CIPHER_DECRYPT',
  'CREDENTIALS_MISSING',
  'CREDENTIALS_READ',
  'TOKEN_MISSING',
])

/**
 * 从共享凭证里提取的 Start Plan 鉴权。
 *
 * @typedef {object} ZaiPlanAuth
 * @property {string} planToken `zcodejwttoken`（Start Plan 端点的 x-api-key）。
 * @property {string} [accessToken] 已过期的 `oauth:zai:access_token`，仅兜底。
 * @property {string} [activeProvider] 当前登录家族，通常为 `'zai'`。
 */

/** 单个凭证值；`null` 表示该值解密失败。 @typedef {string | null} CredentialValue */

/** 凭证读取/解密失败（可恢复，调用方按 `code` 分流）。 */
export class CredentialError extends Error {
  /**
   * @param {string} message 人类可读的失败描述。
   * @param {typeof CREDENTIAL_ERROR_CODES[number]} code 稳定的机读错误码。
   */
  constructor(message, code) {
    super(message)
    this.name = 'CredentialError'
    this.code = code
  }
}

/**
 * 复刻 zcode.cjs resolveCredentialSecret 的机器指纹。
 *
 * @param {string} [secretOverride] 测试覆盖（ZCODE_CREDENTIAL_SECRET）。
 * @returns {string} 参与 AES 密钥派生的原始密钥材料。
 */
export function credentialSecret(secretOverride) {
  const fromEnv = secretOverride ?? process.env.ZCODE_CREDENTIAL_SECRET
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  let username = 'unknown'
  try {
    username = userInfo().username
  } catch {
    /* 用户名不可得时与 zcode.cjs 一致地降级 */
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`
}

/**
 * AES-256-GCM 密钥（SHA-256 摘要，与 zcode.cjs 的 deriveCipherKey 一致）。
 *
 * @param {string} [secret] 密钥材料，默认取 {@link credentialSecret}。
 * @returns {Buffer} 32 字节密钥。
 */
export function deriveKey(secret = credentialSecret()) {
  return createHash('sha256').update(secret).digest()
}

/**
 * 解密单个 `enc:v1:` 值；非加密值原样返回。
 *
 * @param {unknown} value 存储中的凭证值。
 * @param {Buffer} [key] AES 密钥，默认取 {@link deriveKey}。
 * @returns {CredentialValue} 解密后的文本；未加密时原样返回。
 * @throws {CredentialError} 密文信封不合法时抛出。
 */
export function decryptValue(value, key = deriveKey()) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return /** @type {any} */ (value)
  const parts = value.slice(ENC_PREFIX.length).split('.')
  if (parts.length !== 3) {
    throw new CredentialError('凭证密文格式无效（应为 iv.tag.data 三段）', 'CIPHER_FORMAT')
  }
  const [ivB64, tagB64, dataB64] = parts
  const iv = Buffer.from(ivB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  const data = Buffer.from(dataB64, 'base64url')
  if (iv.length !== IV_LENGTH) {
    throw new CredentialError(`凭证 IV 长度无效（${iv.length} ≠ ${IV_LENGTH}）`, 'CIPHER_IV')
  }
  if (tag.length !== TAG_LENGTH) {
    throw new CredentialError(`凭证 auth tag 长度无效（${tag.length} ≠ ${TAG_LENGTH}）`, 'CIPHER_TAG')
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch (/** @type {any} */ error) {
    throw new CredentialError(`凭证解密失败：${error?.message ?? error}`, 'CIPHER_DECRYPT')
  }
}

/**
 * 共享凭证文件的候选路径，按优先级排列。
 *
 * 桌面客户端把数据写在 `dataBaseDir` 下（本机 `D:\AI\zcode\.zcode\v2`），而 npm CLI /
 * 旧版本客户端仍用 `~/.zcode/v2`；两者可能同时存在且内容不同（home 下常是过期副本），
 * 所以数据根目录优先，home 只作兜底。
 *
 * @param {string} [dataBaseDir] ZCode 数据根目录；空串 = 从 setting.json / home 解析。
 * @returns {string[]} 候选凭证文件绝对路径，主路径在前。
 */
export function credentialsCandidates(dataBaseDir) {
  // 空串视为未设置：先看显式配置，再看 ZCODE_DATA_BASE_DIR，最后交给数据根解析（setting.json → home）
  const configured = dataBaseDir?.trim?.() || process.env.ZCODE_DATA_BASE_DIR?.trim() || ''
  const dataRoot = resolveZcodeDataRoot(configured)
  const primary = path.join(dataRoot.dataRoot, 'credentials.json')
  const legacy = path.join(homedir(), '.zcode', 'v2', 'credentials.json')
  return primary === legacy ? [primary] : [primary, legacy]
}

/**
 * 共享凭证文件路径（数据根目录下的 `credentials.json`，`~/.zcode/v2` 为兜底）。
 *
 * @param {string} [dataBaseDir] ZCode 数据根目录；空串视为未设置。
 * @returns {string} 主凭证文件绝对路径。
 */
export function credentialsPath(dataBaseDir) {
  return credentialsCandidates(dataBaseDir)[0]
}

/**
 * 读取并解密共享凭证。
 *
 * @param {string} [dataBaseDir] ZCode 数据根目录。
 * @param {Buffer} [key] AES 密钥，默认取 {@link deriveKey}。
 * @returns {Record<string, CredentialValue>} 键 → 解密后的值（未加密值原样保留，解密失败记 null）。
 * @throws {CredentialError} 文件缺失或无法解析时抛出。
 */
export function readCredentials(dataBaseDir, key = deriveKey()) {
  const candidates = credentialsCandidates(dataBaseDir)
  /** @type {Record<string, unknown> | undefined} */
  let raw
  for (const file of candidates) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
      break
    } catch (/** @type {any} */ error) {
      // 文件存在但读不了/解析不了：直接报错，不要静默回退到可能更旧的 home 副本。
      if (error?.code !== 'ENOENT') {
        throw new CredentialError(`共享凭证文件读取失败：${file}：${error?.message ?? error}`, 'CREDENTIALS_READ')
      }
    }
  }
  if (raw === undefined) {
    throw new CredentialError(
      `共享凭证文件不存在：${candidates.join(' 或 ')}（ZCode 客户端未登录？）`,
      'CREDENTIALS_MISSING',
    )
  }
  /** @type {Record<string, CredentialValue>} */
  const out = {}
  for (const [entryKey, entryValue] of Object.entries(raw)) {
    try {
      out[entryKey] = decryptValue(entryValue, key)
    } catch {
      // 单个凭证解密失败不影响其他（记为 null，调用方按需判空）
      out[entryKey] = null
    }
  }
  return out
}

/**
 * 提取 Start Plan 请求需要的鉴权。
 *
 * planToken 优先用 `zcodejwttoken`，缺失时回退已过期的 `oauth:zai:access_token`。
 *
 * @param {string} [dataBaseDir] ZCode 数据根目录。
 * @param {Buffer} [key] AES 密钥，默认取 {@link deriveKey}。
 * @returns {ZaiPlanAuth} Start Plan 鉴权三元组。
 * @throws {CredentialError} 两个 token 都不存在时抛出。
 */
export function readZaiPlanAuth(dataBaseDir, key = deriveKey()) {
  const creds = readCredentials(dataBaseDir, key)
  const planToken = creds['zcodejwttoken']
  const accessToken = creds['oauth:zai:access_token']
  const hasPlan = typeof planToken === 'string' && planToken !== ''
  const hasAccess = typeof accessToken === 'string' && accessToken !== ''
  if (!hasPlan && !hasAccess) {
    throw new CredentialError(
      '共享凭证里没有 zcodejwttoken / oauth:zai:access_token（ZCode 客户端未登录 Z.AI？）',
      'TOKEN_MISSING',
    )
  }
  const activeProvider = creds['oauth:active_provider']
  return {
    planToken: hasPlan ? /** @type {string} */ (planToken) : /** @type {string} */ (accessToken),
    ...(hasAccess ? { accessToken: /** @type {string} */ (accessToken) } : {}),
    ...(typeof activeProvider === 'string' ? { activeProvider } : {}),
  }
}
