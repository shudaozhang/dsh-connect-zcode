/**
 * dsh-connect-zcode — exposes the ZCode CLI's account-backed coding agent inside
 * DeepSeek Harness as a model provider.
 *
 * The plugin registers one provider route, `zcode-cli`, backed by the resident
 * app-server session the ZCode client itself uses (JSON-RPC over stdio, real streaming).
 * The CLI owns the account: when it answers `session/create` it also reports the
 * catalogue the signed-in account can actually serve, and the bridge republishes that
 * catalogue. Model ids, context capacity, output caps, image support and reasoning
 * levels therefore come from the running CLI rather than from constants here — a
 * hard-coded list would silently disagree with the account it claims to describe.
 *
 * History: this plugin began as a DSH integration for zcode2api (HTTP gateway plus
 * account pool). The gateway and the one-shot CLI route were removed on 2026-09-30;
 * use the upstream https://github.com/liu5269/zcode2api if you need them.
 *
 * The only dependencies are peer packages shipped with the harness; there are no
 * third-party runtime dependencies.
 *
 * @module dsh-connect-zcode
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'

import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

import { ZcodeAppServerAdapter, resolveSpawnPlan } from './app-server.js'
import { ZcodePlanAdapter } from './plan-adapter.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  FALLBACK_CATALOG,
  MODEL_MODALITIES,
  locateZcodeCli,
  locateZcodeDesktop,
  normalizeIdList,
  resolveZcodeDataRoot,
} from './zcode-runtime.js'

/** Package name; must equal the `name` in package.json and the bundle patch row name. */
export const name = 'dsh-connect-zcode'

/**
 * `llm` carries model-provider registration; `settings` owns the configuration card's
 * namespace (`settings.configure`) and is what makes this entry an addressable form.
 *
 * Declared as a COMPOSITION dependency, exactly like dsh-connect-workbuddy: without it the
 * plugin still mounts (model serving never depends on the settings page), but the card has
 * no page policy of its own.
 */
export const inject = ['llm', 'settings']

/** Plugin package directory (the parent of lib/). */
export const pluginDir = fileURLToPath(new URL('..', import.meta.url))

// ── configuration ─────────────────────────────────────────────────────────────

/**
 * One model the provider advertises, as the plugin resolves it.
 *
 * Configuration may pin entries; when it does not, the list is whatever the CLI reports
 * for the signed-in account.
 *
 * @typedef {object} CliModel
 * @property {string} id Model id exposed to DSH.
 * @property {string} name Display name.
 * @property {string | undefined} description Optional description.
 * @property {number} contextWindow Context window in tokens.
 * @property {number} maxTokens Maximum output tokens.
 * @property {readonly import('@deepseek-ai/dsh-llm').ModelModality[]} inputModalities Accepted input modalities.
 * @property {string} cliModelId Model id on the CLI side (the route this entry resolves to).
 */

