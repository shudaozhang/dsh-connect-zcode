// 计划额度直连通道的 DSH 适配器（`lib/plan-adapter.js`）。
//
// 这个模块的价值全在四件纯逻辑上，每一件都能完全离线验证：
//
//   1. 模型清单归一 —— 从客户端 release 的 providerRules / modelRules 推出「有哪些模型、
//      各自什么能力」，读不到就降级到内置快照；
//   2. 模型 id 解析 —— `<providerId>#<modelId>` 规范形式 + 裸 modelId / 斜杠写法；
//   3. 请求体翻译 —— DSH 的 GenerateOptions → Anthropic Messages；
//   4. 事件映射 —— plan-client 的统一事件 → DSH 的 StreamChunk。
//
// 所以下面的测试一个真实网络请求都不发、也不读真实磁盘：需要 release 的地方注入假
// `readFile`，需要 HTTP 的地方注入假 `fetch`，需要凭证的地方注入假 reader。
//
// 唯一没法在这里覆盖的是「上游确实认这组请求头/这个请求体」：本机套餐无额度，实测只能
// 拿到业务码（1005 / 1309 / 3009），证明链路通但拿不到正常内容流。那份证据记在
// `lib/plan-client.js` 的模块文档里。
import assert from 'node:assert/strict'
import test from 'node:test'

import { LlmError } from '@deepseek-ai/dsh-llm'

import {
  DEFAULT_MODEL_TRAITS,
  FALLBACK_MODEL_TRAITS,
  PLAN_ERROR_CODE_MAP,
  PLAN_PROVIDER_ID,
  PlanStreamMapper,
  SESSION_TITLE_FALLBACK,
  ZcodePlanAdapter,
  applyRouteExclusions,
  applyRoutePins,
  applyStrictPins,
  describeModelDescription,
  validateRoutePins,
  buildPlanModels,
  defaultReasoningLevelOf,
  describeRouteChain,
  finishReasonFor,
  loadModelTraits,
  localSessionTitle,
  normalizeModelRules,
  resolveModelTraits,
  selectPlanModels,
  thinkingFieldsFor,
  toAnthropicRequest,
  toLlmError,
  traitsForModel,
} from '../lib/plan-adapter.js'
import { PlanClientError } from '../lib/plan-client.js'
import { restrictRoutesToPins, routesForModel } from '../lib/plan-routes.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 两条计划路由（与客户端 3.16.3 的 providerRules 同形）。 */
const PROVIDERS = [
  {
    providerId: 'account:zai-start-plan',
    providerName: 'Start Plan',
    family: 'zai',
    planKind: 'start-plan',
    baseUrl: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
    modelIds: ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo'],
    authKind: 'bearer-jwt',
  },
  {
    providerId: 'account:zai-individual-coding-plan',
    providerName: 'Z.AI Individual Coding Plan',
    family: 'zai',
    planKind: 'individual-coding-plan',
    baseUrl: 'https://api.z.ai/api/anthropic',
    modelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
    authKind: 'api-key',
  },
]

/**
 * 客户端 release 的 `modelConfigRules.modelRules` 片段：**由宽到窄**排列，
 * 窄规则只写与宽规则不同的字段 —— 这正是需要「后匹配覆盖」的原因。
 */
const MODEL_RULES = [
  { modelMatch: '.*', config: { properties: { contextWindow: 200000, inputFormat: { supportsImage: false } }, optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] }, maxOutputTokens: { max: 64000 } } } },
  { modelMatch: '.*glm-5.*', config: { properties: { contextWindow: 200000, inputFormat: { supportsImage: false } }, optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] }, maxOutputTokens: { max: 64000 } } } },
  { modelMatch: '.*GLM-5\\.2.*', config: { properties: { contextWindow: 1000000, inputFormat: { supportsImage: false } }, optionSpecs: { reasoningLevel: { values: ['disabled', 'high', 'max'] }, maxOutputTokens: { max: 128000 } } } },
  { modelMatch: '.*glm-5\\.3.*', config: { properties: { contextWindow: 1000000, inputFormat: { supportsImage: false } }, optionSpecs: { reasoningLevel: { values: ['low', 'high', 'max'] }, maxOutputTokens: { max: 128000 } } } },
  // 只改图片支持：上下文/输出/档位都继承上面的 `.*glm-5\.3.*`。
  { modelMatch: '.*glm-5\\.3-flash.*', config: { properties: { inputFormat: { supportsImage: true } } } },
]

/** 一条完整的假 release 对象。 */
const RELEASE = {
  revision: 33,
  config: {
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { modelRules: MODEL_RULES },
  },
}

/** 假配置（`ResolvedOptions` 的结构子集；只填 adapter 会读的字段）。 */
const makeOptions = (overrides = {}) => () => ({
  zcodeDataRoot: { dataBaseDir: 'D:/fake-zcode' },
  zcodeDataBaseDir: '',
  zcodeCliPath: '',
  // The plan channel's own switches (index.js resolveOptions materializes these).
  planEnabledModelIds: [],
  planDisabledModelIds: [],
  planCredentialStore: '',
  enabledModelIds: [],
  disabledModelIds: [],
  retryPolicy: { mode: 'normal', maxRetries: 5, retryableCodes: ['RATE_LIMIT'], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 },
  ...overrides,
})

/** 一份含所有必需凭证的假凭证表。 */
const CREDENTIALS = {
  zcodejwttoken: 'jwt-token',
  'account-provider:coding-plan:account:zai-individual-coding-plan:account:12345:api-key': 'plan-key',
}

/**
 * 造一个直接返回固定文本的假 fetch。
 *
 * @param {string} body 响应体。
 * @param {number} [status] HTTP 状态。
 * @param {Record<string, string>} [headers] 响应头。
 * @returns {typeof fetch} 假 fetch。
 */
function textFetch(body, status = 200, headers = { 'content-type': 'application/json' }) {
  return /** @type {typeof fetch} */ (async () => new Response(body, { status, headers }))
}

/**
 * 造一个 SSE 假 fetch（一次把整段字节推完，足够验证事件映射）。
 *
 * @param {string} sse 完整 SSE 文本。
 * @returns {typeof fetch} 假 fetch。
 */
function sseFetch(sse) {
  return /** @type {typeof fetch} */ (async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  ))
}

/**
 * 造一个 adapter（全部依赖注入，零磁盘零网络）。
 *
 * @param {object} [options] 参数。
 * @param {Record<string, string | null>} [options.credentials] 凭证表。
 * @param {typeof fetch} [options.fetchImpl] 假 fetch。
 * @param {any[]} [options.providers] 注入路由表。
 * @param {any} [options.config] 配置覆盖。
 * @param {any} [options.logger] 日志。
 * @param {Record<string, string>} [options.planCredentials] 插件自有凭证（`login` 写的那份）。
 * @returns {ZcodePlanAdapter} 适配器。
 */
function makeAdapter({ credentials = CREDENTIALS, fetchImpl, providers = PROVIDERS, config = {}, logger, planCredentials } = {}) {
  const adapter = new ZcodePlanAdapter({
    options: makeOptions(config),
    readCredentials: () => credentials,
    providers: () => providers,
    ...(planCredentials === undefined ? {} : { readPlanCredentials: () => planCredentials }),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(logger === undefined ? {} : { logger }),
  })
  // 模型能力走注入的规则，不读真实 release。
  adapter.traitSourceCache = { rules: MODEL_RULES, source: 'injected' }
  return adapter
}

/**
 * 收集一个 stream 的全部 chunk。
 *
 * @param {AsyncIterable<any>} iterable chunk 流。
 * @returns {Promise<any[]>} 全部 chunk。
 */
