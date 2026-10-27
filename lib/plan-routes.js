/**
 * 计划路由表：`providerId` → 端点 + 模型清单。
 *
 * 这张表的**权威来源是 ZCode 客户端自己写在磁盘上的 builtin release**：
 *
 * ```
 * <dataBaseDir>/.zcode/v2/runtime/provider/<platform>/<version>/endpoint-XXXX/zcode-builtin.json
 * ```
 *
 * 它的 `config.providerConfigRules.providerRules` 里有一组 `account:*` 规则，每条声明了
 * 该套餐的 `baseUrl` 与 `builtinModelIds`。插件读这个文件，就能在**不启动客户端**的前提下
 * 知道「这个账号能服务哪些路由、每条路由有哪些模型」。
 *
 * 但客户端不是必须装：插件内置了一份 {@link FALLBACK_PLAN_PROVIDERS} 快照，读不到 release
 * 时降级到它。这样「只有凭证、没有客户端」的部署（例如插件自己跑 `login` 拿到的账号）
 * 依然可用 —— 这正是把直连通道做出来的意义。
 *
 * ## 为什么要一张表而不是硬编码在 adapter 里
 *
 * 直连通道和旧 agent 通道的关键差别是：agent 会**在运行时**告诉我们它能服务什么
 * （`session/create` 的 `settings.model.available`），而直连通道没有这个反馈环。所以
 * 「路由表」必须是一个可单独测试、可单独诊断、可从文件刷新的独立概念，而不是散落在
 * adapter 的 `listModels` 里。`diagnostics.js` 的 `plan-models` 命令直接读它。
 *
 * ## 实测快照（客户端 3.16.3，release revision 33）
 *
 * | providerId | baseUrl | models |
 * |---|---|---|
 * | `account:zai-individual-coding-plan` | `https://api.z.ai/api/anthropic` | GLM-5.3, GLM-5.3-Flash |
 * | `account:zai-team-coding-plan` | 同上 | 同上 |
 * | `account:zai-start-plan` | `https://zcode.z.ai/api/v1/zcode-plan/anthropic` | GLM-5.3-Flash, GLM-5.2, GLM-5-Turbo |
 * | `account:bigmodel-individual-coding-plan` | `https://open.bigmodel.cn/api/anthropic` | GLM-5.3, GLM-5.3-Flash |
 * | `account:bigmodel-team-coding-plan` | 同上 | 同上 |
 * | `account:bigmodel-start-plan` | `https://zcode.z.ai/api/v1/zcode-plan/anthropic` | GLM-5.3-Flash, GLM-5.2, GLM-5-Turbo |
 * | `account:zai-offpeak-idle-plan` | `https://zcode.z.ai/api/v1/off-peak/anthropic` | GLM-5.3, GLM-5.3-Flash |
 * | `account:bigmodel-offpeak-idle-plan` | 同上 | 同上 |
 * | `account:zai-highspeed-card` | `https://zcode.z.ai/api/v1/highspeed/anthropic` | GLM-5.3, GLM-5.3-Flash |
 * | `account:bigmodel-highspeed-card` | 同上 | 同上 |
 *
 * ## 路由优先级
 *
 * 同一个 modelId 往往出现在多条路由上（`GLM-5.3-Flash` 同时在 start-plan、coding-plan、
 * offpeak、highspeed 上）。烧哪个额度、走哪个上游，取决于选哪条路由，所以顺序必须固定且
 * 有解释力：
 *
 * 1. **start-plan** —— ZCode 赠送/订阅的 Start Plan，`zcode-plan` 端点（Bearer JWT）
 * 2. **individual / team coding-plan** —— 正式的 Coding Plan 订阅（`x-api-key`）
 * 3. **offpeak-idle-plan** —— 错峰闲时额度
 * 4. **highspeed-card** —— 高速卡（per-request 卡号）
 *
 * 与旧 agent 通道「优先 `account:` 路由」的语义一致：都是先烧套餐额度、后走按量计费。
 *
 * @module lib/plan-routes
 */