/**
 * @typedef {object} ResolvedOptions
 * @property {boolean} enabled Whether the provider is registered.
 * @property {'plan' | 'agent' | 'both'} transport Which model channel(s) to register.
 * @property {'merged' | 'explicit'} planRouteMode How the direct channel projects the route table:
 *   `merged` = one entry per upstream model with an automatic plan-route fallback chain,
 *   `explicit` = one entry per (route × model) pair with no automatic switching.
 * @property {string} dataBaseDir Resolved ZCode data root ('' when unresolved).
 * @property {string} planCredentialStore Plugin-owned credential file path ('' when unresolved).
 * @property {string[]} planEnabledModelIds Model ids the direct channel should advertise ([] = all).
 * @property {string[]} planDisabledModelIds Model ids the direct channel should hide (applied last).
 * @property {string[]} planPinnedRoutes Route-qualified ids that pin a model to exactly those routes,
 *   disabling automatic failover for it (e.g. ccount:zai-start-plan#GLM-5.3-Flash).
 * @property {string} zcodeCliPath Resolved zcode.cjs path ('' when not found).
 * @property {string} zcodeCliNode Node executable used to run zcode.cjs.
 * @property {number} zcodeCliTimeoutMs Per-turn timeout in milliseconds.
 * @property {CliModel[]} cliModels Pinned models; empty means "whatever the CLI reports".
 * @property {string[]} enabledModelIds Model ids to advertise ([] = all reported models).
 * @property {string[]} disabledModelIds Model ids to hide even when enabled (applied last).
 * @property {string} cliCwd Working directory for the app-server session ('' = home).
 * @property {string} zcodeDataBaseDir ZCode data root ('' = home).
 * @property {string} zcodeClientRoot Desktop install root override ('' = auto-detect).
 * @property {'auto' | 'desktop' | 'node'} zcodeLaunchMode Which launcher shape to use.
 * @property {string} zcodeCliPathConfigured Explicit `zcodeCliPath` from configuration ('' = auto).
 * @property {import('./zcode-runtime.js').ZcodeDesktop | undefined} zcodeDesktop Detected desktop install.
 * @property {import('./zcode-runtime.js').ZcodeDataRoot | undefined} zcodeDataRoot Resolved data root.
 * @property {string} zcodeLauncherPath Desktop launcher to spawn ('' = node mode).
 * @property {Record<string, string>} zcodeSpawnEnv Environment overrides for the desktop CLI ({} in node mode).
 * @property {boolean} accountSync Whether to push the desktop coding-plan account overlay (desktop mode only).
 * @property {string[]} childEnvAllow Extra environment variables passed to the child.
 * @property {number} appServerTimeoutMs Per-request timeout in milliseconds.
 * @property {'deny' | 'allow-all'} authorizationPolicy How app-server permission requests are handled.
 * @property {number} maxTokens Default max_tokens.
 * @property {number} defaultContextWindow Default context window.
 * @property {import('@deepseek-ai/dsh-llm').ResolvedRetryPolicy} retryPolicy Resolved retry policy.
 */

/** @type {readonly import('@deepseek-ai/dsh-llm').ModelModality[]} */
const MODALITIES = /** @type {readonly import('@deepseek-ai/dsh-llm').ModelModality[]} */ ([...MODEL_MODALITIES])

/**
 * Models to advertise when neither the CLI nor configuration supplies a list.
 *
 * This is a last resort, not the catalogue: it exists so a misconfigured or logged-out
 * installation shows *something* actionable instead of an empty provider. `cliModels`
 * overrides it, and a working CLI always wins over both.
 *
 * @type {readonly CliModel[]}
 */
export const FALLBACK_CLI_MODELS = FALLBACK_CATALOG.map((entry) => ({
  id: entry.modelId,
  name: entry.label,
  description: entry.providerLabel,
  contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
  maxTokens: entry.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
  inputModalities: entry.supportsImage ? MODALITIES : /** @type {const} */ (['text']),
  cliModelId: entry.modelId,
}))

const catalogModel = z.object({
  id: z.string().required().description('Model id exposed to DSH (must be unique)'),
  name: z.string().description('Display name; default = the id'),
  description: z.string().description('Display description'),
  contextWindow: z.number().step(1).min(1).description('Context window; default = what the CLI reports'),
  maxTokens: z.number().step(1).min(1).description('Maximum output tokens; default = what the CLI reports'),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1)
    .description("Accepted input modalities; default = the CLI's own capability flags"),
  cliModelId: z.string()
    .description('CLI-side model id this entry resolves to; default = the DSH id'),
})

/**
 * Mark a Config field as volatile, where the installed schemastery supports it.
 *
 * WHY THIS IS REQUIRED, not cosmetic: the DSH settings service only offers a plugin's
 * fields to the configuration UI when they are volatile. `SettingsForms.describe()` runs
 * every entry's schema through `volatileForm()`, which keeps only `meta.volatile` fields
 * and returns `undefined` when there are none — and an entry with no form is skipped
 * entirely, so its namespace never appears in the describe mirror. The write gate agrees:
 * `isVolatilePath()` rejects any path without a volatile ancestor, so a normal field can
 * never be written through a settings form.
 *
 * The consequence, measured on this host before this marker existed: `enabledModelIds` and
 * `disabledModelIds` were ordinary fields, `include:dsh-connect-zcode` was absent from
 * `settings.describe()`, and every client-side attempt to bind a form for it came back
 * `unavailable` — the red "插件配置当前不可用" banner plus rejected writes. No amount of
 * namespace-spelling cleverness in the card could fix that, because the form did not exist.
 *
 * `volatile()` exists from schemastery 3.18.3 (the DSH 0.1.7 line, the only line whose
 * settings write gate reads the marker). Older pinning has no such method and the schema
 * must stay byte-identical to the unmarked original there — hand-setting `meta.volatile`
 * would bypass schemastery's own `validateVolatileSchema` checks — so this degrades to an
 * identity no-op. Same contract (and same reasoning) as dsh-connect-workbuddy's helper.
 *
 * @param {any} schema The field schema to mark.
 * @returns {any} The volatile-marked schema, or the input unchanged on an older line.
 */