async function collect(iterable) {
  /** @type {any[]} */
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

// ---------------------------------------------------------------------------
// 模型能力：release modelRules → PlanModelTraits
// ---------------------------------------------------------------------------

test('resolveModelTraits merges wide-to-narrow rules: narrow rules only override the fields they state', () => {
  const glm53 = resolveModelTraits('GLM-5.3', MODEL_RULES)
  assert.equal(glm53.matched, true)
  assert.equal(glm53.traits.contextWindow, 1000000, 'the narrow .*glm-5\\.3.* rule wins over .*')
  assert.equal(glm53.traits.maxOutputTokens, 128000)
  assert.equal(glm53.traits.supportsImage, false)
  assert.deepEqual(glm53.traits.reasoningLevels, ['low', 'high', 'max'])

  const flash = resolveModelTraits('GLM-5.3-Flash', MODEL_RULES)
  assert.equal(flash.traits.contextWindow, 1000000, 'the flash rule states no context, so it inherits 1M')
  assert.equal(flash.traits.supportsImage, true, 'the flash rule is the only one that turns images on')
  assert.deepEqual(flash.traits.reasoningLevels, ['low', 'high', 'max'])

  const turbo = resolveModelTraits('GLM-5-Turbo', MODEL_RULES)
  assert.equal(turbo.traits.contextWindow, 200000, 'only the broad rules match, so 200K / 64K')
  assert.equal(turbo.traits.maxOutputTokens, 64000)
  assert.deepEqual(turbo.traits.reasoningLevels, ['disabled', 'enabled'])
})

test('resolveModelTraits matches case-insensitively (the real release mixes .*glm-5.* and .*GLM-5\\.2.*)', () => {
  const lower = resolveModelTraits('glm-5.2', MODEL_RULES)
  const upper = resolveModelTraits('GLM-5.2', MODEL_RULES)
  assert.deepEqual(lower.traits, upper.traits)
  assert.deepEqual(upper.traits.reasoningLevels, ['disabled', 'high', 'max'])
})

test('resolveModelTraits reports no match for an unknown model and falls back to the default traits', () => {
  // The fixture deliberately starts with a `.*` catch-all (the real release does too), so an
  // "unknown" model only exists for a rule set that has no catch-all.
  const narrowRules = MODEL_RULES.filter((rule) => rule.modelMatch !== '.*')
  const unknown = resolveModelTraits('not-a-model-at-all', narrowRules)
  assert.equal(unknown.matched, false)
  assert.deepEqual(unknown.traits, DEFAULT_MODEL_TRAITS)
  // The catch-all does match everything — that is how the client guarantees a fallback rule.
  assert.equal(resolveModelTraits('not-a-model-at-all', MODEL_RULES).matched, true)
  // An empty rule list (release missing) is the "no match" case too.
  assert.equal(resolveModelTraits('GLM-5.3', []).matched, false)
  assert.equal(resolveModelTraits('GLM-5.3', undefined).matched, false)
})

test('resolveModelTraits skips malformed rules instead of throwing', () => {
  const rules = [
    null,
    { modelMatch: 42 },
    { modelMatch: '([' }, // invalid regex
    { modelMatch: '.*', config: null },
    { modelMatch: '.*glm', config: { properties: { contextWindow: 'big' } } },
  ]
  const resolved = resolveModelTraits('GLM-5.3', rules)
  assert.equal(resolved.matched, true, 'the `.*` catch-all matches even though its config is null')
  assert.equal(resolved.traits.contextWindow, DEFAULT_MODEL_TRAITS.contextWindow, 'an unparseable number is ignored, not trusted')
})

test('traitsForModel prefers release rules and falls back to the static snapshot per model', () => {
  const source = { rules: MODEL_RULES, source: 'injected' }
  assert.equal(traitsForModel('GLM-5-Turbo', source).contextWindow, 200000)

  // No rules at all: the snapshot answers for the models it knows.
  const empty = { rules: [], source: 'fallback' }
  assert.deepEqual(traitsForModel('GLM-5.3-Flash', empty), FALLBACK_MODEL_TRAITS.get('GLM-5.3-Flash'))
  assert.equal(traitsForModel('GLM-5.3-Flash', empty).supportsImage, true)
  assert.equal(traitsForModel('GLM-5-Turbo', empty).maxOutputTokens, 64000)
  // A model the snapshot does not know degrades to the neutral default, never to undefined.
  assert.deepEqual(traitsForModel('unknown-model', empty), DEFAULT_MODEL_TRAITS)
})

test('normalizeModelRules tolerates a missing/malformed release shape', () => {
  assert.equal(normalizeModelRules(RELEASE).length, MODEL_RULES.length)
  assert.deepEqual(normalizeModelRules(null), [])
  assert.deepEqual(normalizeModelRules({}), [])
  assert.deepEqual(normalizeModelRules({ config: { modelConfigRules: { modelRules: 'nope' } } }), [])
})

test('loadModelTraits reads modelRules out of a known release file, and degrades to the fallback when it cannot', () => {
  /** @type {string[]} */
  const reads = []
  const readFile = (/** @type {string} */ filePath) => {
    reads.push(filePath)
    return JSON.stringify(RELEASE)
  }
  const loaded = loadModelTraits({ releasePath: 'D:/fake/release/zcode-builtin.json', readFile })
  assert.deepEqual(reads, ['D:/fake/release/zcode-builtin.json'])
  assert.equal(loaded.source, 'builtin-release')
  assert.equal(loaded.releasePath, 'D:/fake/release/zcode-builtin.json')
  assert.equal(loaded.rules.length, MODEL_RULES.length)

  // A release with no model rules degrades instead of advertising nothing usable.
  const empty = loadModelTraits({
    releasePath: 'D:/fake/release/zcode-builtin.json',
    readFile: () => JSON.stringify({ revision: 1, config: {} }),
  })
  assert.equal(empty.source, 'fallback')
  assert.deepEqual(empty.rules, [])
  assert.match(String(empty.reason), /declares no model rules/u)

  // An unreadable/corrupt release degrades too, and never throws.
  const broken = loadModelTraits({
    releasePath: 'D:/fake/release/zcode-builtin.json',
    readFile: () => '{not json',
  })
  assert.equal(broken.source, 'fallback')
  assert.deepEqual(broken.rules, [])
  assert.match(String(broken.reason), /cannot parse/u)

  // No release path at all (client not installed) is the fallback case, never a throw.
  const missing = loadModelTraits({ dataBaseDir: 'D:/definitely-not-here', readFile })
  assert.equal(missing.source, 'fallback')
  assert.deepEqual(missing.rules, [])
  assert.ok(missing.reason !== undefined)
})

test('defaultReasoningLevelOf picks max when offered, else the strongest declared level', () => {
  assert.equal(defaultReasoningLevelOf(['low', 'high', 'max']), 'max')
  assert.equal(defaultReasoningLevelOf(['disabled', 'high', 'max']), 'max')
  assert.equal(defaultReasoningLevelOf(['disabled', 'enabled']), 'enabled')
  assert.equal(defaultReasoningLevelOf([]), undefined)
})

// ---------------------------------------------------------------------------
// 模型清单 + id 规则
// ---------------------------------------------------------------------------

test('buildPlanModels(explicit) exposes ids as <providerId>#<modelId> in route-priority order', () => {
  const models = buildPlanModels(PROVIDERS, 'explicit')
  assert.deepEqual(models.map((entry) => entry.id), [
    'account:zai-start-plan#GLM-5.3-Flash',
    'account:zai-start-plan#GLM-5.2',
    'account:zai-start-plan#GLM-5-Turbo',
    'account:zai-individual-coding-plan#GLM-5.3',
    'account:zai-individual-coding-plan#GLM-5.3-Flash',
  ])
  // The same upstream modelId appears on two routes: both entries stay, distinguished by id.
  const flash = models.filter((entry) => entry.modelId === 'GLM-5.3-Flash')
  assert.equal(flash.length, 2)
  assert.deepEqual(flash.map((entry) => entry.providerId), ['account:zai-start-plan', 'account:zai-individual-coding-plan'])
  assert.equal(models[0].authKind, 'bearer-jwt')
  assert.equal(models[3].authKind, 'api-key')
  // Explicit mode never has a fallback chain: one entry, one route.
  for (const entry of models) assert.equal(entry.routes.length, 1)
})

test('buildPlanModels (default = merged) collapses each model into one entry with its route chain', () => {
  const models = buildPlanModels(PROVIDERS)
  assert.deepEqual(models.map((entry) => entry.id), ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo', 'GLM-5.3'])
  // GLM-5.3-Flash lives on both routes; merged mode keeps ONE entry and records both routes,
  // in plan-priority order (start-plan before individual-coding-plan).
  const flash = models.find((entry) => entry.modelId === 'GLM-5.3-Flash')
  assert.deepEqual(flash?.routes.map((route) => route.providerId), [
    'account:zai-start-plan',
    'account:zai-individual-coding-plan',
  ])
  assert.equal(flash?.providerId, 'account:zai-start-plan', 'the first chain entry is the preferred route')
  // A model only one route serves still gets a chain of length 1.
  const turbo = models.find((entry) => entry.modelId === 'GLM-5-Turbo')
  assert.deepEqual(turbo?.routes.map((route) => route.providerId), ['account:zai-start-plan'])
})

test('selectPlanModels(explicit): empty allow list = everything, block list wins, unknown ids are reported', () => {
  const models = buildPlanModels(PROVIDERS, 'explicit')
  assert.equal(selectPlanModels(models, [], [], 'explicit').models.length, models.length)

  const allow = selectPlanModels(models, ['account:zai-individual-coding-plan#GLM-5.3'], [], 'explicit')
  assert.deepEqual(allow.models.map((entry) => entry.id), ['account:zai-individual-coding-plan#GLM-5.3'])
  assert.deepEqual(allow.unknownEnabledIds, [])

  const block = selectPlanModels(models, [], ['account:zai-start-plan#GLM-5.2'], 'explicit')
  assert.equal(block.models.length, models.length - 1)
  assert.ok(!block.models.some((entry) => entry.id === 'account:zai-start-plan#GLM-5.2'))

  const both = selectPlanModels(
    models,
    ['account:zai-start-plan#GLM-5.3-Flash', 'account:zai-start-plan#GLM-5.2'],
    ['account:zai-start-plan#GLM-5.2'],
    'explicit',
  )
  assert.deepEqual(both.models.map((entry) => entry.id), ['account:zai-start-plan#GLM-5.3-Flash'])

  const typos = selectPlanModels(models, ['nope'], ['also-nope'], 'explicit')
  assert.deepEqual(typos.models, [])
  assert.deepEqual(typos.unknownEnabledIds, ['nope'])
  assert.deepEqual(typos.unknownDisabledIds, ['also-nope'])
})

test('selectPlanModels (merged) accepts every id spelling without losing the model', () => {
  const models = buildPlanModels(PROVIDERS)
  // A bare model id is the native merged spelling.
  const bare = selectPlanModels(models, ['GLM-5.3-Flash'])
  assert.deepEqual(bare.models.map((entry) => entry.id), ['GLM-5.3-Flash'])
  assert.deepEqual(bare.unknownEnabledIds, [])

  // An explicit-style id still resolves to the same single merged entry — configs written for
  // 0.7.0 must not silently vanish when the mode changes.
  const explicitId = selectPlanModels(models, ['account:zai-individual-coding-plan#GLM-5.3-Flash'])
  assert.deepEqual(explicitId.models.map((entry) => entry.id), ['GLM-5.3-Flash'])
  assert.deepEqual(explicitId.unknownEnabledIds, [])

  const slash = selectPlanModels(models, ['account:zai-individual-coding-plan/GLM-5.3'])
  assert.deepEqual(slash.models.map((entry) => entry.id), ['GLM-5.3'])
  assert.deepEqual(slash.unknownEnabledIds, [])

  // The block list accepts the same spellings.
  const blocked = selectPlanModels(models, [], ['GLM-5.3-Flash'])
  assert.ok(!blocked.models.some((entry) => entry.modelId === 'GLM-5.3-Flash'))

  const typos = selectPlanModels(models, ['nope'], ['also-nope'])
  assert.deepEqual(typos.unknownEnabledIds, ['nope'])
  assert.deepEqual(typos.unknownDisabledIds, ['also-nope'])
})

test('applyRoutePins moves an explicitly pinned route to the head of the chain but keeps the fallbacks', () => {
  const models = buildPlanModels(PROVIDERS)
  const flash = /** @type {any} */ (models.find((entry) => entry.modelId === 'GLM-5.3-Flash'))
  // Pinning the coding-plan route must reorder, not truncate: auto-failover stays available.
  const pinned = applyRoutePins(flash, ['account:zai-individual-coding-plan#GLM-5.3-Flash'])
  assert.deepEqual(pinned.routes.map((route) => route.providerId), [
    'account:zai-individual-coding-plan',
    'account:zai-start-plan',
  ])
  assert.equal(pinned.providerId, 'account:zai-individual-coding-plan')
  // A bare model id expresses no route preference and must leave the order alone.
  assert.deepEqual(applyRoutePins(flash, ['GLM-5.3-Flash']).routes.map((route) => route.providerId), [
    'account:zai-start-plan',
    'account:zai-individual-coding-plan',
  ])
})

test('describeRouteChain collapses routes into plan kinds, so the picker text stays readable', () => {
  const models = buildPlanModels(PROVIDERS)
  const flash = /** @type {any} */ (models.find((entry) => entry.modelId === 'GLM-5.3-Flash'))
  // individual + team coding plans are the same user-facing concept: one label.
  assert.equal(describeRouteChain(flash.routes), 'start → coding (2 routes)')
  // A single route needs no arrow and no count.
  const turbo = /** @type {any} */ (models.find((entry) => entry.modelId === 'GLM-5-Turbo'))
  assert.equal(describeRouteChain(turbo.routes), 'start')
  // The real 10-route chain must stay short: kinds only, never 10 provider ids.
  const wide = [
    { providerId: 'a', planKind: 'start-plan' },
    { providerId: 'b', planKind: 'start-plan' },
    { providerId: 'c', planKind: 'individual-coding-plan' },
    { providerId: 'd', planKind: 'team-coding-plan' },
    { providerId: 'e', planKind: 'offpeak-idle-plan' },
    { providerId: 'f', planKind: 'highspeed-card' },
  ]
  const described = describeRouteChain(/** @type {any} */ (wide))
  assert.equal(described, 'start → coding → idle → fast (6 routes)')
  assert.ok(described.length < 40, `the description must fit in a model picker, got ${described.length} chars`)
  assert.equal(describeRouteChain([]), '')
})

test('applyRouteExclusions removes one route from the chain but keeps the model', () => {
  const models = buildPlanModels(PROVIDERS)
  const flash = /** @type {any} */ (models.find((entry) => entry.modelId === 'GLM-5.3-Flash'))
  // Denying one specific route must NOT hide the model: the user said "don't burn this plan",
  // not "I don't want this model".
  const one = applyRouteExclusions(flash, ['account:zai-start-plan#GLM-5.3-Flash'])
  assert.deepEqual(one?.routes.map((route) => route.providerId), ['account:zai-individual-coding-plan'])
  assert.equal(one?.providerId, 'account:zai-individual-coding-plan', 'the head moves to the surviving route')
  // Denying nothing leaves the entry untouched (same object, no needless copy).
  assert.equal(applyRouteExclusions(flash, []), flash)
  assert.equal(applyRouteExclusions(flash, ['GLM-5.3-Flash']), flash, 'a bare model id is not a route exclusion')
  // Denying every route means the model has nowhere to go: undefined, so the caller drops it.
  const both = applyRouteExclusions(flash, [
    'account:zai-start-plan#GLM-5.3-Flash',
    'account:zai-individual-coding-plan#GLM-5.3-Flash',
  ])
  assert.equal(both, undefined)
})

test('adapter hides the whole model only when the deny list names the model itself', async () => {
  // A bare id hides the model; a per-route `#` id only drops that route.
  const bare = await makeAdapter({ config: { planDisabledModelIds: ['GLM-5.3-Flash'] } }).listModels(PLAN_PROVIDER_ID)
  assert.ok(!bare.some((entry) => entry.id === 'GLM-5.3-Flash'))

  const oneRoute = await makeAdapter({
    config: { planDisabledModelIds: ['account:zai-start-plan#GLM-5.3-Flash'] },
  }).listModels(PLAN_PROVIDER_ID)
  const flash = oneRoute.find((entry) => entry.id === 'GLM-5.3-Flash')
  assert.ok(flash !== undefined, 'the model must survive a single-route denial')
  assert.equal(flash?.description, 'coding')
})

// ---------------------------------------------------------------------------
// 严格钉死：某个模型只烧特定套餐（planPinnedRoutes）
// ---------------------------------------------------------------------------

test('restrictRoutesToPins keeps only the pinned routes, in plan-priority order', () => {
  const flash = routesForModel(PROVIDERS, 'GLM-5.3-Flash')
  assert.deepEqual(
    restrictRoutesToPins(flash, 'GLM-5.3-Flash', ['account:zai-individual-coding-plan#GLM-5.3-Flash'])
      ?.map((route) => route.providerId),
    ['account:zai-individual-coding-plan'],
  )
  // Several pins keep several routes, still ordered by plan priority rather than config order.
  assert.deepEqual(
    restrictRoutesToPins(flash, 'GLM-5.3-Flash', [
      'account:zai-individual-coding-plan#GLM-5.3-Flash',
      'account:zai-start-plan#GLM-5.3-Flash',
    ])?.map((route) => route.providerId),
    ['account:zai-start-plan', 'account:zai-individual-coding-plan'],
  )
  // Nothing to restrict: undefined, so callers can tell "no pin" from "pinned to everything".
  assert.equal(restrictRoutesToPins(flash, 'GLM-5.3-Flash', []), undefined)
  assert.equal(restrictRoutesToPins(flash, 'GLM-5.3-Flash', ['GLM-5.3-Flash']), undefined, 'a bare id names no route')
  assert.equal(restrictRoutesToPins(flash, 'GLM-5.3-Flash', ['account:zai-start-plan#GLM-5.2']), undefined, 'pins are per-model')
  // A pin on a route that does not serve this model must not empty the chain.
  assert.equal(restrictRoutesToPins(flash, 'GLM-5.3-Flash', ['account:zai-start-plan#GLM-5.3']), undefined)
})

test('applyStrictPins truncates the chain and marks the entry as pinned', () => {
  const models = buildPlanModels(PROVIDERS)
  const flash = /** @type {any} */ (models.find((entry) => entry.modelId === 'GLM-5.3-Flash'))
  const pinned = applyStrictPins(flash, ['account:zai-individual-coding-plan#GLM-5.3-Flash'])
  assert.deepEqual(pinned.routes.map((route) => route.providerId), ['account:zai-individual-coding-plan'])
  assert.equal(pinned.pinned, true)
  assert.equal(pinned.providerId, 'account:zai-individual-coding-plan')
  // Unpinned models are untouched and carry no marker.
  assert.equal(applyStrictPins(flash, []), flash)
  assert.equal(applyStrictPins(flash, ['account:zai-start-plan#GLM-5.2']), flash)
  // Pinning to a route the model already has alone still marks it: the semantics differ
  // (no failover) even when the chain length happens to be unchanged.
  const turbo = /** @type {any} */ (models.find((entry) => entry.modelId === 'GLM-5-Turbo'))
  assert.equal(applyStrictPins(turbo, ['account:zai-start-plan#GLM-5-Turbo']).pinned, true)
})

test('validateRoutePins separates bare ids, unknown models and wrong routes', () => {
  const models = buildPlanModels(PROVIDERS)
  assert.deepEqual(validateRoutePins(models, []), { bare: [], unknownModel: [], unknownRoute: [] })
  const result = validateRoutePins(models, [
    'GLM-5.3-Flash',
    'account:zai-start-plan#NOPE',
    'account:zai-start-plan#GLM-5.3',
    'account:zai-start-plan#GLM-5.3-Flash',
  ])
  assert.deepEqual(result.bare, ['GLM-5.3-Flash'])
  assert.deepEqual(result.unknownModel, ['account:zai-start-plan#NOPE'])
  assert.deepEqual(result.unknownRoute, ['account:zai-start-plan#GLM-5.3'], 'GLM-5.3 is not on start-plan')
})

test('describeModelDescription spells out that a pinned model will not fail over', () => {
  const models = buildPlanModels(PROVIDERS)
  const flash = /** @type {any} */ (models.find((entry) => entry.modelId === 'GLM-5.3-Flash'))
  assert.equal(describeModelDescription(flash), 'start → coding (2 routes)')
  assert.equal(
    describeModelDescription(applyStrictPins(flash, ['account:zai-start-plan#GLM-5.3-Flash'])),
    'start · pinned, no failover',
  )
})

test('listModels advertises a pinned model with a single-route chain', async () => {
  // GLM-5.3-Flash is served by both fixture routes; pinning it to the second one must leave a
  // one-route chain and say so.
  const models = await makeAdapter({
    config: { planPinnedRoutes: ['account:zai-individual-coding-plan#GLM-5.3-Flash'] },
  }).listModels(PLAN_PROVIDER_ID)
  const flash = models.find((entry) => entry.id === 'GLM-5.3-Flash')
  assert.equal(flash?.description, 'coding · pinned, no failover')
  // Only that one model is pinned; the other keeps its chain untouched.
  const unpinned = models.find((entry) => entry.id === 'GLM-5.3')
  assert.equal(unpinned?.description, 'coding')
})

test('stream() makes exactly one attempt for a pinned model and never fails over', async () => {
  let calls = 0
  const adapter = makeAdapter({
    config: { planPinnedRoutes: ['account:zai-start-plan#GLM-5.3-Flash'] },
    fetchImpl: /** @type {typeof fetch} */ (async () => {
      calls += 1
      return new Response('{"code":1005,"msg":"exceed quota limit"}', { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  })
  await assert.rejects(collect(adapter.stream({ ...baseRequest, model: 'GLM-5.3-Flash' })), (error) => {
    assert.equal(error.code, 'RATE_LIMIT')
    return true
  })
  // Unpinned this model has a two-route chain, so a second call would have happened.
  assert.equal(calls, 1, 'a pinned model must not switch to another plan route')
})

test('a bad pin is ignored rather than silently changing the model list', async () => {
  /** @type {string[]} */
  const warnings = []
  const adapter = makeAdapter({
    logger: { warn: (message) => warnings.push(message) },
    config: { planPinnedRoutes: ['GLM-5.3-Flash', 'account:zai-start-plan#NOPE', 'account:zai-start-plan#GLM-5.3'] },
  })
  const models = await adapter.listModels(PLAN_PROVIDER_ID)
  // Nothing was pinned, so the chains are intact.
  assert.equal(models.find((entry) => entry.id === 'GLM-5.3-Flash')?.description, 'start → coding (2 routes)')
  assert.ok(warnings.some((line) => /needs "<providerId>#<modelId>"/u.test(line)), 'a bare id must be reported')
  assert.ok(warnings.some((line) => /models not in the plan catalogue/u.test(line)), 'an unknown model must be reported')
  assert.ok(warnings.some((line) => /do not serve those models/u.test(line)), 'a wrong route must be reported')
})

test('pinning a route that the deny list also removes hides the model instead of falling back', async () => {
  // Contradictory config. Honouring the pin would mean burning a plan the user also said not
  // to use; silently falling back would violate "only this plan". Hiding is the honest answer.
  const models = await makeAdapter({
    config: {
      planPinnedRoutes: ['account:zai-start-plan#GLM-5.3-Flash'],
      planDisabledModelIds: ['account:zai-start-plan#GLM-5.3-Flash'],
    },
  }).listModels(PLAN_PROVIDER_ID)
  assert.ok(!models.some((entry) => entry.id === 'GLM-5.3-Flash'))
})

test('adapter parses the three model-id spellings to the same route', () => {
  const adapter = makeAdapter()
  assert.deepEqual(adapter.parseModel('account:zai-start-plan#GLM-5.3-Flash'), {
    providerId: 'account:zai-start-plan',
    modelId: 'GLM-5.3-Flash',
  })
  assert.deepEqual(adapter.parseModel('account:zai-start-plan/GLM-5.3-Flash'), {
    providerId: 'account:zai-start-plan',
    modelId: 'GLM-5.3-Flash',
  })
  // A bare id resolves to the first route that declares it — the route table is priority-sorted,
  // so this is the Start Plan route, matching the old channel's "prefer account: / Start Plan".
  assert.deepEqual(adapter.parseModel('GLM-5.3-Flash'), {
    providerId: 'account:zai-start-plan',
    modelId: 'GLM-5.3-Flash',
  })
  // In merged mode an explicit id for the OTHER route still reports that route (it is a pin).
  assert.deepEqual(adapter.parseModel('account:zai-individual-coding-plan#GLM-5.3-Flash'), {
    providerId: 'account:zai-individual-coding-plan',
    modelId: 'GLM-5.3-Flash',
  })
  assert.equal(adapter.parseModel(''), undefined)
  assert.equal(adapter.parseModel('nope-nope'), undefined)
})

test('listModels (default merged) advertises one entry per model with the fallback chain', async () => {
  const adapter = makeAdapter()
  const models = await adapter.listModels(PLAN_PROVIDER_ID)
  assert.deepEqual(models.map((entry) => entry.id), ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo', 'GLM-5.3'])
  const flash = models.find((entry) => entry.id === 'GLM-5.3-Flash')
  assert.deepEqual(flash?.inputModalities, ['text', 'image'])
  assert.equal(flash?.description, 'start → coding (2 routes)')
  const turbo = models.find((entry) => entry.id === 'GLM-5-Turbo')
  assert.deepEqual(turbo?.inputModalities, ['text'])
  for (const entry of models) {
    assert.equal(entry.provider, PLAN_PROVIDER_ID)
    assert.doesNotMatch(entry.id, /#/u, 'merged ids are bare model ids')
  }
})

test('listModels (explicit) advertises one entry per route-model pair', async () => {
  const adapter = makeAdapter({ config: { planRouteMode: 'explicit' } })
  const models = await adapter.listModels(PLAN_PROVIDER_ID)
  assert.equal(models.length, 5)
  const flash = models.find((entry) => entry.id === 'account:zai-start-plan#GLM-5.3-Flash')
  assert.deepEqual(flash?.inputModalities, ['text', 'image'])
  assert.equal(flash?.description, 'account:zai-start-plan')
  for (const entry of models) {
    assert.equal(entry.provider, PLAN_PROVIDER_ID)
    assert.match(entry.id, /^account:[^#]+#[^#]+$/u)
  }
})

test('listModels honours the plan channel own planEnabledModelIds / planDisabledModelIds', async () => {
  // The plan channel has its OWN switches: the same DSH model id means a different route here,
  // so sharing the legacy `enabledModelIds` would silently cross-filter the two channels.
  const enabled = await makeAdapter({ config: { planEnabledModelIds: ['GLM-5.3'] } }).listModels(PLAN_PROVIDER_ID)
  assert.deepEqual(enabled.map((entry) => entry.id), ['GLM-5.3'])

  const disabled = await makeAdapter({ config: { planDisabledModelIds: ['GLM-5.2'] } }).listModels(PLAN_PROVIDER_ID)
  assert.ok(!disabled.some((entry) => entry.id === 'GLM-5.2'))
  assert.equal(disabled.length, 3)

  // The legacy fields must NOT leak into the plan channel when the plan fields exist.
  const legacyIgnored = await makeAdapter({
    config: { enabledModelIds: ['GLM-5.3'], planEnabledModelIds: [] },
  }).listModels(PLAN_PROVIDER_ID)
  assert.equal(legacyIgnored.length, 4, 'an empty planEnabledModelIds means "everything", not "fall back to the legacy list"')
})

test('listModels falls back to the legacy enabledModelIds / disabledModelIds for a config without the plan fields', async () => {
  // A config object resolved by an older index.js has no plan* fields at all; that is the one
  // case where the legacy selection is the only signal available.
  const legacyConfig = {
    zcodeDataRoot: { dataBaseDir: 'D:/fake-zcode' },
    zcodeDataBaseDir: '',
    zcodeCliPath: '',
    enabledModelIds: ['GLM-5.3'],
    disabledModelIds: [],
    retryPolicy: { mode: 'normal', maxRetries: 5 },
  }
  const adapter = new ZcodePlanAdapter({
    options: () => legacyConfig,
    readCredentials: () => CREDENTIALS,
    providers: () => PROVIDERS,
  })
  adapter.traitSourceCache = { rules: MODEL_RULES, source: 'injected' }
  assert.deepEqual((await adapter.listModels(PLAN_PROVIDER_ID)).map((entry) => entry.id), ['GLM-5.3'])
})

test('resolveModel reports context, output cap, modalities and reasoning from the release rules', async () => {
  const adapter = makeAdapter()
  const flash = await adapter.resolveModel(PLAN_PROVIDER_ID, 'GLM-5.3-Flash')
  assert.equal(flash.provider, PLAN_PROVIDER_ID)
  assert.equal(flash.id, 'GLM-5.3-Flash')
  assert.equal(flash.name, 'GLM-5.3-Flash')
  assert.deepEqual(flash.context, { contextWindow: 1000000 })
  assert.equal(flash.defaultMaxTokens, 128000)
  assert.deepEqual(flash.inputModalities, ['text', 'image'])
  assert.deepEqual(flash.reasoning?.efforts.map((effort) => effort.id), ['low', 'high', 'max'])
  assert.equal(flash.reasoning?.defaultEffort, 'max')
  // The description shows the whole chain, so the picker explains what will be tried.
  assert.equal(flash.description, 'start → coding (2 routes)')

  const turbo = await adapter.resolveModel(PLAN_PROVIDER_ID, 'GLM-5-Turbo')
  assert.deepEqual(turbo.context, { contextWindow: 200000 })
  assert.equal(turbo.defaultMaxTokens, 64000)
  assert.deepEqual(turbo.reasoning?.efforts.map((effort) => effort.id), ['disabled', 'enabled'])
  assert.equal(turbo.reasoning?.defaultEffort, 'enabled')
})

test('providerInfo and providerRetryPolicy answer the DSH contract', () => {
  const adapter = makeAdapter()
  assert.deepEqual(adapter.providerInfo('zcode-plan'), { id: 'zcode-plan', name: 'zcode' })
  assert.equal(adapter.providerRetryPolicy().maxRetries, 5)
})

// ---------------------------------------------------------------------------
// DSH 请求 → Anthropic Messages 请求
// ---------------------------------------------------------------------------

/** 一个最小的 GenerateOptions。 */
const baseRequest = {
  provider: 'zcode-plan',
  model: 'account:zai-start-plan#GLM-5.3-Flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

test('toAnthropicRequest maps a plain user turn to the Anthropic envelope', async () => {
  const request = await toAnthropicRequest(baseRequest, {
    modelId: 'GLM-5.3-Flash',
    traits: FALLBACK_MODEL_TRAITS.get('GLM-5.3-Flash'),
    defaultMaxTokens: 128000,
  })
  assert.equal(request.model, 'GLM-5.3-Flash')
  assert.equal(request.max_tokens, 128000)
  assert.deepEqual(request.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  assert.equal(request.system, undefined)
  assert.equal(request.stream, undefined, 'plan-client forces stream:true, the request body must not')
})

test('toAnthropicRequest merges request-level system and every system/developer message into the top-level system slot', async () => {
  const request = await toAnthropicRequest({
    ...baseRequest,
    system: 'you are helpful',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'system prompt from history' }] },
      { role: 'developer', content: [{ type: 'text', text: 'tool update note' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
  }, { modelId: 'GLM-5.3', traits: DEFAULT_MODEL_TRAITS, defaultMaxTokens: 1000 })
  assert.equal(request.system, 'you are helpful\n\nsystem prompt from history\n\ntool update note')
  assert.deepEqual(request.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'system/developer messages never become turns')
})

test('toAnthropicRequest keeps tool calls and tool results in Anthropic shape', async () => {
  const request = await toAnthropicRequest({
    ...baseRequest,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I should read the file' },
          { type: 'text', text: 'reading' },
          { type: 'tool-call', id: 'toolu_1', name: 'Read', arguments: '{"path":"a.txt"}' },
        ],
      },
      { role: 'tool', toolCallId: 'toolu_1', content: [{ type: 'text', text: 'file body' }] },
    ],
  }, { modelId: 'GLM-5.3', traits: DEFAULT_MODEL_TRAITS, defaultMaxTokens: 1000 })

  assert.deepEqual(request.messages[1], {
    role: 'assistant',
    content: [
      { type: 'text', text: 'reading' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } },
    ],
  }, 'reasoning blocks are dropped (no signature to replay) and arguments are parsed back into input')
  assert.deepEqual(request.messages[2], {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'file body' }] }],
  })
})

test('toAnthropicRequest marks failed tool results and never sends an empty tool_result content', async () => {
  const request = await toAnthropicRequest({
    ...baseRequest,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', isError: true, content: [] },
    ],
  }, { modelId: 'GLM-5.3', traits: DEFAULT_MODEL_TRAITS, defaultMaxTokens: 1000 })
  assert.deepEqual(request.messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'c1',
    content: [{ type: 'text', text: '(no output)' }],
    is_error: true,
  })
})

test('toAnthropicRequest tolerates invalid historical tool-call arguments by sending {}', async () => {
  const request = await toAnthropicRequest({
    ...baseRequest,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{not json' }] },
    ],
  }, { modelId: 'GLM-5.3', traits: DEFAULT_MODEL_TRAITS, defaultMaxTokens: 1000 })
  assert.deepEqual(request.messages[1].content[0], { type: 'tool_use', id: 'c1', name: 'Bash', input: {} })
})

test('toAnthropicRequest merges adjacent same-role turns and prepends a user turn when history starts with assistant', async () => {
  const merged = await toAnthropicRequest({
    ...baseRequest,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'user', content: [{ type: 'text', text: 'two' }] },
    ],
  }, { modelId: 'GLM-5.3', traits: DEFAULT_MODEL_TRAITS, defaultMaxTokens: 1000 })
  assert.equal(merged.messages.length, 1)
  assert.deepEqual(merged.messages[0].content, [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }])

  const trimmed = await toAnthropicRequest({
    ...baseRequest,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'orphan' }] }],
  }, { modelId: 'GLM-5.3', traits: DEFAULT_MODEL_TRAITS, defaultMaxTokens: 1000 })
  assert.equal(trimmed.messages[0].role, 'user', 'Anthropic requires the first message to be a user turn')
})