import fs from 'node:fs'
import path from 'node:path'

import { PLAN_ENDPOINTS } from './plan-client.js'

/** 路由的套餐种类，同时也是排序依据。 */
export const PLAN_KINDS = /** @type {const} */ ([
  'start-plan',
  'individual-coding-plan',
  'team-coding-plan',
  'offpeak-idle-plan',
  'highspeed-card',
])

/** 套餐种类 → 排序权重（小的优先）。 */
export const PLAN_KIND_ORDER = Object.freeze({
  'start-plan': 0,
  'individual-coding-plan': 1,
  'team-coding-plan': 2,
  'offpeak-idle-plan': 3,
  'highspeed-card': 4,
})

/**
 * 内置的路由快照（读不到客户端 release 时的降级表）。
 *
 * 刻意保持与实测 release 一致，而不是「随便列几个能跑的」。降级表的作用是让没有客户端的
 * 机器也能起服务，不是让插件假装自己知道更多。
 *
 * @type {readonly PlanProvider[]}
 */
export const FALLBACK_PLAN_PROVIDERS = Object.freeze([
  makeProvider('account:zai-start-plan', 'Start Plan', 'zai', 'start-plan', PLAN_ENDPOINTS['start-plan'], ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo']),
  makeProvider('account:bigmodel-start-plan', 'Start Plan', 'bigmodel', 'start-plan', PLAN_ENDPOINTS['start-plan'], ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo']),
  makeProvider('account:zai-individual-coding-plan', 'Z.AI Individual Coding Plan', 'zai', 'individual-coding-plan', PLAN_ENDPOINTS['coding-plan-zai'], ['GLM-5.3', 'GLM-5.3-Flash']),
  makeProvider('account:zai-team-coding-plan', 'Z.AI Team Coding Plan', 'zai', 'team-coding-plan', PLAN_ENDPOINTS['coding-plan-zai'], ['GLM-5.3', 'GLM-5.3-Flash']),
  makeProvider('account:bigmodel-individual-coding-plan', 'BigModel Individual Coding Plan', 'bigmodel', 'individual-coding-plan', PLAN_ENDPOINTS['coding-plan-bigmodel'], ['GLM-5.3', 'GLM-5.3-Flash']),
  makeProvider('account:bigmodel-team-coding-plan', 'BigModel Team Coding Plan', 'bigmodel', 'team-coding-plan', PLAN_ENDPOINTS['coding-plan-bigmodel'], ['GLM-5.3', 'GLM-5.3-Flash']),
  makeProvider('account:zai-offpeak-idle-plan', 'Z.AI Idle plan', 'zai', 'offpeak-idle-plan', PLAN_ENDPOINTS['offpeak-idle-plan'], ['GLM-5.3', 'GLM-5.3-Flash']),
  makeProvider('account:bigmodel-offpeak-idle-plan', 'BigModel Idle plan', 'bigmodel', 'offpeak-idle-plan', PLAN_ENDPOINTS['offpeak-idle-plan'], ['GLM-5.3', 'GLM-5.3-Flash']),
  makeProvider('account:zai-highspeed-card', 'Z.AI Highspeed card', 'zai', 'highspeed-card', PLAN_ENDPOINTS['highspeed-card'], ['GLM-5.3', 'GLM-5.3-Flash']),
  makeProvider('account:bigmodel-highspeed-card', 'BigModel Highspeed card', 'bigmodel', 'highspeed-card', PLAN_ENDPOINTS['highspeed-card'], ['GLM-5.3', 'GLM-5.3-Flash']),
])

/**
 * 一条计划路由（已归一）。
 *
 * @typedef {object} PlanProvider
 * @property {string} providerId ZCode 侧的 provider id（`account:...`）。
 * @property {string} providerName 展示名。
 * @property {'zai' | 'bigmodel'} family 凭证家族。
 * @property {typeof PLAN_KINDS[number]} planKind 套餐种类。
 * @property {string} baseUrl 上游 baseUrl（不含 `/v1/messages`）。
 * @property {readonly string[]} modelIds 该路由声明的模型。
 * @property {'bearer-jwt' | 'api-key' | 'bearer-jwt+coding-plan-key' | 'bearer-jwt+coding-plan-key+card-id'} authKind 鉴权形态。
 */

/**
 * 构造一条路由（内部用，保证 `authKind` 与 `planKind` 一致）。
 *
 * @param {string} providerId provider id。
 * @param {string} providerName 展示名。
 * @param {'zai' | 'bigmodel'} family 家族。
 * @param {typeof PLAN_KINDS[number]} planKind 套餐种类。
 * @param {string} baseUrl 上游 baseUrl。
 * @param {string[]} modelIds 模型清单。
 * @returns {PlanProvider} 归一后的路由。
 */
function makeProvider(providerId, providerName, family, planKind, baseUrl, modelIds) {
  /** @type {PlanProvider} */
  const provider = {
    providerId,
    providerName,
    family,
    planKind,
    baseUrl,
    modelIds: Object.freeze([...modelIds]),
    authKind: authKindFor(planKind),
  }
  return Object.freeze(provider)
}

/**
 * 套餐种类 → 鉴权头形态。
 *
 * 实测（2026-10-27）：
 * - `zcode-plan` 端点只收 `Authorization: Bearer <zcodejwttoken>`，给 `x-api-key` 直接 401；
 * - `api.z.ai` / `open.bigmodel.cn` 的 anthropic 端点只收 `x-api-key: <coding-plan key>`，
 *   给 Bearer JWT 回 401「令牌已过期或验证不正确」；
 * - 错峰/高速端点两者都要（Bearer 定身份 + coding-plan key 定套餐），高速还要卡号。
 *
 * @param {typeof PLAN_KINDS[number]} planKind 套餐种类。
 * @returns {PlanProvider['authKind']} 鉴权形态。
 */
export function authKindFor(planKind) {
  switch (planKind) {
    case 'start-plan':
      return 'bearer-jwt'
    case 'individual-coding-plan':
    case 'team-coding-plan':
      return 'api-key'
    case 'offpeak-idle-plan':
      return 'bearer-jwt+coding-plan-key'
    case 'highspeed-card':
      return 'bearer-jwt+coding-plan-key+card-id'
    default:
      return 'bearer-jwt'
  }
}

/**
 * 从 providerId 推断套餐种类。
 *
 * release 里 `access.mode` 是权威值，但它可能是 `off-peak` / `highspeed` 这类与
 * {@link PLAN_KINDS} 拼写不同的枚举；providerId 本身反而是稳定的（`account:<family>-<kind>`）。
 * 两条都用，先信 `mode`，不认得再退回 providerId 后缀。
 *
 * @param {string} providerId provider id。
 * @param {string} [mode] release 里的 `access.mode`。
 * @returns {typeof PLAN_KINDS[number]} 套餐种类。
 */
export function inferPlanKind(providerId, mode) {
  const normalizedMode = typeof mode === 'string' ? mode.trim().toLowerCase() : ''
  if (normalizedMode === 'start-plan') return 'start-plan'
  if (normalizedMode === 'individual-coding-plan') return 'individual-coding-plan'
  if (normalizedMode === 'team-coding-plan') return 'team-coding-plan'
  if (normalizedMode === 'off-peak' || normalizedMode === 'offpeak-idle-plan') return 'offpeak-idle-plan'
  if (normalizedMode === 'highspeed' || normalizedMode === 'highspeed-card') return 'highspeed-card'
  const id = providerId.toLowerCase()
  if (id.includes('start-plan')) return 'start-plan'
  if (id.includes('offpeak') || id.includes('off-peak')) return 'offpeak-idle-plan'
  if (id.includes('highspeed')) return 'highspeed-card'
  if (id.includes('team')) return 'team-coding-plan'
  return 'individual-coding-plan'
}

/**
 * 从 providerId 推断家族。
 *
 * @param {string} providerId provider id。
 * @param {string} [accountType] release 里的 `access.accountType`（权威值）。
 * @returns {'zai' | 'bigmodel'} 家族。
 */
export function inferFamily(providerId, accountType) {
  if (accountType === 'zai' || accountType === 'bigmodel') return accountType
  return providerId.toLowerCase().includes('bigmodel') ? 'bigmodel' : 'zai'
}

/**
 * 归一一条 release 里的 provider 规则。
 *
 * @param {unknown} rule release 的 `providerRules[]` 元素。
 * @returns {PlanProvider | undefined} 归一后的路由；不是 `account:*` 规则时返回 `undefined`。
 */
export function normalizeProviderRule(rule) {
  if (typeof rule !== 'object' || rule === null) return undefined
  const record = /** @type {Record<string, any>} */ (rule)
  const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : ''
  // 只要 account:* 套餐路由；个人 provider（new-provider-3 之类）不属于计划额度。
  if (!providerId.startsWith('account:')) return undefined
  const config = typeof record.config === 'object' && record.config !== null
    ? /** @type {Record<string, any>} */ (record.config)
    : {}
  const access = typeof config.access === 'object' && config.access !== null
    ? /** @type {Record<string, any>} */ (config.access)
    : {}
  const api = typeof config.api === 'object' && config.api !== null
    ? /** @type {Record<string, any>} */ (config.api)
    : {}
  const baseUrl = typeof api.baseUrl === 'string' ? api.baseUrl.trim().replace(/\/+$/u, '') : ''
  if (baseUrl === '') return undefined
  /** @type {string[]} */
  const modelIds = []
  for (const source of [config.builtinModelIds, config.personalModelIds]) {
    if (!Array.isArray(source)) continue
    for (const modelId of source) {
      if (typeof modelId === 'string' && modelId.trim() !== '' && !modelIds.includes(modelId.trim())) {
        modelIds.push(modelId.trim())
      }
    }
  }
  if (modelIds.length === 0) return undefined
  const planKind = inferPlanKind(providerId, typeof access.mode === 'string' ? access.mode : undefined)
  const family = inferFamily(providerId, typeof access.accountType === 'string' ? access.accountType : undefined)
  const providerName = typeof record.providerName === 'string' && record.providerName.trim() !== ''
    ? record.providerName.trim()
    : providerId
  return makeProvider(providerId, providerName, family, planKind, baseUrl, modelIds)
}

/**
 * 路由排序：先按套餐种类，再按 providerId 保持稳定顺序。
 *
 * @param {PlanProvider} a 左。
 * @param {PlanProvider} b 右。
 * @returns {number} 排序值。
 */
export function compareProviders(a, b) {
  const rank = (PLAN_KIND_ORDER[a.planKind] ?? 99) - (PLAN_KIND_ORDER[b.planKind] ?? 99)
  if (rank !== 0) return rank
  return a.providerId.localeCompare(b.providerId)
}

/**
 * 归一一个完整的 release 对象（`config.providerConfigRules.providerRules`）。
 *
 * @param {unknown} release 已解析的 `zcode-builtin.json`。
 * @returns {PlanProvider[]} 排好序的路由；没有任何 `account:*` 规则时返回空数组。
 */
export function normalizeRelease(release) {
  if (typeof release !== 'object' || release === null) return []
  const record = /** @type {Record<string, any>} */ (release)
  const rules = record?.config?.providerConfigRules?.providerRules
  if (!Array.isArray(rules)) return []
  /** @type {PlanProvider[]} */
  const providers = []
  for (const rule of rules) {
    const provider = normalizeProviderRule(rule)
    if (provider !== undefined) providers.push(provider)
  }
  return providers.sort(compareProviders)
}

/**
 * 找到磁盘上最新的 builtin release 文件。
 *
 * 目录形状：`<dataBaseDir>/.zcode/v2/runtime/provider/<platform>/<version>/endpoint-XXXX/zcode-builtin.json`。
 * 取**修改时间最新**的那个：客户端升级后旧版本目录不会立刻删除，而旧 release 的模型清单
 * 可能已经过期。
 *
 * @param {string} dataBaseDir ZCode 数据根（形如 `D:\\AI\\zcode`，不含 `.zcode`）。
 * @returns {string | undefined} 最新 release 的绝对路径。
 */
export function findLatestRelease(dataBaseDir) {
  const platformDir = process.platform === 'win32'
    ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
    : `${process.platform}-${process.arch}`
  const root = path.join(dataBaseDir, '.zcode', 'v2', 'runtime', 'provider', platformDir)
  /** @type {string | undefined} */
  let best
  /** @type {number} */
  let bestMtime = -1
  /** @type {import('node:fs').Dirent[]} */
  let versions
  try {
    versions = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const versionDir of versions) {
    if (!versionDir.isDirectory()) continue
    const versionPath = path.join(root, versionDir.name)
    /** @type {import('node:fs').Dirent[]} */
    let endpoints
    try {
      endpoints = fs.readdirSync(versionPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const endpointDir of endpoints) {
      if (!endpointDir.isDirectory() || !endpointDir.name.startsWith('endpoint-')) continue
      const candidate = path.join(versionPath, endpointDir.name, 'zcode-builtin.json')
      try {
        const stat = fs.statSync(candidate)
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs
          best = candidate
        }
      } catch {
        /* 文件不在就跳过这个 endpoint 目录 */
      }
    }
  }
  return best
}

/**
 * 加载计划路由表：优先客户端 release，读不到降级到内置快照。
 *
 * 永不抛异常：一个装不上客户端的机器也必须能起服务，这正是降级表存在的理由。失败原因
 * 通过返回值的 `reason` 带出，调用方可以记日志，但不需要为它做错误分支。
 *
 * @param {object} [options] 参数。
 * @param {string} [options.dataBaseDir] ZCode 数据根。
 * @param {string} [options.cliPath] 显式 CLI 路径（用于从客户端安装目录旁的 `provider/` 找 release）。
 * @returns {{ providers: PlanProvider[], source: 'builtin-release' | 'fallback', releasePath?: string, reason?: string }} 路由表。
 */
export function loadPlanCatalogue(options = {}) {
  const dataBaseDir = (options.dataBaseDir ?? '').trim()
  const cliPath = (options.cliPath ?? '').trim()
  /** @type {string | undefined} */
  let releasePath
  // 显式 CLI 路径旁通常也有一份 provider/zcode-builtin.json（客户端安装目录形态）。
  if (cliPath !== '') {
    const bundled = path.join(path.dirname(cliPath), 'provider', 'zcode-builtin.json')
    try {
      fs.accessSync(bundled)
      releasePath = bundled
    } catch {
      /* 没有就用数据根 */
    }
  }
  if (releasePath === undefined && dataBaseDir !== '') {
    releasePath = findLatestRelease(dataBaseDir)
  }
  if (releasePath === undefined) {
    return {
      providers: /** @type {PlanProvider[]} */ ([...FALLBACK_PLAN_PROVIDERS]),
      source: 'fallback',
      reason: 'no builtin release found on disk',
    }
  }
  /** @type {unknown} */
  let release
  try {
    release = JSON.parse(fs.readFileSync(releasePath, 'utf8'))
  } catch (/** @type {any} */ error) {
    return {
      providers: /** @type {PlanProvider[]} */ ([...FALLBACK_PLAN_PROVIDERS]),
      source: 'fallback',
      reason: `cannot parse ${releasePath}: ${error?.message ?? error}`,
    }
  }
  const providers = normalizeRelease(release)
  if (providers.length === 0) {
    return {
      providers: /** @type {PlanProvider[]} */ ([...FALLBACK_PLAN_PROVIDERS]),
      source: 'fallback',
      releasePath,
      reason: `${releasePath} declares no account:* provider rules`,
    }
  }
  return { providers, source: 'builtin-release', releasePath }
}

/**
 * DSH 侧模型 id。
 *
 * 直连通道的模型 id **必须带路由前缀**，理由与旧通道不同：
 *
 * 旧通道里模型 id 就是 CLI 的 modelId，因为 agent 自己知道该走哪条路由（`session/setModel`
 * 会带 `{providerId, modelId}`，而模型清单里同一个 modelId 只出现一次）。
 *
 * 直连通道没有这个「agent 帮我选路由」的环节：请求是我们自己发的，`GLM-5.3-Flash` 同时存在
 * 于 start-plan / coding-plan / offpeak / highspeed 四条路由上，烧的额度和打的上游都不同。
 * 只用 modelId 就无法表达「我要烧 start-plan」。所以 id 定成 `<providerId>#<modelId>`，
 * 例如 `account:zai-start-plan#GLM-5.3-Flash`。
 *
 * 这与 DSH 自己的 `provider/model` 习惯不冲突：`#` 在 providerId 里不出现（providerId 含
 * `:` 和 `-`），`modelId` 里也不出现，所以拆分是无歧义的。
 *
 * @param {string} providerId 路由 id。
 * @param {string} modelId 模型 id。
 * @returns {string} DSH 模型 id。
 */
export function planModelId(providerId, modelId) {
  return `${providerId}#${modelId}`
}

/**
 * 拆解一个 DSH 模型 id，**不**做「裸 id → 第一条路由」的解析。
 *
 * 这个函数只回答一个问题：用户写这个 id 时有没有**显式指定路由**？
 *
 * - 有（`#` / `account:.../` 写法）→ 返回 `providerId` + `modelId`，语义是「只走这条路由」；
 * - 没有（裸 modelId）→ 只返回 `modelId`，语义是「这个模型，路由由插件按套餐优先级挑」。
 *
 * 两者必须分开，否则 merged 模式无法区分「用户钉死了 start-plan」和「用户只要这个模型」——
 * 前者是单条路由，后者是一整条候选链。{@link parsePlanModelId} 保留旧语义（总是给出某条
 * 路由）供只需要「一条」的调用方使用。
 *
 * @param {unknown} value DSH 模型 id。
 * @returns {{ providerId?: string, modelId: string } | undefined} 拆解结果；空值或残缺时 `undefined`。
 */
export function parsePlanModelRef(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return undefined
  const hashIndex = text.indexOf('#')
  if (hashIndex === 0) {
    // 以 `#` 开头：残缺的显式写法（`#GLM-5.3`）。modelId 本身不含 `#`，所以这只能是笔误，
    // 不能退化成「裸 modelId 叫 #GLM-5.3」。
    return undefined
  }
  if (hashIndex > 0) {
    const providerId = text.slice(0, hashIndex).trim()
    const modelId = text.slice(hashIndex + 1).trim()
    if (providerId === '' || modelId === '') return undefined
    return { providerId, modelId }
  }
  const slashIndex = text.lastIndexOf('/')
  if (slashIndex > 0) {
    const providerId = text.slice(0, slashIndex).trim()
    const modelId = text.slice(slashIndex + 1).trim()
    // 只有前半段看起来像 providerId 才按斜杠拆；否则 `GLM-5.3/Flash` 这种会被误拆。
    if (providerId.startsWith('account:') && modelId !== '') return { providerId, modelId }
  }
  return { modelId: text }
}

/**
 * 拆解 DSH 模型 id 并解析到**一条**具体路由。
 *
 * 兼容三种写法，方便用户手写配置：
 * - `account:zai-start-plan#GLM-5.3-Flash`（规范形式）
 * - `account:zai-start-plan/GLM-5.3-Flash`（斜杠形式，DSH 用户习惯）
 * - `GLM-5.3-Flash`（裸 modelId，按路由优先级选第一条能服务的路由）
 *
 * @param {string} value DSH 模型 id。
 * @param {readonly PlanProvider[]} [providers] 用于解析裸 modelId 的路由表。
 * @returns {{ providerId: string, modelId: string } | undefined} 拆解结果；无法解析时 `undefined`。
 */
export function parsePlanModelId(value, providers = []) {
  const ref = parsePlanModelRef(value)
  if (ref === undefined) return undefined
  if (ref.providerId !== undefined) return { providerId: ref.providerId, modelId: ref.modelId }
  // 裸 modelId：按优先级找第一条声明了它的路由。
  for (const provider of providers) {
    if (provider.modelIds.includes(ref.modelId)) return { providerId: provider.providerId, modelId: ref.modelId }
  }
  return undefined
}

/**
 * 一个上游 modelId 能走的所有路由，按套餐优先级排序。
 *
 * 这就是 merged 模式的「自动切换」候选链：`GLM-5.3-Flash` 会得到
 * start-plan → coding-plan → offpeak → highspeed 这样的有序列表。调用方按顺序尝试，
 * 前一条因为额度/鉴权不可用时换下一条。
 *
 * @param {readonly PlanProvider[]} providers 路由表。
 * @param {string} modelId 上游模型 id。
 * @returns {PlanProvider[]} 有序候选路由；没有路由声明该模型时为空数组。
 */
export function routesForModel(providers, modelId) {
  const wanted = typeof modelId === 'string' ? modelId.trim() : ''
  if (wanted === '') return []
  return [...providers].sort(compareProviders).filter((provider) => provider.modelIds.includes(wanted))
}

/**
 * 把路由表展开成「一条路由 × 一个模型」的清单，按路由优先级排序。
 *
 * @param {readonly PlanProvider[]} providers 路由表。
 * @returns {{ id: string, providerId: string, modelId: string, providerName: string,
 *   planKind: PlanProvider['planKind'], baseUrl: string, authKind: PlanProvider['authKind'] }[]} 展开清单。
 */
export function expandPlanModels(providers) {
  /** @type {{ id: string, providerId: string, modelId: string, providerName: string,
   *   planKind: PlanProvider['planKind'], baseUrl: string, authKind: PlanProvider['authKind'] }[]} */
  const out = []
  for (const provider of [...providers].sort(compareProviders)) {
    for (const modelId of provider.modelIds) {
      out.push({
        id: planModelId(provider.providerId, modelId),
        providerId: provider.providerId,
        modelId,
        providerName: provider.providerName,
        planKind: provider.planKind,
        baseUrl: provider.baseUrl,
        authKind: provider.authKind,
      })
    }
  }
  return out
}

/**
 * 按 providerId 查路由。
 *
 * @param {readonly PlanProvider[]} providers 路由表。
 * @param {string} providerId 路由 id。
 * @returns {PlanProvider | undefined} 命中的路由。
 */
export function findProvider(providers, providerId) {
  const wanted = String(providerId ?? '').trim()
  if (wanted === '') return undefined
  return providers.find((provider) => provider.providerId === wanted)
}

/**
 * 把一条候选路由链**严格**限制到用户钉死的路由上。
 *
 * 这是「某个模型只烧特定套餐」的实现：`planPinnedRoutes` 里写
 * `account:zai-start-plan#GLM-5.3-Flash`，该模型的链就只剩这一条，额度用尽也**不**切换
 * —— 与 allow list 里的同名 id 完全不同，后者只把路由提到链首、保留兜底。
 *
 * 语义细节：
 * - 只认**带路由**的写法（`#` / `account:…/`）。裸 `modelId` 无法表达「哪条路由」，
 *   直接忽略（调用方会另发一条警告，避免用户以为生效了）；
 * - 只对**同名的 modelId** 生效，不会把别的模型的链也砍掉；
 * - 钉了多条就保留多条（例如同时钉 start-plan 与 coding-plan），顺序仍按套餐优先级；
 * - 钉的路由根本不服务这个模型时**不**改动链（返回 `undefined` 由调用方判断并告警），
 *   绝不能因为写错一个 id 就把模型变成不可用。
 *
 * @param {readonly PlanProvider[]} routes 候选路由链。
 * @param {string} modelId 该模型的上游 id。
 * @param {readonly string[]} pinnedIds 配置里的钉死列表。
 * @returns {PlanProvider[] | undefined} 限制后的链；没有命中任何钉死项时 `undefined`。
 */
export function restrictRoutesToPins(routes, modelId, pinnedIds) {
  const wanted = new Set()
  for (const id of Array.isArray(pinnedIds) ? pinnedIds : []) {
    const ref = parsePlanModelRef(id)
    if (ref === undefined || ref.providerId === undefined) continue
    if (ref.modelId !== modelId) continue
    wanted.add(ref.providerId)
  }
  if (wanted.size === 0) return undefined
  const kept = routes.filter((route) => wanted.has(route.providerId))
  return kept.length === 0 ? undefined : kept
}

/**
 * 一条合并后的模型（merged 模式）：一个 modelId + 它可用的整条路由链。
 *
 * @typedef {object} MergedPlanModel
 * @property {string} id DSH 模型 id（merged 模式下就是裸 modelId）。
 * @property {string} modelId 上游模型 id。
 * @property {string} providerId 首选路由 id（链上第一条）。
 * @property {string} providerName 首选路由展示名。
 * @property {PlanProvider['planKind']} planKind 首选路由的套餐种类。
 * @property {string} baseUrl 首选路由的 baseUrl。
 * @property {PlanProvider['authKind']} authKind 首选路由的鉴权形态。
 * @property {PlanProvider[]} routes 候选路由链，按套餐优先级排序（长度 ≥ 1）。
 */

/**
 * 把路由表合并成「一个 modelId 只出现一次」的模型清单。
 *
 * 这是 merged 模式的投影：`GLM-5.3-Flash` 在四条路由上都存在，展开视图会给出四条
 * DSH 模型，合并视图只给一条，但把四条路由按优先级收进 `routes` —— 运行时按这条链
 * 依次尝试，前一条额度用尽就换下一条（见 `lib/plan-client.js` 的
 * `streamMessagesAcrossRoutes`）。
 *
 * 顺序规则：
 * - 模型之间按「首选路由的优先级、再按路由上的声明顺序」排，所以 `GLM-5.3-Flash`
 *   （start-plan 上有）排在只有 coding-plan 才有的 `GLM-5.3` 之前 —— 与展开视图同序；
 * - 同一模型的多条路由按 `compareProviders` 排序，链首即最高优先级的套餐。
 *
 * @param {readonly PlanProvider[]} providers 路由表。
 * @returns {MergedPlanModel[]} 合并后的模型清单（每个 modelId 一条）。
 */
export function mergePlanModels(providers) {
  /** @type {Map<string, MergedPlanModel>} */
  const byModel = new Map()
  for (const provider of [...providers].sort(compareProviders)) {
    for (const modelId of provider.modelIds) {
      const existing = byModel.get(modelId)
      if (existing === undefined) {
        byModel.set(modelId, {
          id: modelId,
          modelId,
          providerId: provider.providerId,
          providerName: provider.providerName,
          planKind: provider.planKind,
          baseUrl: provider.baseUrl,
          authKind: provider.authKind,
          routes: [provider],
        })
      } else {
        existing.routes.push(provider)
      }
    }
  }
  return [...byModel.values()]
}