export function asVolatile(schema) {
  if (typeof schema.volatile === 'function') return schema.volatile()
  return schema
}

/**
 * Read a possibly-volatile Config field.
 *
 * schemastery resolves a volatile field to a live `{ get(): T }` reference rather than the
 * value itself, so `Array.isArray(config.enabledModelIds)` is false on a marked schema even
 * though the configured value is an array. Every read of a volatile field must go through
 * here. One level is all a caller needs; {@link unwrapVolatileDeep} exists for the case
 * where a whole config object is handed to a service that validates and clones it.
 *
 * @template T
 * @param {T | { get(): T }} value Raw field value, possibly a live reference.
 * @returns {T} The current value.
 */
export function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && 'get' in value && typeof (/** @type {any} */ (value).get) === 'function') {
    return /** @type {any} */ (value).get()
  }
  return /** @type {any} */ (value)
}

/**
 * Deep copy of a config value with every `{ get(): T }` live reference replaced by the
 * value it resolves to.
 *
 * {@link unwrapVolatile} peels only the one level a caller reads, which is what the
 * ordinary option paths need. Handing a config object to a settings service is different:
 * the service validates and clones the WHOLE object, so a reference surviving anywhere
 * inside it fails validation with a message naming the field but not the cause.
 *
 * @param {any} value Value that may contain live references at any depth.
 * @returns {any} The same shape with every reference resolved.
 */
export function unwrapVolatileDeep(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get === 'function') return unwrapVolatileDeep(value.get())
  if (Array.isArray(value)) return value.map((entry) => unwrapVolatileDeep(entry))
  /** @type {Record<string, any>} */
  const out = {}
  for (const key of Object.keys(value)) out[key] = unwrapVolatileDeep(value[key])
  return out
}