test('toAnthropicRequest forwards tools with their JSON schema', async () => {
  const request = await toAnthropicRequest({
    ...baseRequest,
    tools: [
      { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: '', description: 'dropped: nameless', parameters: {} },
    ],
  }, { modelId: 'GLM-5.3', traits: DEFAULT_MODEL_TRAITS, defaultMaxTokens: 1000 })
  assert.equal(request.tools?.length, 1)
  assert.deepEqual(request.tools?.[0], {
    name: 'Read',
    description: 'read a file',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  })
})

test('toAnthropicRequest forwards temperature and stop sequences, and maxTokens wins over the model default', async () => {
  const request = await toAnthropicRequest({
    ...baseRequest,
    maxTokens: 42,
    temperature: 0.3,
    stop: ['STOP', ''],
  }, { modelId: 'GLM-5.3', traits: DEFAULT_MODEL_TRAITS, defaultMaxTokens: 128000 })
  assert.equal(request.max_tokens, 42)
  assert.equal(request.temperature, 0.3)
  assert.deepEqual(request.stop_sequences, ['STOP'])
})

test('thinkingFieldsFor follows the client release modelApiRules per model family', () => {
  // glm-5.3: always enabled + effort
  assert.deepEqual(thinkingFieldsFor('high', ['low', 'high', 'max']), {
    thinking: { type: 'enabled' },
    output_config: { effort: 'high' },
  })
  // GLM-5.2 / GLM-5-Turbo: disabled turns it off entirely
  assert.deepEqual(thinkingFieldsFor('disabled', ['disabled', 'high', 'max']), { thinking: { type: 'disabled' } })
  // GLM-5-Turbo: enabled is the only "on" value
  assert.deepEqual(thinkingFieldsFor('enabled', ['disabled', 'enabled']), { thinking: { type: 'enabled' } })
  // An effort the model does not declare is not guessed at.
  assert.deepEqual(thinkingFieldsFor('xhigh', ['low', 'high', 'max']), {})
  assert.deepEqual(thinkingFieldsFor('', ['low', 'high', 'max']), {})
})