export const Config = z.object({
  enabled: z.boolean().default(true).description('Master switch: when off, no model provider is registered'),
  transport: z.union(['plan', 'agent', 'both']).default('plan')
    .description('模型通道：plan = 直连计划额度端点（HTTP，不启动 agent，推荐）；agent = 托管 ZCode agent 子进程（旧通道）；both = 两条都注册'),
  planRouteMode: z.union(['merged', 'explicit']).default('merged')
    .description('直连通道的模型清单投影：merged = 一个模型只出现一次（如 GLM-5.3-Flash），请求时按套餐优先级自动切换路由；explicit = 一条路由 × 一个模型（account:zai-start-plan#GLM-5.3-Flash），手动指定烧哪条套餐'),
  planEnabledModelIds: asVolatile(z.array(z.string()).default([])
    .description('直连通道只启用这些模型（merged 模式写 GLM-5.3-Flash；explicit 模式写 account:zai-start-plan#GLM-5.3-Flash）。留空 = 全部启用；可用 `plan-models` 命令查看可填的 id')),
  planDisabledModelIds: asVolatile(z.array(z.string()).default([])
    .description('直连通道额外停用的模型 id（优先级高于 planEnabledModelIds）')),
  planPinnedRoutes: asVolatile(z.array(z.string()).default([])
    .description('把某个模型严格钉死到指定套餐路由（写 `<providerId>#<modelId>`，如 account:zai-start-plan#GLM-5.3-Flash）：只烧这一条，额度用尽也不切换。留空 = 允许自动切换；想让路由「优先但保留兜底」请改用 planEnabledModelIds')),
  planCredentialStore: z.string().default('')
    .description('插件自有的凭证文件路径（`login` 命令写入）；留空 = <dataBaseDir>/.zcode/dsh-plan-credentials.json。绝不写回 ZCode 客户端的 credentials.json'),
  zcodeCliPath: z.string().default('')
    .description('Path to zcode.cjs; empty = auto-detect the ZCode client or an npm-installed zcode-app-cli'),
  zcodeCliNode: z.string().default('node').description('Node executable used to run zcode.cjs'),
  zcodeClientRoot: z.string().default('')
    .description('ZCode 桌面客户端安装目录（如 E:\\zcode）；留空 = 自动探测（注册表卸载项、Program Files、LOCALAPPDATA 等已知位置）'),
  zcodeLaunchMode: z.union(['auto', 'desktop', 'node']).default('auto')
    .description('启动方式：auto = 检测到桌面客户端就用它的 launcher 启动，否则用 node 直接运行 CLI；desktop / node 强制指定其一'),
  zcodeCliTimeoutMs: z.number().step(1).min(5000).default(900000)
    .description('Timeout for one app-server turn (session/send until the turn completes), in milliseconds'),
  cliModels: z.array(catalogModel).default([])
    .description('Pin the advertised model list. Empty (the default) follows the catalogue the CLI reports for the signed-in account'),
  enabledModelIds: asVolatile(z.array(z.string()).default([])
    .description('只启用这些模型（按 CLI 上报的 modelId 填写）。留空 = 全部启用；填了就以它为准，可用 `models` 命令查看可填的 id')),
  disabledModelIds: asVolatile(z.array(z.string()).default([])
    .description('额外停用的模型 id（优先级高于 enabledModelIds，用于在“全部启用”时只关掉个别模型）')),
  cliCwd: z.string().default('').description('Working directory of the app-server session; empty = user home'),
  zcodeDataBaseDir: z.string().default('')
    .description('ZCode data root (credentials and runtime releases); empty = user home (~/.zcode/v2)'),
  childEnvAllow: z.array(z.string()).default([])
    .description('Extra environment variable names passed through to the app-server child; by default only system basics, ZCODE_* and NODE_EXTRA_CA_CERTS are forwarded'),
  authorizationPolicy: z.union(['deny', 'allow-all']).default('deny')
    .description('Deny agent permission requests by default. Set to allow-all only if you accept unattended tool execution.'),
  accountSync: z.boolean().default(true)
    .description('桌面客户端启动时推送编码套餐账号路由（provider/updateAccountConfig + provider/refreshRegistry），让 account:bigmodel-team-coding-plan/GLM-5.3 进入模型列表；仅在 desktop 启动方式下生效'),
  appServerTimeoutMs: z.number().step(1).min(5000).default(120000)
    .description('Timeout for a single app-server request (create/subscribe/send), in milliseconds'),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS)
    .description('Default maximum output tokens when the CLI reports none'),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW)
    .description('Default context window when the CLI reports none'),
  retryPolicy: RetryPolicySchema,
})

/**
 * Validate and normalise configured model pins.
 *
 * Every optional field is materialised here so downstream code never has to re-apply
 * defaults, and duplicate ids are rejected because DSH keys models by id.
 *
 * @param {readonly Partial<CliModel>[] | undefined} models Raw catalog from configuration.
 * @returns {CliModel[]} Normalised pins; empty when configuration pins nothing.
 */
function resolveModels(models) {
  if (!Array.isArray(models)) return []
  /** @type {Set<string>} */
  const seen = new Set()
  return models.map((model) => {
    const id = (model.id ?? '').trim()
    if (id === '') throw new Error('zcode: model id must not be empty')
    if (seen.has(id)) throw new Error(`zcode: model "${id}" is duplicated`)
    seen.add(id)
    const name = (model.name ?? '').trim() || id
    const inputModalities = model.inputModalities ?? MODEL_MODALITIES
    if (inputModalities.length === 0) throw new Error(`zcode: model "${id}" has no inputModalities`)
    return {
      id,
      name,
      description: model.description,
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
      inputModalities: [...inputModalities],
      cliModelId: (model.cliModelId ?? '').trim() || id,
    }
  })
}

/**
 * Resolve the configuration into a read-only runtime snapshot; invalid values throw.
 *
 * @param {any} config Raw plugin configuration.
 * @returns {ResolvedOptions} Resolved options.
 */
export function resolveOptions(config) {
  if (config.defaultContextWindow !== undefined && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('zcode: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('zcode: maxTokens must be a positive integer')
  }
  const zcodeCliTimeoutMs = config.zcodeCliTimeoutMs ?? 900000
  if (!Number.isSafeInteger(zcodeCliTimeoutMs) || zcodeCliTimeoutMs < 5000) {
    throw new Error('zcode: zcodeCliTimeoutMs must be an integer not smaller than 5000')
  }

  const zcodeCliPathConfigured = (config.zcodeCliPath ?? '').trim()
  const zcodeCliNode = (config.zcodeCliNode ?? 'node').trim() || 'node'
  const cliCwd = (config.cliCwd ?? '').trim()
  const zcodeDataBaseDir = (config.zcodeDataBaseDir ?? '').trim()
  const zcodeClientRoot = (config.zcodeClientRoot ?? '').trim()
  const zcodeLaunchMode = config.zcodeLaunchMode === 'desktop' || config.zcodeLaunchMode === 'node'
    ? config.zcodeLaunchMode
    : 'auto'

  // Desktop discovery is resolved once per configuration and handed to the adapter through
  // the resolved options, so the log line and the spawn plan can never disagree about
  // which client is in use. Discovery must never take the plugin down: a broken install
  // simply degrades to the npm-CLI (node) launch path.
  /** @type {import('./zcode-runtime.js').ZcodeDataRoot | undefined} */
  let zcodeDataRoot
  try {
    zcodeDataRoot = resolveZcodeDataRoot(zcodeDataBaseDir)
  } catch {
    zcodeDataRoot = undefined
  }
  /** @type {import('./zcode-runtime.js').ZcodeDesktop | undefined} */
  let zcodeDesktop
  if (zcodeLaunchMode !== 'node') {
    try {
      zcodeDesktop = locateZcodeDesktop(zcodeClientRoot)
    } catch {
      zcodeDesktop = undefined
    }
  }

  const zcodeCliPath = locateZcodeCli(zcodeCliPathConfigured)
  const spawnPlan = resolveSpawnPlan({
    zcodeLaunchMode,
    zcodeCliPath,
    zcodeCliPathConfigured,
    zcodeCliNode,
    cliCwd,
    zcodeDesktop,
    zcodeDataRoot,
  })

  const transport = config.transport === 'agent' || config.transport === 'both'
    ? config.transport
    : 'plan'
  const planRouteMode = config.planRouteMode === 'explicit' ? 'explicit' : 'merged'
  const dataBaseDir = zcodeDataRoot === undefined ? '' : zcodeDataRoot.dataBaseDir
  const planCredentialStore = (config.planCredentialStore ?? '').trim() !== ''
    ? /** @type {string} */ (config.planCredentialStore).trim()
    : (dataBaseDir === '' ? '' : path.join(dataBaseDir, '.zcode', 'dsh-plan-credentials.json'))

  return {
    enabled: config.enabled !== false,
    transport,
    planRouteMode,
    dataBaseDir,
    planCredentialStore,
    planEnabledModelIds: normalizeIdList(unwrapVolatile(config.planEnabledModelIds)),
    planDisabledModelIds: normalizeIdList(unwrapVolatile(config.planDisabledModelIds)),
    planPinnedRoutes: normalizeIdList(unwrapVolatile(config.planPinnedRoutes)),
    zcodeCliPath,
    zcodeCliNode,
    zcodeCliTimeoutMs,
    cliModels: resolveModels(config.cliModels),
    // Volatile fields resolve to a live `{ get(): T }` reference, not an array, so they
    // must be unwrapped before normalization. See {@link asVolatile}.
    enabledModelIds: normalizeIdList(unwrapVolatile(config.enabledModelIds)),
    disabledModelIds: normalizeIdList(unwrapVolatile(config.disabledModelIds)),
    cliCwd,
    zcodeDataBaseDir,
    zcodeClientRoot,
    zcodeLaunchMode,
    zcodeCliPathConfigured,
    zcodeDesktop,
    zcodeDataRoot,
    zcodeLauncherPath: spawnPlan.mode === 'desktop' ? spawnPlan.launcher : '',
    zcodeSpawnEnv: spawnPlan.mode === 'desktop' ? spawnPlan.spawnEnv : {},
    childEnvAllow: Array.isArray(config.childEnvAllow)
      ? config.childEnvAllow.filter(/** @type {(key: unknown) => boolean} */ ((key) => typeof key === 'string' && key.trim() !== ''))
      : [],
    authorizationPolicy: config.authorizationPolicy === 'allow-all' ? 'allow-all' : 'deny',
    accountSync: config.accountSync !== false,
    appServerTimeoutMs: config.appServerTimeoutMs ?? 120000,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'zcode: retryPolicy'),
  }
}