test('toAnthropicRequest drops temperature while thinking is enabled (Anthropic rejects the combination)', async () => {
  const request = await toAnthropicRequest({
    ...baseRequest,
    temperature: 0.9,
    reasoningEffort: 'high',
  }, {
    modelId: 'GLM-5.3',
    traits: { contextWindow: 1000000, maxOutputTokens: 128000, supportsImage: false, reasoningLevels: ['low', 'high', 'max'] },
    defaultMaxTokens: 1000,
  })
  assert.deepEqual(request.thinking, { type: 'enabled' })
  assert.deepEqual(request.output_config, { effort: 'high' })
  assert.equal(request.temperature, undefined, 'thinking + temperature is a 400 upstream')
})

test('toAnthropicRequest keeps temperature when thinking is explicitly disabled', async () => {
  const request = await toAnthropicRequest({
    ...baseRequest,
    temperature: 0.9,
    reasoningEffort: 'disabled',
  }, {
    modelId: 'GLM-5-Turbo',
    traits: FALLBACK_MODEL_TRAITS.get('GLM-5-Turbo'),
    defaultMaxTokens: 1000,
  })
  assert.deepEqual(request.thinking, { type: 'disabled' })
  assert.equal(request.temperature, 0.9)
})

test('toAnthropicRequest turns images into text placeholders for a text-only model', async () => {
  const ref = { attachmentId: 'sha256:abcdef0123456789', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }
  let imageLoaderCalls = 0
  const request = await toAnthropicRequest({
    ...baseRequest,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', attachment: ref },
      ],
    }],
  }, {
    modelId: 'GLM-5.3',
    traits: FALLBACK_MODEL_TRAITS.get('GLM-5.3'),
    defaultMaxTokens: 1000,
    imageLoader: async () => {
      imageLoaderCalls += 1
      return { mediaType: 'image/png', dataBase64: 'AAAA' }
    },
  })
  assert.equal(imageLoaderCalls, 0, 'a text-only route must not even read the image bytes')
  const blocks = request.messages[0].content
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1].type, 'text')
  assert.match(blocks[1].text, /image omitted because this model accepts text only/u)
})