// ── apply ─────────────────────────────────────────────────────────────────────

/**
 * Plugin entry point: register provider `zcode-cli` and its app-server adapter.
 *
 * @param {any} ctx Cordis context (the `llm` service is injected).
 * @param {any} config Raw plugin configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console

  // Configuration hot-reload: one invalid edit must not take down a running plugin,
  // so keep the last usable configuration.
  /** @type {(() => any)} */
  let current = () => config
  /** @type {any} */
  let lastRaw
  /** @type {ResolvedOptions | undefined} */
  let lastGood
  /**
   * Bumped on every `loader/volatile-update`.
   *
   * A volatile edit does NOT replace the configuration object: the Loader rewrites the
   * backing store of the live `{ get() }` references in place. Keying the cache on object
   * identity alone (`raw === lastRaw`) would therefore serve the pre-edit model selection
   * for the rest of the process — the card would toggle, the document would be written,
   * and the picker would never change. The epoch makes the cache notice.
   */
  let volatileEpoch = 0
  /** Epoch the cached resolution was taken at. */
  let lastEpoch = -1
  /**
   * @returns {ResolvedOptions}
   */
  const options = () => {
    const raw = current()
    if (raw === lastRaw && volatileEpoch === lastEpoch && lastGood !== undefined) return lastGood
    try {
      const next = resolveOptions(raw)
      lastRaw = raw
      lastEpoch = volatileEpoch
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      lastEpoch = volatileEpoch
      logger.error?.('zcode: invalid configuration, keeping the last usable one')
      logger.error?.(error)
      return lastGood
    }
  }
  options()

  // A settings form writes model selection as a volatile update: no remount, no new config
  // object, so the only signal is this event. Dropping the cached resolution is enough —
  // `effectiveModels()` re-reads `options()` on every catalogue call.
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      volatileEpoch += 1
      logger.info?.('zcode: volatile configuration update, re-resolving options')
    })
  }

  const initial = options()

  // One concise detection line: which client will be launched and where its data lives.
  // `zcodeLaunchMode: 'desktop'` is an explicit instruction, so failing to find a client
  // is a warning (the spawn plan then falls back to the node launcher).
  if (initial.enabled && initial.zcodeLaunchMode !== 'node') {
    if (initial.zcodeDesktop !== undefined) {
      const dataBaseDir = initial.zcodeDataRoot === undefined ? '(unresolved)' : initial.zcodeDataRoot.dataBaseDir
      logger.info?.(`zcode: ZCode desktop client detected at ${initial.zcodeDesktop.root} (version ${initial.zcodeDesktop.version}), data root ${dataBaseDir}`)
    } else if (initial.zcodeLaunchMode === 'desktop') {
      logger.warn?.('zcode: zcodeLaunchMode="desktop" but no ZCode desktop client was detected; falling back to the node launcher (set zcodeClientRoot to the install root)')
    }
  }

  const adapter = new ZcodeAppServerAdapter({
    options,
    resolveAttachments: () => (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined),
    logger,
  })

  // The direct-HTTP channel. It shares the resolved options (for retry policy, timeouts and
  // the data root) but none of the agent machinery: no child process, no session map, no
  // turn lock. That is the whole point of `transport: 'plan'` being the default.
  const planAdapter = new ZcodePlanAdapter({
    options,
    logger,
    resolveAttachments: () => (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined),
  })

  const entryNs = ctx.fiber?.entry?.options?.id ?? name

  ctx.effect(() => () => {
    if (typeof adapter.dispose === 'function') adapter.dispose()
    if (typeof planAdapter.dispose === 'function') planAdapter.dispose()
  }, 'zcode: adapters')

  // A volatile edit (model switches on the plugin page) must invalidate the direct
  // channel's cached route table too, or the picker would keep offering the old list.
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      if (typeof planAdapter.refreshCatalogue === 'function') planAdapter.refreshCatalogue()
    })
  }

  // Register this instance's settings page policy, the same way dsh-connect-workbuddy does.
  // `auto: true` is the default (`describe()` reads `presentations.get(fiber)?.auto ?? true`),
  // so this is not what makes the namespace visible — the volatile Config fields are. It is
  // declared explicitly anyway because it pins the intent to this fiber and keeps the two
  // connectors symmetric.
  if (typeof ctx.inject === 'function' && ctx.settings !== undefined) {
    ctx.effect(() => ctx.settings.configure({ auto: true }, ctx.fiber), 'zcode-cli: settings page policy')
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (/** @type {any} */ sctx) => {
      ctx.effect(() => sctx.settings.configure({ auto: true }, ctx.fiber), 'zcode-cli: settings page policy')
    })
  }

  if (initial.enabled) {
    // ── direct-HTTP plan channel (default) ──────────────────────────────────────
    if (initial.transport !== 'agent') {
      try {
        const catalogue = planAdapter.catalogue()
        const providers = catalogue.providers.length
        if (providers === 0) {
          logger.warn?.('zcode: the plan route table is empty, provider "zcode-plan" not registered')
        } else {
          ctx.llm.registerConfigurableProviders([{
            provider: 'zcode-plan',
            displayName: 'zcode (plan)',
            settingsNs: entryNs,
            settingsPath: [],
          }])
          ctx.llm.registerAdapter(['zcode-plan'], planAdapter)
          const source = catalogue.source === 'builtin-release' ? 'client release' : 'built-in fallback'
          const mode = initial.planRouteMode === 'explicit' ? 'explicit routes, no auto-failover' : 'merged models, auto-failover across plan routes'
          logger.info?.(`zcode: provider "zcode-plan" registered (direct HTTP plan channel, ${providers} routes from ${source}, ${mode}); no agent process is started`)
          // A pin changes the failure semantics — quota exhaustion becomes an error instead of a
          // switch to another plan — so it belongs in the startup log, not only in a model
          // description the picker may truncate.
          if (initial.planPinnedRoutes.length !== 0) {
            logger.info?.(`zcode: planPinnedRoutes pins ${initial.planPinnedRoutes.length} model/route pair(s); those models will NOT fail over: ${initial.planPinnedRoutes.join(', ')}`)
          }
        }
      } catch (/** @type {any} */ error) {
        logger.error?.(`zcode: could not build the plan route table: ${error?.message ?? error}`)
      }
    }

    // ── legacy agent channel ───────────────────────────────────────────────────
    if (initial.transport !== 'plan') {
      if (initial.zcodeCliPath !== '' || initial.zcodeLauncherPath !== '') {
        ctx.llm.registerConfigurableProviders([{
          provider: 'zcode-cli',
          displayName: 'zcode',
          settingsNs: entryNs,
          settingsPath: [],
        }])
        ctx.llm.registerAdapter(['zcode-cli'], adapter)
        const pinned = initial.cliModels.length === 0
          ? 'follow the CLI catalogue'
          : `pinned=${initial.cliModels.map((model) => model.id).join('/')}`
        const launch = initial.zcodeLauncherPath === '' ? 'node' : 'desktop'
        logger.info?.(`zcode: provider "zcode-cli" registered (app-server account route), launch=${launch}, models=${pinned}`)
      } else {
        logger.warn?.('zcode: no ZCode CLI found, provider "zcode-cli" not registered (set the zcodeCliPath option, or zcodeClientRoot for a desktop install)')
      }
    }
  }

  logger.info?.(`zcode: loaded, transport="${initial.transport}"`)
}

export { ZcodeAppServerAdapter }
export default { name, inject, Config, apply }