test('toAnthropicRequest sends base64 image blocks to an image-capable model', async () => {
  const ref = { attachmentId: 'sha256:abcdef0123456789', mediaType: 'image/webp', bytes: 10, width: 1, height: 1 }
  const request = await toAnthropicRequest({
    ...baseRequest,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: ref }] }],
  }, {
    modelId: 'GLM-5.3-Flash',
    traits: FALLBACK_MODEL_TRAITS.get('GLM-5.3-Flash'),
    defaultMaxTokens: 1000,
    imageLoader: async () => ({ mediaType: 'image/webp', dataBase64: 'UklGRg==' }),
  })
  assert.deepEqual(request.messages[0].content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/webp', data: 'UklGRg==' },
  })
})

test('toAnthropicRequest never re-sends an offloaded image, and degrades a failed read to a placeholder', async () => {
  const ref = { attachmentId: 'sha256:abcdef0123456789', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }
  const offloaded = await toAnthropicRequest({
    ...baseRequest,
    messages: [{ role: 'user', content: [{ type: 'image', attachment: ref, offloaded: true }] }],
  }, {
    modelId: 'GLM-5.3-Flash',
    traits: FALLBACK_MODEL_TRAITS.get('GLM-5.3-Flash'),
    defaultMaxTokens: 1000,
    imageLoader: async () => ({ mediaType: 'image/png', dataBase64: 'AAAA' }),
  })
  assert.match(offloaded.messages[0].content[0].text, /image omitted to fit request image limits/u)

  const failed = await toAnthropicRequest({
    ...baseRequest,
    messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }] }],
  }, {
    modelId: 'GLM-5.3-Flash',
    traits: FALLBACK_MODEL_TRAITS.get('GLM-5.3-Flash'),
    defaultMaxTokens: 1000,
    imageLoader: async () => undefined,
  })
  assert.match(failed.messages[0].content[0].text, /image omitted because this model accepts text only/u)
})

// ---------------------------------------------------------------------------
// plan-client 事件 → StreamChunk
// ---------------------------------------------------------------------------

test('PlanStreamMapper synthesises block-start/text-delta/block-end around text deltas', () => {
  const mapper = new PlanStreamMapper()
  assert.deepEqual(mapper.push({ type: 'text', delta: 'he' }), [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'he' },
  ])
  assert.deepEqual(mapper.push({ type: 'text', delta: 'llo' }), [
    { type: 'text-delta', index: 0, text: 'llo' },
  ])
  assert.deepEqual(mapper.push({ type: 'done', stopReason: 'end_turn' }), [
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('PlanStreamMapper closes the text block when the stream switches to reasoning and back', () => {
  const mapper = new PlanStreamMapper()
  const first = mapper.push({ type: 'reasoning', delta: 'thinking' })
  assert.deepEqual(first, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
  ])
  const second = mapper.push({ type: 'text', delta: 'answer' })
  assert.deepEqual(second, [
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'answer' },
  ])
  const done = mapper.push({ type: 'done', stopReason: 'end_turn' })
  assert.deepEqual(done, [
    { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('PlanStreamMapper accumulates tool-call JSON deltas and closes with the assembled raw arguments string', () => {
  const mapper = new PlanStreamMapper()
  assert.deepEqual(mapper.push({ type: 'tool_use_start', id: 'toolu_1', name: 'Read' }), [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
  ])
  assert.deepEqual(mapper.push({ type: 'tool_use_delta', id: 'toolu_1', partialJson: '{"path":' }), [
    { type: 'tool-call-delta', index: 0, id: 'toolu_1', name: 'Read', argumentsDelta: '{"path":' },
  ])
  assert.deepEqual(mapper.push({ type: 'tool_use_delta', id: 'toolu_1', partialJson: '"a.txt"}' }), [
    { type: 'tool-call-delta', index: 0, id: 'toolu_1', name: 'Read', argumentsDelta: '"a.txt"}' },
  ])
  assert.deepEqual(mapper.push({ type: 'done', stopReason: 'tool_use' }), [
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'toolu_1', name: 'Read', arguments: '{"path":"a.txt"}' },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
})

test('PlanStreamMapper closes text before a tool call and interleaves multiple tool blocks by id', () => {
  const mapper = new PlanStreamMapper()
  const chunks = [
    ...mapper.push({ type: 'text', delta: 'let me look' }),
    ...mapper.push({ type: 'tool_use_start', id: 'a', name: 'Read' }),
    ...mapper.push({ type: 'tool_use_start', id: 'b', name: 'Grep' }),
    ...mapper.push({ type: 'tool_use_delta', id: 'a', partialJson: '{"p":1}' }),
    ...mapper.push({ type: 'tool_use_delta', id: 'b', partialJson: '{"q":2}' }),
    ...mapper.push({ type: 'done', stopReason: 'tool_use' }),
  ]
  assert.deepEqual(chunks.map((chunk) => chunk.type), [
    'block-start', 'text-delta', // text opens
    'block-end', 'block-start', // text closes, tool a opens
    'block-start', // tool b opens
    'tool-call-delta', 'tool-call-delta', // one delta each, routed by id
    'block-end', 'block-end', 'finish', // both tools close, finish
  ])
  const closed = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
  assert.deepEqual(closed, [
    { type: 'text', text: 'let me look' },
    { type: 'tool-call', id: 'a', name: 'Read', arguments: '{"p":1}' },
    { type: 'tool-call', id: 'b', name: 'Grep', arguments: '{"q":2}' },
  ])
})

test('PlanStreamMapper tolerates a tool delta with no id, an unknown id, and an empty partial JSON', () => {
  const mapper = new PlanStreamMapper()
  mapper.push({ type: 'tool_use_start', id: '', name: 'Bash' })
  const delta = mapper.push({ type: 'tool_use_delta', id: '', partialJson: '{}' })
  assert.equal(delta.length, 1)
  assert.equal(delta[0].type, 'tool-call-delta')
  // An id that matches nothing falls back to the last open tool block rather than dropping the data.
  const unknown = mapper.push({ type: 'tool_use_delta', id: 'never-seen', partialJson: ' ' })
  assert.equal(unknown.length, 1)
  assert.equal(mapper.push({ type: 'tool_use_delta', id: '', partialJson: '' }).length, 0, 'empty deltas are not forwarded')
})

test('PlanStreamMapper emits usage and ignores everything after finish', () => {
  const mapper = new PlanStreamMapper()
  mapper.push({ type: 'text', delta: 'x' })
  assert.deepEqual(mapper.push({ type: 'usage', inputTokens: 11, outputTokens: 3 }), [
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 3 } },
  ])
  const finished = mapper.push({ type: 'done', stopReason: 'end_turn' })
  assert.equal(finished[finished.length - 1].type, 'finish')
  assert.deepEqual(mapper.push({ type: 'text', delta: 'late' }), [], 'a terminal finish is final')
})

test('finishReasonFor maps upstream stop reasons to the DSH finish vocabulary', () => {
  assert.deepEqual(finishReasonFor('end_turn', false), { kind: 'stop' })
  assert.deepEqual(finishReasonFor('stop_sequence', false), { kind: 'stop' })
  assert.deepEqual(finishReasonFor(null, false), { kind: 'stop' })
  assert.deepEqual(finishReasonFor('tool_use', false), { kind: 'tool-calls' })
  assert.deepEqual(finishReasonFor('max_tokens', true), { kind: 'max-tokens' }, 'truncation wins over tool calls')
  assert.deepEqual(finishReasonFor('end_turn', true), { kind: 'tool-calls' }, 'a turn that produced calls must report tool-calls')
})

// ---------------------------------------------------------------------------
// 错误映射
// ---------------------------------------------------------------------------

test('toLlmError maps every plan-client code and keeps the upstream code/message/logid', () => {
  const quota = toLlmError(new PlanClientError(
    '计划额度不足（quota 1005）：exceed quota limit',
    'QUOTA',
    { kind: 'quota', code: 1005, message: 'exceed quota limit', retryable: false, status: 200, logid: 'log-42', body: '{}' },
  ))
  assert.ok(quota instanceof LlmError)
  assert.equal(quota.code, PLAN_ERROR_CODE_MAP.QUOTA)
  assert.equal(quota.code, 'RATE_LIMIT')
  assert.match(quota.message, /套餐额度已用尽/u)
  assert.match(quota.message, /code=1005/u, 'the upstream business code must survive')
  assert.match(quota.message, /logid=log-42/u)
  assert.equal(quota.failure.status, 200)

  const expired = toLlmError(new PlanClientError(
    '计划额度不足（quota 1309）：您的GLM Coding Plan套餐已到期',
    'QUOTA',
    { kind: 'quota', code: '1309', message: '您的GLM Coding Plan套餐已到期', retryable: false, status: 429, requestId: 'req-7', body: '{}' },
  ))
  assert.match(expired.message, /code=1309/u, 'a string business code is preserved verbatim')
  assert.match(expired.message, /您的GLM Coding Plan套餐已到期/u)
  assert.match(expired.message, /request_id=req-7/u)
  assert.equal(expired.failure.requestId, 'req-7')

  const auth = toLlmError(new PlanClientError('auth', 'AUTH', { kind: 'auth', code: undefined, message: 'invalid token', retryable: false, status: 401, body: '' }))
  assert.equal(auth.code, 'AUTH')
  assert.equal(auth.failure.status, 401)

  const concurrency = toLlmError(new PlanClientError('busy', 'CONCURRENCY', { kind: 'concurrency', code: 3009, message: 'model concurrency limit exceeded', retryable: true, status: 429, body: '' }))
  assert.equal(concurrency.code, 'RATE_LIMIT')
  assert.equal(concurrency.failure.providerRetryAfterMs, 1000, 'a retryable upstream answer carries a backoff hint')

  assert.equal(toLlmError(new PlanClientError('param', 'PARAM')).code, 'INVALID_REQUEST')
  assert.equal(toLlmError(new PlanClientError('upstream', 'UPSTREAM')).code, 'UPSTREAM')
  assert.equal(toLlmError(new PlanClientError('net', 'TRANSPORT')).code, 'TRANSPORT')
  assert.equal(toLlmError(new PlanClientError('slow', 'TIMEOUT')).code, 'TIMEOUT')
  assert.equal(toLlmError(new PlanClientError('bye', 'ABORTED')).code, 'ABORTED')
  assert.equal(toLlmError(new PlanClientError('no jwt', 'TOKEN_MISSING')).code, 'AUTH')
  assert.equal(toLlmError(new PlanClientError('no key', 'API_KEY_MISSING')).code, 'AUTH')
  assert.equal(toLlmError(new PlanClientError('no card', 'CARD_ID_MISSING')).code, 'AUTH')
  assert.equal(toLlmError(new PlanClientError('bad route', 'UNKNOWN_PROVIDER')).code, 'PROVIDER')
  assert.equal(toLlmError(new PlanClientError('bad body', 'BAD_RESPONSE')).code, 'UPSTREAM')
})

test('toLlmError passes an LlmError through unchanged and wraps anything else as TRANSPORT', () => {
  const original = new LlmError('already mapped', 'AUTH')
  assert.equal(toLlmError(original), original)

  const wrapped = toLlmError(new TypeError('fetch failed'))
  assert.equal(wrapped.code, 'TRANSPORT')
  assert.match(wrapped.message, /fetch failed/u)
  assert.equal(wrapped.cause?.message, 'fetch failed')
})

test('every plan-client error code has a mapping (no code silently becomes UPSTREAM)', async () => {
  const { PLAN_ERROR_CODES } = await import('../lib/plan-client.js')
  for (const code of PLAN_ERROR_CODES) {
    assert.equal(typeof PLAN_ERROR_CODE_MAP[code], 'string', `missing mapping for ${code}`)
  }
})

// ---------------------------------------------------------------------------
// 会话标题（本地生成，不消耗额度）
// ---------------------------------------------------------------------------

test('localSessionTitle derives the title from the last user message without any network call', () => {
  const title = localSessionTitle({
    ...baseRequest,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
      { role: 'user', content: [{ type: 'text', text: '  多个   空格\n换行 的标题  ' }] },
    ],
  })
  assert.equal(title, '多个 空格 换行 的标题')

  assert.equal(localSessionTitle({ ...baseRequest, messages: [] }), SESSION_TITLE_FALLBACK)
})

test('stream(session-title) answers entirely locally: five chunks, zero fetch', async () => {
  let calls = 0
  const adapter = makeAdapter({
    fetchImpl: /** @type {typeof fetch} */ (async () => {
      calls += 1
      throw new Error('must not reach the network')
    }),
  })
  const chunks = await collect(adapter.stream({
    ...baseRequest,
    purpose: 'session-title',
    messages: [{ role: 'user', content: [{ type: 'text', text: '帮我重构这个模块' }] }],
  }))
  assert.equal(calls, 0)
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '帮我重构这个模块' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '帮我重构这个模块' } },
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

// ---------------------------------------------------------------------------
// 整条 stream 路径（注入假 fetch，零网络）
// ---------------------------------------------------------------------------

/** 一段完整的 Anthropic SSE：thinking → text → tool_use → usage → done。 */
const FULL_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":21,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me think"}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"reading it"}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_9","name":"Read","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9},"delta":{"stop_reason":"tool_use"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('')

test('stream() drives a full turn: reasoning, text, tool call, usage and finish', async () => {
  const adapter = makeAdapter({ fetchImpl: sseFetch(FULL_SSE) })
  const chunks = await collect(adapter.stream({
    ...baseRequest,
    tools: [{ name: 'Read', description: 'read', parameters: { type: 'object' } }],
    maxTokens: 256,
  }))

  assert.deepEqual(chunks.map((chunk) => chunk.type), [
    'usage', // message_start usage (input tokens known up front)
    'block-start', 'reasoning-delta', // thinking block opens and streams
    'block-end', 'block-start', 'text-delta', // thinking closes, text opens
    'block-end', 'block-start', // text closes, tool block opens
    'tool-call-delta', 'tool-call-delta', // input_json_delta fragments
    'usage', // message_delta usage
    'block-end', // tool block closes with assembled arguments
    'finish',
  ])

  const blocks = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
  assert.deepEqual(blocks, [
    { type: 'reasoning', text: 'let me think' },
    { type: 'text', text: 'reading it' },
    { type: 'tool-call', id: 'toolu_9', name: 'Read', arguments: '{"path":"a.txt"}' },
  ])
  assert.deepEqual(chunks[chunks.length - 1], { type: 'finish', reason: { kind: 'tool-calls' } })
  // The final usage chunk carries the authoritative output count.
  const usages = chunks.filter((chunk) => chunk.type === 'usage')
  assert.deepEqual(usages[usages.length - 1].usage, { inputTokens: 21, outputTokens: 9 })
})

test('stream() sends the request to the right endpoint with the right auth header', async () => {
  /** @type {{ url?: string, headers?: any, body?: any }[]} */
  const seen = []
  const adapter = makeAdapter({
    fetchImpl: /** @type {typeof fetch} */ (async (url, init) => {
      seen.push({ url: String(url), headers: init?.headers, body: JSON.parse(String(init?.body)) })
      return new Response('{"type":"error","error":{"type":"rate_limit_error","code":"1309","message":"expired"}}', {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    }),
  })
  await assert.rejects(
    collect(adapter.stream({ ...baseRequest, model: 'account:zai-individual-coding-plan#GLM-5.3' })),
    (error) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'RATE_LIMIT')
      assert.match(error.message, /code=1309/u)
      assert.match(error.message, /expired/u)
      return true
    },
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://api.z.ai/api/anthropic/v1/messages')
  assert.equal(seen[0].headers['x-api-key'], 'plan-key')
  assert.equal(seen[0].headers.authorization, undefined, 'the coding-plan route must not get the Bearer JWT')
  assert.equal(seen[0].body.model, 'GLM-5.3')
  assert.equal(seen[0].body.stream, true, 'plan-client forces streaming')
  assert.equal(seen[0].body.max_tokens, 128000, 'the model rule supplies the output cap')
})

test('stream() uses Bearer auth for a start-plan route and reports a quota answer as RATE_LIMIT with the upstream code', async () => {
  /** @type {any} */
  let headers
  const adapter = makeAdapter({
    // Explicit mode pins exactly one route, so this isolates the start-plan header shape from
    // the merged-mode failover chain (which would go on to try the coding-plan route).
    config: { planRouteMode: 'explicit' },
    fetchImpl: /** @type {typeof fetch} */ (async (_url, init) => {
      headers = init?.headers
      // zcode-plan answers HTTP 200 with a business error code — the 200-must-still-be-an-error path.
      return new Response('{"code":1005,"msg":"exceed quota limit","logid":"2026102708261034"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  })
  await assert.rejects(collect(adapter.stream(baseRequest)), (error) => {
    assert.equal(error.code, 'RATE_LIMIT')
    assert.match(error.message, /套餐额度已用尽/u)
    assert.match(error.message, /code=1005/u)
    assert.match(error.message, /logid=2026102708261034/u)
    return true
  })
  assert.equal(headers.authorization, 'Bearer jwt-token')
  assert.equal(headers['x-api-key'], undefined)
})

test('stream() surfaces a missing credential as AUTH before any request is sent', async () => {
  let calls = 0
  const adapter = makeAdapter({
    credentials: {},
    fetchImpl: /** @type {typeof fetch} */ (async () => {
      calls += 1
      return new Response('{}')
    }),
  })
  await assert.rejects(collect(adapter.stream(baseRequest)), (error) => {
    assert.equal(error.code, 'AUTH')
    assert.match(error.message, /zcodejwttoken/u)
    return true
  })
  assert.equal(calls, 0, 'a credential problem must not reach the network')
})

test('stream() rejects an unparseable model id with INVALID_REQUEST and a hint about the id format', async () => {
  const adapter = makeAdapter()
  await assert.rejects(collect(adapter.stream({ ...baseRequest, model: 'totally-unknown' })), (error) => {
    assert.equal(error.code, 'INVALID_REQUEST')
    assert.match(error.message, /GLM-5\.3-Flash/u)
    return true
  })
})

// ---------------------------------------------------------------------------
// 自动切换：merged 模式下按套餐优先级依次尝试
// ---------------------------------------------------------------------------

/** 一条正常产出文本的 SSE。 */
const OK_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3},"delta":{"stop_reason":"end_turn"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('')

/** 额度用尽的业务错误（zcode-plan 用 HTTP 200 携带它）。 */
const QUOTA_BODY = '{"code":1005,"msg":"exceed quota limit","logid":"2026102708261034"}'

test('stream() fails over to the next plan route when the first one is out of quota', async () => {
  /** @type {{ url: string, auth: string | undefined }[]} */
  const seen = []
  const adapter = makeAdapter({
    fetchImpl: /** @type {typeof fetch} */ (async (url, init) => {
      const auth = /** @type {any} */ (init?.headers)?.authorization
      seen.push({ url: String(url), auth })
      if (seen.length === 1) {
        // Start Plan is out of quota.
        return new Response(QUOTA_BODY, { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // The coding-plan route answers normally.
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(OK_SSE))
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }),
  })
  const chunks = await collect(adapter.stream({ ...baseRequest, model: 'GLM-5.3-Flash' }))
  // Two attempts: start-plan first (quota), then coding-plan (works).
  assert.equal(seen.length, 2)
  assert.equal(seen[0].url, 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages')
  assert.equal(seen[0].auth, 'Bearer jwt-token')
  assert.equal(seen[1].url, 'https://api.z.ai/api/anthropic/v1/messages')
  assert.equal(seen[1].auth, undefined, 'the coding-plan route uses x-api-key, not the Bearer JWT')
  // The turn completes normally on the second route.
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'pong'))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('stream() does NOT fail over on a request-shape error: PARAM would fail identically everywhere', async () => {
  let calls = 0
  const adapter = makeAdapter({
    fetchImpl: /** @type {typeof fetch} */ (async () => {
      calls += 1
      return new Response('{"code":3001,"msg":"parameter error"}', { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  })
  await assert.rejects(collect(adapter.stream({ ...baseRequest, model: 'GLM-5.3-Flash' })), (error) => {
    assert.equal(error.code, 'INVALID_REQUEST')
    assert.match(error.message, /3001/u)
    return true
  })
  assert.equal(calls, 1, 'a parameter error must not be retried on another route')
})

test('stream() reports the whole attempt chain when every plan route fails', async () => {
  const adapter = makeAdapter({
    fetchImpl: /** @type {typeof fetch} */ (async () => new Response(QUOTA_BODY, { status: 200, headers: { 'content-type': 'application/json' } })),
  })
  await assert.rejects(collect(adapter.stream({ ...baseRequest, model: 'GLM-5.3-Flash' })), (error) => {
    assert.equal(error.code, 'RATE_LIMIT')
    assert.match(error.message, /1005/u)
    return true
  })
})

test('stream() pins a single route in explicit mode (no failover, the 0.7.0 behaviour)', async () => {
  /** @type {string[]} */
  const urls = []
  const adapter = makeAdapter({
    config: { planRouteMode: 'explicit' },
    fetchImpl: /** @type {typeof fetch} */ (async (url) => {
      urls.push(String(url))
      return new Response(QUOTA_BODY, { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  })
  await assert.rejects(collect(adapter.stream({ ...baseRequest, model: 'account:zai-start-plan#GLM-5.3-Flash' })), (error) => {
    assert.equal(error.code, 'RATE_LIMIT')
    return true
  })
  assert.deepEqual(urls, ['https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages'], 'explicit mode must never touch another route')
})

test('stream() skips a route whose credential form is missing and uses the next one', async () => {
  /** @type {string[]} */
  const urls = []
  const adapter = makeAdapter({
    // No coding-plan API key: the individual-coding-plan route cannot be built at all, so the
    // chain must silently drop it and still serve GLM-5.3 (only that route declares it).
    credentials: { zcodejwttoken: 'jwt-token' },
    fetchImpl: /** @type {typeof fetch} */ (async (url) => {
      urls.push(String(url))
      return new Response(QUOTA_BODY, { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  })
  await assert.rejects(collect(adapter.stream({ ...baseRequest, model: 'GLM-5.3' })), (error) => {
    // The only route serving GLM-5.3 has no api-key, so this is an AUTH failure, not a silent no-op.
    assert.equal(error.code, 'AUTH')
    assert.match(error.message, /coding-plan API Key|api-key/u)
    return true
  })
  assert.deepEqual(urls, [], 'no request may be sent without a usable credential')
})

test('a route missing its credential is dropped from the chain without failing the turn', async () => {
  /** @type {string[]} */
  const urls = []
  const adapter = makeAdapter({
    // JWT present, no coding-plan key: GLM-5.3-Flash can still be served by start-plan.
    credentials: { zcodejwttoken: 'jwt-token' },
    fetchImpl: /** @type {typeof fetch} */ (async (url) => {
      urls.push(String(url))
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(OK_SSE))
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }),
  })
  const chunks = await collect(adapter.stream({ ...baseRequest, model: 'GLM-5.3-Flash' }))
  assert.deepEqual(urls, ['https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages'], 'only the buildable route is attempted')
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'pong'))
})

// ---------------------------------------------------------------------------
// 凭证合并：客户端共享凭证 + 插件自有凭证（login 写入）
// ---------------------------------------------------------------------------

test('credentials() lets the plugin credential store override the client credentials', () => {
  // The plugin's own `login` result is newer than whatever the desktop client left on disk.
  const adapter = makeAdapter({
    credentials: { zcodejwttoken: 'stale-client-token', 'account-provider:coding-plan:account:zai-individual-coding-plan:account:1:api-key': 'client-key' },
    planCredentials: { zcodejwttoken: 'fresh-login-token' },
  })
  const merged = adapter.credentials()
  assert.equal(merged.zcodejwttoken, 'fresh-login-token')
  assert.equal(merged['account-provider:coding-plan:account:zai-individual-coding-plan:account:1:api-key'], 'client-key', 'keys the plugin store lacks still come from the client')
})

test('credentials() ignores empty plugin values instead of blanking a good client credential', () => {
  const adapter = makeAdapter({
    credentials: { zcodejwttoken: 'client-token' },
    planCredentials: { zcodejwttoken: '   ' },
  })
  assert.equal(adapter.credentials().zcodejwttoken, 'client-token')
})

test('a corrupt plugin credential store degrades to the client credentials with a warning, not a failure', () => {
  /** @type {string[]} */
  const warnings = []
  const adapter = new ZcodePlanAdapter({
    options: makeOptions(),
    logger: { warn: (message) => warnings.push(message) },
    readCredentials: () => ({ zcodejwttoken: 'client-token' }),
    readPlanCredentials: () => {
      throw new Error('not valid JSON')
    },
    providers: () => PROVIDERS,
  })
  assert.equal(adapter.credentials().zcodejwttoken, 'client-token')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /plugin credential store/u)
})

test('the plugin credential store makes a token available even when the client credentials file is unusable', () => {
  // `readCredentials` throws (no client installed) but the plugin logged in on its own.
  // This is the deployment the direct channel exists for: a machine with no ZCode client at
  // all, where `login` wrote the token into the plugin's own store. The client read failing
  // must NOT be fatal — only "neither source has a token" is.
  const adapter = new ZcodePlanAdapter({
    options: makeOptions(),
    readCredentials: () => {
      throw new Error('ENOENT: no credentials.json')
    },
    readPlanCredentials: () => ({ zcodejwttoken: 'plugin-token' }),
    providers: () => PROVIDERS,
  })
  assert.equal(adapter.credentials().zcodejwttoken, 'plugin-token')
})

test('credentials() is empty (not throwing) when both sources are unusable', () => {
  // With no client and no plugin login there is nothing to serve. The adapter must not throw
  // here either: `resolvePlanRoute` is what reports TOKEN_MISSING, and it knows which family
  // the request needed. Throwing earlier would turn a clear "please log in" into a generic
  // AUTH failure.
  const adapter = new ZcodePlanAdapter({
    options: makeOptions(),
    readCredentials: () => {
      throw new Error('ENOENT: no credentials.json')
    },
    providers: () => PROVIDERS,
  })
  assert.deepEqual(adapter.credentials(), {})
})

test('stream() uses the plugin credential store token when it overrides the client one', async () => {
  /** @type {any} */
  let headers
  const adapter = makeAdapter({
    credentials: { zcodejwttoken: 'stale-client-token' },
    planCredentials: { zcodejwttoken: 'fresh-login-token' },
    fetchImpl: /** @type {typeof fetch} */ (async (_url, init) => {
      headers = init?.headers
      return new Response('{"code":1005,"msg":"exceed quota limit"}', { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  })
  await assert.rejects(collect(adapter.stream(baseRequest)), (error) => error.code === 'RATE_LIMIT')
  assert.equal(headers.authorization, 'Bearer fresh-login-token')
})

test('stream() raises EMPTY_RESPONSE when the upstream stream carried no content at all', async () => {
  const emptySse = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":0},"delta":{"stop_reason":"end_turn"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')
  const adapter = makeAdapter({ fetchImpl: sseFetch(emptySse) })
  await assert.rejects(collect(adapter.stream(baseRequest)), (error) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'EMPTY_RESPONSE')
    return true
  })
})

test('stream() honours caller cancellation through the request signal', async () => {
  const controller = new AbortController()
  controller.abort()
  const adapter = makeAdapter({
    fetchImpl: /** @type {typeof fetch} */ (async (_url, init) => {
      assert.equal(init?.signal?.aborted, true, 'the caller signal must be forwarded to fetch')
      throw new DOMException('aborted', 'AbortError')
    }),
  })
  await assert.rejects(collect(adapter.stream({ ...baseRequest, signal: controller.signal })), (error) => {
    assert.equal(error.code, 'ABORTED')
    return true
  })
})

test('an empty SSE body ends the turn with a stop finish rather than hanging', async () => {
  const adapter = makeAdapter({ fetchImpl: sseFetch('') })
  await assert.rejects(collect(adapter.stream(baseRequest)), (error) => {
    assert.equal(error.code, 'EMPTY_RESPONSE')
    return true
  })
})

// ---------------------------------------------------------------------------
// 缓存 / 生命周期
// ---------------------------------------------------------------------------

test('refreshCatalogue drops the route and trait caches so the next query re-reads the config', () => {
  const adapter = makeAdapter()
  const first = adapter.catalogue()
  assert.equal(adapter.catalogue(), first, 'the catalogue is cached')
  adapter.traitsFor('GLM-5.3')
  assert.equal(adapter.traitCache.size, 1)
  adapter.refreshCatalogue()
  assert.equal(adapter.catalogueCache, undefined)
  assert.equal(adapter.traitSourceCache, undefined)
  assert.equal(adapter.traitCache.size, 0)
  // The injected provider list still answers after a refresh (it is a live thunk).
  assert.equal(adapter.catalogue().providers.length, PROVIDERS.length)
})

test('dispose() clears every cache and leaves the adapter re-usable', () => {
  const adapter = makeAdapter()
  adapter.catalogue()
  adapter.traitsFor('GLM-5.3')
  adapter.dispose()
  assert.equal(adapter.catalogueCache, undefined)
  assert.equal(adapter.traitSourceCache, undefined)
  assert.equal(adapter.traitCache.size, 0)
  assert.equal(adapter.catalogue().providers.length, PROVIDERS.length)
})

test('a catalogue with no routes degrades to an empty model list instead of throwing', async () => {
  const adapter = makeAdapter({ providers: [] })
  assert.deepEqual(await adapter.listModels(PLAN_PROVIDER_ID), [])
  assert.deepEqual(adapter.catalogue().providers, [])
})
