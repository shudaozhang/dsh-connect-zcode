// 额度读取层（`lib/plan-quota.js`）。
//
// 这个模块的全部价值在四件事上：构造正确的 URL/头、把上游 JSON 归一成稳定结构、
// 把失败收敛成机读错误码、以及带 TTL 的缓存。四件事都是纯数据变换，所以下面的测试
// **一个真实网络请求都不发** —— 需要 HTTP 的地方一律注入假 `fetch`，需要时间的地方
// 一律注入假时钟。
//
// 唯一没法在这里覆盖的是「上游确实这么回」：本机账号无套餐，实测只能拿到
// `plans: []`（这是**正确结果**，不是失败）。真实响应样本抄自
// `zcode-direct/recon/creds-samples.json`，字段结构抄自 app.asar 逆向 + 真实非空样本，
// 那份证据记在 `docs/quota-api.md`。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_APP_VERSION,
  DEFAULT_BASE_ORIGIN,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_MS,
  KNOWN_METERS,
  KNOWN_PERIODS,
  KNOWN_UNIT_TYPES,
  QUOTA_ENDPOINTS,
  QUOTA_ERROR_CODES,
  QuotaCache,
  QuotaError,
  UNKNOWN_METER,
  buildQuotaHeaders,
  buildQuotaUrl,
  capabilityModelIds,
  defaultPlatformKey,
  fetchBillingBalance,
  fetchBillingCurrent,
  fetchBillingPreview,
  normalizeEntitlement,
  normalizePlan,
  normalizePlans,
  readDeviceMid,
  summarizeQuota,
} from '../lib/plan-quota.js'

// ---------------------------------------------------------------------------
// 假 HTTP / 假时钟
// ---------------------------------------------------------------------------

/**
 * 构造一个 JSON `Response`。
 *
 * @param {unknown} payload 会被 `JSON.stringify` 的响应体。
 * @param {number} [status] HTTP 状态。
 * @param {Record<string, string>} [headers] 响应头。
 * @returns {Response} 可直接交给被测函数的响应。
 */
function jsonResponse(payload, status = 200, headers = { 'content-type': 'application/json' }) {
  return new Response(JSON.stringify(payload), { status, headers })
}

/**
 * 构造一个记录调用参数的假 `fetch`。
 *
 * @param {(url: string, init: RequestInit) => Response | Promise<Response>} handler 响应工厂。
 * @returns {{ fetchImpl: typeof globalThis.fetch, calls: { url: string, init: RequestInit }[] }} 假 fetch 与调用记录。
 */
function recordingFetch(handler) {
  /** @type {{ url: string, init: RequestInit }[]} */
  const calls = []
  const fetchImpl = /** @type {typeof globalThis.fetch} */ (
    async (url, init) => {
      calls.push({ url: String(url), init: /** @type {RequestInit} */ (init ?? {}) })
      return handler(String(url), /** @type {RequestInit} */ (init ?? {}))
    }
  )
  return { fetchImpl, calls }
}

/** 本机真实凭证的形状（204 字符 JWT）。测试里用短字符串即可，长度不参与逻辑。 */
const JWT = 'jwt-token'

/** 上游真实成功样本（`billing/current`，本机无套餐）。 */
const EMPTY_CURRENT = {
  code: 0,
  msg: '',
  data: { server_time: 1793089474, plans: [] },
  logid: '202610270824349fc95a44a9c9eb3838dd',
}

/** 上游真实成功样本（`billing/preview`，本机无可领套餐）。 */
const EMPTY_PREVIEW = {
  code: 0,
  msg: '',
  data: { server_time: 1793089332, plans: [] },
  logid: '20261027082212b50c9711c35aa8d1f42f',
}

/**
 * 上游「有额度」时的完整样本（字段结构抄自 app.asar 逆向 + 真实非空日志样本）。
 * 注意：这不是本机实测响应（本机 `plans: []`），仅用于验证归一逻辑。
 */
const FULL_CURRENT = {
  code: 0,
  msg: '',
  data: {
    server_time: 1791943720,
    plans: [
      {
        user_plan_id: 'upl_2110191023253372928',
        plan_id: 'zcode-v3-start-plan-0817',
        name: 'ZCode Start Plan',
        description: '免费 GLM 旗舰模型体验',
        priority: 90,
        status: 'active',
        starts_at: 1791943720,
        ends_at: 1792339199,
        entitlements: [
          {
            entitlement_id: 'ent_2_0817_glm_5p3',
            show_name: 'GLM-5.3',
            meter: 'model_usage',
            unit_type: 'token',
            capabilities: ['model:glm-5.3'],
            grant_units: 3000000,
            period: 'daily',
            priority: 110,
            effective_at: 0,
          },
          {
            entitlement_id: 'ent_2_0817_glm_5p3f',
            show_name: 'GLM-5.3-Flash',
            capabilities: ['model:glm-5.3-flash'],
            grant_units: '5000000',
            period: 'daily',
          },
        ],
      },
    ],
  },
  logid: '20261019021219124a5a3ec432775a9b6c',
}

// ---------------------------------------------------------------------------
// 常量：对外契约的稳定部分
// ---------------------------------------------------------------------------

test('the module exposes the measured endpoint paths and defaults', () => {
  assert.equal(DEFAULT_BASE_ORIGIN, 'https://zcode.z.ai')
  assert.equal(DEFAULT_APP_VERSION, '3.16.3', '3.16.3 is the version the client sends; 3.4.0 is a stale constant')
  assert.equal(DEFAULT_TIMEOUT_MS, 15_000)
  assert.equal(DEFAULT_TTL_MS, 60_000)
  assert.deepEqual(QUOTA_ENDPOINTS, {
    current: '/api/v1/zcode-plan/billing/current',
    balance: '/api/v1/zcode-plan/billing/balance',
    preview: '/api/v1/zcode-plan/billing/preview',
  })
  assert.deepEqual([...KNOWN_METERS], ['model_usage'])
  assert.deepEqual([...KNOWN_UNIT_TYPES], ['token'])
  assert.deepEqual([...KNOWN_PERIODS], ['daily', 'one_time'])
  assert.equal(UNKNOWN_METER, 'unknown')
  assert.deepEqual([...QUOTA_ERROR_CODES], [
    'TOKEN_MISSING',
    'NETWORK',
    'TIMEOUT',
    'HTTP_STATUS',
    'INVALID_JSON',
    'API_CODE',
    'MISSING_DATA',
  ])
})

test('defaultPlatformKey keeps the arch suffix the client sends', () => {
  assert.equal(defaultPlatformKey('win32', 'x64'), 'win32-x64')
  assert.equal(defaultPlatformKey('darwin', 'arm64'), 'darwin-arm64')
  // 与真实运行环境一致，不硬编码成 win32。
  assert.equal(defaultPlatformKey(), `${process.platform}-${process.arch}`)
})

// ---------------------------------------------------------------------------
// buildQuotaUrl
// ---------------------------------------------------------------------------

test('buildQuotaUrl joins the origin, the endpoint and only the non-empty query values', () => {
  assert.equal(
    buildQuotaUrl(QUOTA_ENDPOINTS.current),
    'https://zcode.z.ai/api/v1/zcode-plan/billing/current',
  )
  assert.equal(
    buildQuotaUrl(QUOTA_ENDPOINTS.balance, { query: { app_version: '3.16.3', platform: 'win32-x64' } }),
    'https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.16.3&platform=win32-x64',
  )
  // 空串 / null / undefined 必须被丢弃，避免发出 `?plan_id=` 这种形态。
  assert.equal(
    buildQuotaUrl(QUOTA_ENDPOINTS.preview, { query: { app_version: '3.16.3', plan_id: '', extra: null, more: undefined } }),
    'https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version=3.16.3',
  )
  // 数字值会被字符串化。
  assert.equal(
    buildQuotaUrl(QUOTA_ENDPOINTS.current, { query: { seq: 7 } }),
    'https://zcode.z.ai/api/v1/zcode-plan/billing/current?seq=7',
  )
})

test('buildQuotaUrl trims trailing slashes from the origin and honours an override', () => {
  assert.equal(
    buildQuotaUrl(QUOTA_ENDPOINTS.current, { baseOrigin: 'https://example.test/' }),
    'https://example.test/api/v1/zcode-plan/billing/current',
  )
  assert.equal(
    buildQuotaUrl(QUOTA_ENDPOINTS.current, { baseOrigin: '  https://example.test:8443///  ' }),
    'https://example.test:8443/api/v1/zcode-plan/billing/current',
  )
})

// ---------------------------------------------------------------------------
// buildQuotaHeaders
// ---------------------------------------------------------------------------

test('buildQuotaHeaders sends Bearer auth plus the client version/platform pair', () => {
  const headers = buildQuotaHeaders({ jwt: `  ${JWT}  ` })
  assert.equal(headers.accept, 'application/json')
  assert.equal(headers.authorization, `Bearer ${JWT}`, 'the token must be trimmed')
  assert.equal(headers['X-ZCode-App-Version'], DEFAULT_APP_VERSION)
  assert.equal(headers['X-Platform'], defaultPlatformKey())
})

test('buildQuotaHeaders omits authorization when there is no token and accepts overrides', () => {
  const anonymous = buildQuotaHeaders({})
  assert.equal('authorization' in anonymous, false, 'no empty Bearer must be sent')
  assert.equal(buildQuotaHeaders({ jwt: '   ' }).authorization, undefined)

  const custom = buildQuotaHeaders({ jwt: JWT, appVersion: '9.9.9', platform: 'linux-arm64' })
  assert.equal(custom['X-ZCode-App-Version'], '9.9.9')
  assert.equal(custom['X-Platform'], 'linux-arm64')
})

test('buildQuotaHeaders sends X-Device-Mid only when a deviceMid is supplied', () => {
  // balance/preview 必须带这个头（否则 400 3001），current 不需要 —— 所以它是可选的。
  assert.equal('X-Device-Mid' in buildQuotaHeaders({ jwt: JWT }), false, 'no invented device id')
  assert.equal('X-Device-Mid' in buildQuotaHeaders({ jwt: JWT, deviceMid: '   ' }), false, 'blank is not an id')
  assert.equal(
    buildQuotaHeaders({ jwt: JWT, deviceMid: '  98b1e291-9e28-4eaf-b42b-e4acf9d58805  ' })['X-Device-Mid'],
    '98b1e291-9e28-4eaf-b42b-e4acf9d58805',
    'the device id is trimmed',
  )
})

test('readDeviceMid reads the client telemetry file and degrades to undefined', () => {
  const file = {
    deviceMid: ' 98b1e291-9e28-4eaf-b42b-e4acf9d58805 ',
    lastDailyActiveDate: '2026-10-27',
  }
  const read = readDeviceMid({
    dataBaseDir: 'D:\\AI\\zcode\\',
    readFileImpl: (path) => {
      // 路径拼接走 node:path，因此与平台一致；只断言文件名与目录结构。
      assert.match(path, /[\\/]\.zcode[\\/]v2[\\/]telemetry-state\.json$/u)
      assert.equal(path.includes('AI'), true)
      return JSON.stringify(file)
    },
  })
  assert.equal(read, '98b1e291-9e28-4eaf-b42b-e4acf9d58805')

  // 读不到 / 坏 JSON / 字段不是字符串 → undefined，绝不抛。
  assert.equal(readDeviceMid({ dataBaseDir: 'D:\\AI\\zcode', readFileImpl: () => { throw new Error('ENOENT') } }), undefined)
  assert.equal(readDeviceMid({ dataBaseDir: 'D:\\AI\\zcode', readFileImpl: () => 'not json' }), undefined)
  assert.equal(readDeviceMid({ dataBaseDir: 'D:\\AI\\zcode', readFileImpl: () => JSON.stringify({ deviceMid: 42 }) }), undefined)
  assert.equal(readDeviceMid({ dataBaseDir: 'D:\\AI\\zcode', readFileImpl: () => JSON.stringify({ deviceMid: '  ' }) }), undefined)
  assert.equal(readDeviceMid({ dataBaseDir: 'D:\\AI\\zcode', readFileImpl: () => JSON.stringify([1, 2]) }), undefined)
  assert.equal(readDeviceMid({ dataBaseDir: '' }), undefined)
  assert.equal(readDeviceMid({}), undefined)
})

// ---------------------------------------------------------------------------
// normalizeEntitlement
// ---------------------------------------------------------------------------

test('normalizeEntitlement keeps the measured fields and parses string grant_units', () => {
  const entitlement = normalizeEntitlement({
    entitlement_id: '  ent_1  ',
    show_name: '  GLM-5.3  ',
    meter: 'model_usage',
    unit_type: 'token',
    capabilities: ['model:GLM-5.3', ' other ', 'model:GLM-5.3', '', 42],
    grant_units: '1000',
    period: 'daily',
    priority: 110,
    effective_at: 0,
  })
  assert.deepEqual(entitlement, {
    id: 'ent_1',
    showName: 'GLM-5.3',
    meter: 'model_usage',
    unitType: 'token',
    grantUnits: 1000,
    period: 'daily',
    capabilities: ['model:GLM-5.3', 'other'],
    effectiveAt: 0,
  })
})

test('normalizeEntitlement drops entries without a usable entitlement_id', () => {
  assert.equal(normalizeEntitlement({}), undefined)
  assert.equal(normalizeEntitlement({ entitlement_id: '' }), undefined)
  assert.equal(normalizeEntitlement({ entitlement_id: '   ' }), undefined)
  assert.equal(normalizeEntitlement({ entitlement_id: 42 }), undefined, 'a non-string id is not an id')
  assert.equal(normalizeEntitlement(null), undefined)
  assert.equal(normalizeEntitlement(undefined), undefined)
})

test('normalizeEntitlement passes unknown meter/unit_type/period through untouched', () => {
  const entitlement = normalizeEntitlement({
    entitlement_id: 'ent_x',
    meter: 'some_future_meter',
    unit_type: 'credit',
    period: 'weekly',
    grant_units: 12,
  })
  assert.equal(entitlement.meter, 'some_future_meter', 'unknown meters must survive for display')
  assert.equal(entitlement.unitType, 'credit')
  assert.equal(entitlement.period, 'weekly')
})

test('normalizeEntitlement defaults a missing or unparsable grant_units to 0 and keeps seconds as-is', () => {
  assert.equal(normalizeEntitlement({ entitlement_id: 'e' }).grantUnits, 0)
  assert.equal(normalizeEntitlement({ entitlement_id: 'e', grant_units: 'abc' }).grantUnits, 0)
  assert.equal(normalizeEntitlement({ entitlement_id: 'e', grant_units: null }).grantUnits, 0)
  assert.equal(normalizeEntitlement({ entitlement_id: 'e', grant_units: 1.5 }).grantUnits, 1.5)

  // effective_at 是 Unix 秒：不得 *1000，也不得转成 Date。
  const withTime = normalizeEntitlement({ entitlement_id: 'e', effective_at: 1791943720 })
  assert.equal(withTime.effectiveAt, 1791943720)
  assert.equal('effectiveAt' in normalizeEntitlement({ entitlement_id: 'e' }), false)
})

// ---------------------------------------------------------------------------
// normalizePlan / normalizePlans
// ---------------------------------------------------------------------------

test('normalizePlan keeps starts_at/ends_at in Unix seconds and filters bad entitlements', () => {
  const plan = normalizePlan({
    plan_id: ' p1 ',
    name: ' Start Plan ',
    status: ' active ',
    starts_at: 1791943720,
    ends_at: 1792339199,
    entitlements: [
      { entitlement_id: 'e1', grant_units: 10 },
      { entitlement_id: '' },
      { entitlement_id: 'e2', grant_units: 20 },
    ],
  })
  assert.equal(plan.planId, 'p1')
  assert.equal(plan.name, 'Start Plan')
  assert.equal(plan.status, 'active')
  assert.equal(plan.startsAt, 1791943720, 'starts_at must stay in Unix seconds')
  assert.equal(plan.endsAt, 1792339199)
  assert.deepEqual(plan.entitlements.map((e) => e.id), ['e1', 'e2'])

  const bare = normalizePlan({})
  assert.equal(bare.planId, '', 'single normalization does not decide to drop anything')
  assert.equal('startsAt' in bare, false)
  assert.deepEqual(bare.entitlements, [])
  assert.deepEqual(normalizePlan({ plan_id: 'p', entitlements: 'not-an-array' }).entitlements, [])
})

test('normalizePlans returns [] for the measured empty response and never invents plans', () => {
  assert.deepEqual(normalizePlans(EMPTY_CURRENT.data.plans), [], 'plans:[] is the correct result, not a failure')
  assert.deepEqual(normalizePlans([]), [])
  assert.deepEqual(normalizePlans(undefined), [])
  assert.deepEqual(normalizePlans(null), [])
  assert.deepEqual(normalizePlans({ plans: [] }), [])
})

test('normalizePlans drops plans without a plan_id but keeps plans with no entitlements', () => {
  const plans = normalizePlans([
    { plan_id: 'p1', entitlements: [] },
    { plan_id: '', name: 'nameless' },
    { name: 'also nameless' },
    { plan_id: 'p2', entitlements: [{ entitlement_id: 'e1' }] },
  ])
  assert.deepEqual(plans.map((p) => p.planId), ['p1', 'p2'])
  assert.deepEqual(plans[0].entitlements, [], 'an empty entitlement list is upstream state, not garbage')
})

test('normalizePlans maps the full measured plan shape', () => {
  const plans = normalizePlans(FULL_CURRENT.data.plans)
  assert.equal(plans.length, 1)
  const plan = plans[0]
  assert.equal(plan.planId, 'zcode-v3-start-plan-0817')
  assert.equal(plan.name, 'ZCode Start Plan')
  assert.equal(plan.status, 'active')
  assert.equal(plan.startsAt, 1791943720)
  assert.equal(plan.endsAt, 1792339199)
  assert.equal(plan.entitlements.length, 2)
  assert.equal(plan.entitlements[1].grantUnits, 5000000, 'string grant_units must be parsed')
  assert.deepEqual(capabilityModelIds(plan.entitlements[0]), ['glm-5.3'])
})

// ---------------------------------------------------------------------------
// capabilityModelIds
// ---------------------------------------------------------------------------

test('capabilityModelIds keeps model: entries and drops non-model capabilities', () => {
  // 客户端的 eY / resolveZaiStartPlanBalanceModelIds 只认 `model:` 前缀，非 model: 条目丢弃。
  assert.deepEqual(
    capabilityModelIds({ capabilities: ['model:GLM-5.3', 'other'] }),
    ['GLM-5.3'],
    'only model: entries are model ids',
  )
  assert.deepEqual(
    capabilityModelIds({ capabilities: ['GLM-5.3-Flash', 'model:glm-5.3', 'MODEL:GLM-5.4'] }),
    ['glm-5.3', 'GLM-5.4'],
    'the prefix match is case-insensitive and wins over bare entries; id casing is preserved',
  )
  // 一条 model: 都没有时才退回裸条目（兼容 preview 的裸模型名变体）。
  assert.deepEqual(capabilityModelIds({ capabilities: ['GLM-5.3-Flash', 'glm-5.2'] }), ['GLM-5.3-Flash', 'glm-5.2'])
  assert.deepEqual(capabilityModelIds({ capabilities: ['model:glm-5.3', 'model:glm-5.3', 'glm-5.3'] }), ['glm-5.3'], 'dedupe')
  assert.deepEqual(capabilityModelIds({ capabilities: ['model:', '   ', 'model:  '] }), [])
  assert.deepEqual(capabilityModelIds({}), [])
  assert.deepEqual(capabilityModelIds({ capabilities: undefined }), [])
})

// ---------------------------------------------------------------------------
// summarizeQuota
// ---------------------------------------------------------------------------

test('summarizeQuota treats an empty plan list as the normal "no quota" state', () => {
  assert.deepEqual(summarizeQuota([]), { activePlans: 0, totalEntitlements: 0, byMeter: {} })
  assert.deepEqual(summarizeQuota(undefined), { activePlans: 0, totalEntitlements: 0, byMeter: {} })
  assert.deepEqual(summarizeQuota(normalizePlans(EMPTY_CURRENT.data.plans)), {
    activePlans: 0,
    totalEntitlements: 0,
    byMeter: {},
  })
})

test('summarizeQuota aggregates one plan with several entitlements', () => {
  // FULL_CURRENT 里第二条 entitlement 省略了 meter（真实非空样本确实可能缺字段），
  // 归一后它是空串，因此按 UNKNOWN_METER 单独成桶 —— 这本身就是正确行为。
  const summary = summarizeQuota(normalizePlans(FULL_CURRENT.data.plans))
  assert.equal(summary.activePlans, 1)
  assert.equal(summary.totalEntitlements, 2)
  assert.deepEqual(summary.byMeter.model_usage, { unitType: 'token', totalGranted: 3000000, periods: ['daily'] })
  assert.deepEqual(summary.byMeter[UNKNOWN_METER], { unitType: '', totalGranted: 5000000, periods: ['daily'] })

  // 两条都带 meter 时合并进同一个桶。
  const both = summarizeQuota(
    normalizePlans([
      {
        plan_id: 'p1',
        status: 'active',
        entitlements: [
          { entitlement_id: 'e1', meter: 'model_usage', unit_type: 'token', grant_units: 3000000, period: 'daily' },
          { entitlement_id: 'e2', meter: 'model_usage', unit_type: 'token', grant_units: 5000000, period: 'daily' },
        ],
      },
    ]),
  )
  assert.equal(both.activePlans, 1)
  assert.equal(both.totalEntitlements, 2)
  assert.deepEqual(both.byMeter, {
    model_usage: { unitType: 'token', totalGranted: 8000000, periods: ['daily'] },
  })
})

test('summarizeQuota merges the same meter across plans and dedupes periods', () => {
  const plans = normalizePlans([
    {
      plan_id: 'p1',
      status: 'active',
      entitlements: [{ entitlement_id: 'a', meter: 'model_usage', unit_type: 'token', grant_units: 100, period: 'daily' }],
    },
    {
      plan_id: 'p2',
      status: 'active',
      entitlements: [
        { entitlement_id: 'b', meter: 'model_usage', unit_type: 'token', grant_units: 200, period: 'daily' },
        { entitlement_id: 'c', meter: 'model_usage', unit_type: 'token', grant_units: 300, period: 'one_time' },
      ],
    },
  ])
  const summary = summarizeQuota(plans)
  assert.equal(summary.activePlans, 2)
  assert.equal(summary.totalEntitlements, 3)
  assert.deepEqual(summary.byMeter.model_usage, {
    unitType: 'token',
    totalGranted: 600,
    periods: ['daily', 'one_time'],
  })
})

test('summarizeQuota buckets a missing meter under UNKNOWN_METER and skips expired plans', () => {
  const plans = normalizePlans([
    {
      plan_id: 'p-expired',
      status: 'expired',
      entitlements: [{ entitlement_id: 'old', meter: 'model_usage', grant_units: 999 }],
    },
    {
      plan_id: 'p-active',
      status: 'active',
      entitlements: [
        { entitlement_id: 'x', grant_units: 10 },
        { entitlement_id: 'y', meter: '', unit_type: 'credit', grant_units: 5, period: 'weekly' },
      ],
    },
  ])
  const summary = summarizeQuota(plans)
  assert.equal(summary.activePlans, 1, 'expired plans do not count as active')
  assert.equal(summary.totalEntitlements, 2, 'entitlements of expired plans are not counted')
  assert.deepEqual(summary.byMeter[UNKNOWN_METER], { unitType: 'credit', totalGranted: 15, periods: ['weekly'] })
  assert.equal(summary.byMeter.model_usage, undefined)
})

test('summarizeQuota counts a plan without status as active (preview omits status)', () => {
  const plans = normalizePlans([{ plan_id: 'preview-plan', entitlements: [{ entitlement_id: 'e', grant_units: 1 }] }])
  assert.equal(summarizeQuota(plans).activePlans, 1)
})

// ---------------------------------------------------------------------------
// fetchBillingCurrent：主路径
// ---------------------------------------------------------------------------

test('fetchBillingCurrent reads the measured empty response as success', async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(EMPTY_CURRENT))
  const result = await fetchBillingCurrent({ jwt: JWT, fetchImpl })

  assert.deepEqual(result.plans, [])
  assert.equal(result.code, 0)
  assert.equal(result.message, '')
  assert.equal(result.serverTime, 1793089474)
  assert.equal(result.logid, EMPTY_CURRENT.logid)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.method, 'GET')
  const url = new URL(calls[0].url)
  assert.equal(url.origin + url.pathname, `${DEFAULT_BASE_ORIGIN}${QUOTA_ENDPOINTS.current}`)
  assert.equal(url.searchParams.get('app_version'), DEFAULT_APP_VERSION)
  assert.equal(url.searchParams.get('platform'), defaultPlatformKey())
  const headers = /** @type {Record<string, string>} */ (calls[0].init.headers)
  assert.equal(headers.authorization, `Bearer ${JWT}`)
  assert.equal(headers.accept, 'application/json')
})

test('fetchBillingCurrent normalizes the full plan shape and lets the caller override the query', async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(FULL_CURRENT))
  const result = await fetchBillingCurrent({
    jwt: JWT,
    fetchImpl,
    baseOrigin: 'https://example.test/',
    query: { platform: 'custom-platform', trace: 'abc' },
  })

  assert.equal(result.plans.length, 1)
  assert.equal(result.plans[0].planId, 'zcode-v3-start-plan-0817')
  assert.equal(result.serverTime, 1791943720)
  const url = new URL(calls[0].url)
  assert.equal(url.origin, 'https://example.test')
  assert.equal(url.searchParams.get('platform'), 'custom-platform', 'explicit query wins over the default')
  assert.equal(url.searchParams.get('trace'), 'abc')
  assert.equal(url.searchParams.get('app_version'), DEFAULT_APP_VERSION)
})

test('fetchBillingCurrent throws TOKEN_MISSING before touching the network', async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(EMPTY_CURRENT))
  for (const jwt of [undefined, '', '   ']) {
    await assert.rejects(fetchBillingCurrent({ jwt, fetchImpl }), (error) => {
      assert.ok(error instanceof QuotaError)
      assert.equal(error.code, 'TOKEN_MISSING')
      assert.equal(error.name, 'QuotaError')
      return true
    })
  }
  assert.equal(calls.length, 0, 'no request may be sent without a token')
})

test('fetchBillingCurrent maps the measured 401 empty body to HTTP_STATUS', async () => {
  // 真实实测：current 用错凭证 / 不带凭证 → 401 且响应体为空。
  const { fetchImpl } = recordingFetch(() => new Response('', { status: 401 }))
  await assert.rejects(fetchBillingCurrent({ jwt: JWT, fetchImpl }), (error) => {
    assert.ok(error instanceof QuotaError)
    assert.equal(error.code, 'HTTP_STATUS', 'an empty 401 is an auth failure, not a JSON parse failure')
    assert.equal(error.status, 401)
    return true
  })
})

test('fetchBillingCurrent maps a 200-carrying business error code to API_CODE', async () => {
  const payload = { code: 3001, msg: 'parameter error', logid: 'lg-3001' }
  const { fetchImpl } = recordingFetch(() => jsonResponse(payload))
  await assert.rejects(fetchBillingCurrent({ jwt: JWT, fetchImpl }), (error) => {
    assert.equal(error.code, 'API_CODE')
    assert.equal(error.upstreamCode, 3001)
    assert.equal(error.logid, 'lg-3001')
    assert.match(error.message, /3001/u)
    assert.match(error.message, /parameter error/u)
    return true
  })

  // 4xx 携带业务码时也走 API_CODE（上游用 400 表达参数错误）。
  const badRequest = recordingFetch(() => jsonResponse({ code: 3001, msg: 'parameter error' }, 400))
  await assert.rejects(fetchBillingCurrent({ jwt: JWT, fetchImpl: badRequest.fetchImpl }), (error) => {
    assert.equal(error.code, 'API_CODE')
    assert.equal(error.status, 400)
    return true
  })
})

test('fetchBillingCurrent maps a non-2xx envelope with a success code to HTTP_STATUS', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse({ code: 0, msg: '' }, 500))
  await assert.rejects(fetchBillingCurrent({ jwt: JWT, fetchImpl }), (error) => {
    assert.equal(error.code, 'HTTP_STATUS')
    assert.equal(error.status, 500)
    return true
  })
})

test('fetchBillingCurrent maps an HTML WAF page to INVALID_JSON', async () => {
  const { fetchImpl } = recordingFetch(
    () => new Response('<html><body>errors.aliyun.com request has been blocked</body></html>', { status: 403, headers: { 'content-type': 'text/html' } }),
  )
  await assert.rejects(fetchBillingCurrent({ jwt: JWT, fetchImpl }), (error) => {
    assert.equal(error.code, 'INVALID_JSON')
    assert.equal(error.status, 403)
    assert.match(error.body ?? '', /aliyun/u, 'the body excerpt must be kept for diagnosis')
    return true
  })
})

test('fetchBillingCurrent maps a missing data envelope to MISSING_DATA', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse({ code: 0, msg: '' }))
  await assert.rejects(fetchBillingCurrent({ jwt: JWT, fetchImpl }), (error) => {
    assert.equal(error.code, 'MISSING_DATA')
    return true
  })
})

test('fetchBillingCurrent maps transport failures and timeouts to NETWORK / TIMEOUT', async () => {
  const network = /** @type {typeof globalThis.fetch} */ (async () => {
    throw new TypeError('fetch failed')
  })
  await assert.rejects(fetchBillingCurrent({ jwt: JWT, fetchImpl: network }), (error) => {
    assert.equal(error.code, 'NETWORK')
    assert.match(error.message, /fetch failed/u)
    return true
  })

  const timeout = /** @type {typeof globalThis.fetch} */ (async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  })
  await assert.rejects(fetchBillingCurrent({ jwt: JWT, fetchImpl: timeout }), (error) => {
    assert.equal(error.code, 'TIMEOUT', 'an abort/timeout only needs a retry, it is not a network error')
    return true
  })
})

test('fetchBillingCurrent treats a string "0" code as success', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse({ code: '0', msg: '', data: { server_time: 1, plans: [] } }))
  const result = await fetchBillingCurrent({ jwt: JWT, fetchImpl })
  assert.equal(result.code, 0)
  assert.deepEqual(result.plans, [])
})

// ---------------------------------------------------------------------------
// fetchBillingBalance / fetchBillingPreview：永不抛
// ---------------------------------------------------------------------------

test('fetchBillingBalance never throws and returns the raw balances array on success', async () => {
  const payload = {
    code: 0,
    msg: '',
    data: {
      server_time: 1793089331,
      plans: [],
      balances: [
        {
          bucket_id: 'bucket_1',
          plan_id: 'zcode-v3-start-plan-0817',
          entitlement_id: 'ent_1',
          meter: 'model_usage',
          unit_type: 'token',
          total_units: 3000000,
          used_units: 0,
          remaining_units: 3000000,
          period_end: 1791993599,
        },
      ],
    },
    logid: 'lg-bal',
  }
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(payload))
  const result = await fetchBillingBalance({ jwt: JWT, fetchImpl })

  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
  assert.equal(result.serverTime, 1793089331)
  assert.equal(result.logid, 'lg-bal')
  assert.deepEqual(result.balances, payload.data.balances, 'balances is passed through untouched until the shape is verified')
  assert.deepEqual(result.plans, [])
  assert.equal(new URL(calls[0].url).pathname, QUOTA_ENDPOINTS.balance)
})

test('fetchBillingBalance turns the measured 400 parameter error into {ok:false, reason:"api_code"}', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse({ code: 3001, msg: 'parameter error', logid: 'lg-400' }, 400))
  const result = await fetchBillingBalance({ jwt: JWT, fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'api_code')
  assert.equal(result.status, 400)
  assert.equal(result.code, 3001)
  assert.equal(result.message, 'parameter error')
  assert.equal(result.logid, 'lg-400')
})

test('fetchBillingBalance never throws for missing token, network, timeout, non-JSON and 401', async () => {
  const missing = await fetchBillingBalance({ jwt: '' })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'token_missing')
  assert.equal(missing.status, 0)

  const network = await fetchBillingBalance({
    jwt: JWT,
    fetchImpl: /** @type {typeof globalThis.fetch} */ (async () => {
      throw new TypeError('fetch failed')
    }),
  })
  assert.equal(network.ok, false)
  assert.equal(network.reason, 'network')

  const timeout = await fetchBillingBalance({
    jwt: JWT,
    fetchImpl: /** @type {typeof globalThis.fetch} */ (async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    }),
  })
  assert.equal(timeout.ok, false)
  assert.equal(timeout.reason, 'timeout')

  const notJson = await fetchBillingBalance({ jwt: JWT, fetchImpl: recordingFetch(() => new Response('<html>', { status: 502 })).fetchImpl })
  assert.equal(notJson.ok, false)
  assert.equal(notJson.reason, 'invalid_json')

  const unauthorized = await fetchBillingBalance({ jwt: JWT, fetchImpl: recordingFetch(() => new Response('', { status: 401 })).fetchImpl })
  assert.equal(unauthorized.ok, false)
  assert.equal(unauthorized.reason, 'http_status')
  assert.equal(unauthorized.status, 401)
})

test('fetchBillingBalance reports missing data instead of inventing an empty balance', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse({ code: 0, msg: '' }))
  const result = await fetchBillingBalance({ jwt: JWT, fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing_data')
})

test('fetchBillingBalance forwards X-Device-Mid, which is what turns the 400 into a 200', async () => {
  // 实测：不带该头 → 400 code:3001；带上任意合法 UUID → 200。这里用假 fetch 把
  // 「头是否真的被发出去」钉住，因为这是该端点唯一能用的前提。
  const deviceMid = '98b1e291-9e28-4eaf-b42b-e4acf9d58805'
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ code: 0, msg: '', data: { server_time: 1, plans: [], balances: [] } }))
  const result = await fetchBillingBalance({ jwt: JWT, fetchImpl, deviceMid })
  assert.equal(result.ok, true)
  const headers = /** @type {Record<string, string>} */ (calls[0].init.headers)
  assert.equal(headers['X-Device-Mid'], deviceMid)
  assert.equal(headers.authorization, `Bearer ${JWT}`)

  // 不给 deviceMid 时不发这个头（而不是发一个空值）。
  const withoutDevice = recordingFetch(() => jsonResponse({ code: 0, msg: '', data: { server_time: 1, plans: [], balances: [] } }))
  await fetchBillingBalance({ jwt: JWT, fetchImpl: withoutDevice.fetchImpl })
  assert.equal('X-Device-Mid' in /** @type {Record<string, string>} */ (withoutDevice.calls[0].init.headers), false)
})

test('fetchBillingPreview forwards X-Device-Mid too', async () => {
  const deviceMid = '98b1e291-9e28-4eaf-b42b-e4acf9d58805'
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(EMPTY_PREVIEW))
  const result = await fetchBillingPreview({ jwt: JWT, fetchImpl, deviceMid })
  assert.equal(result.ok, true)
  assert.equal(/** @type {Record<string, string>} */ (calls[0].init.headers)['X-Device-Mid'], deviceMid)
})

test('fetchBillingPreview returns the normalized claimable plans on success', async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(FULL_CURRENT))
  const result = await fetchBillingPreview({ jwt: JWT, fetchImpl })

  assert.equal(result.ok, true)
  assert.equal(result.plans.length, 1)
  assert.equal(result.plans[0].entitlements[0].grantUnits, 3000000)
  assert.equal(result.body.length > 0, true, 'the body excerpt is kept for diagnostics')
  assert.equal(new URL(calls[0].url).pathname, QUOTA_ENDPOINTS.preview)
  assert.equal(new URL(calls[0].url).searchParams.get('platform'), defaultPlatformKey())
})

test('fetchBillingPreview never throws and reports the measured empty preview as success', async () => {
  const empty = await fetchBillingPreview({ jwt: JWT, fetchImpl: recordingFetch(() => jsonResponse(EMPTY_PREVIEW)).fetchImpl })
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.plans, [], 'no claimable plan is a normal result')

  const missing = await fetchBillingPreview({ jwt: '   ' })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'token_missing')

  const failed = await fetchBillingPreview({
    jwt: JWT,
    fetchImpl: recordingFetch(() => jsonResponse({ code: 3001, msg: 'parameter error' }, 400)).fetchImpl,
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'api_code')
  assert.equal(failed.code, 3001)
})

// ---------------------------------------------------------------------------
// QuotaCache
// ---------------------------------------------------------------------------

/**
 * 构造一个可推进的假时钟 + 假 fetch（每次调用返回不同的 plans，便于区分来源）。
 *
 * @param {{ plans?: unknown[], status?: number, payload?: unknown }[]} responses 每次请求的响应。
 * @returns {{ cache: QuotaCache, calls: { url: string, init: RequestInit }[], advance: (ms: number) => void, now: () => number }} 测试装置。
 */
function cacheHarness(responses) {
  let clock = 1_000_000
  /** @type {{ url: string, init: RequestInit }[]} */
  const calls = []
  let index = 0
  const fetchImpl = /** @type {typeof globalThis.fetch} */ (
    async (url, init) => {
      calls.push({ url: String(url), init: /** @type {RequestInit} */ (init ?? {}) })
      const response = responses[Math.min(index, responses.length - 1)]
      index += 1
      if (response.status !== undefined && response.status !== 200) {
        return new Response(JSON.stringify(response.payload ?? { code: 3001, msg: 'parameter error' }), { status: response.status })
      }
      return jsonResponse({
        code: 0,
        msg: '',
        data: { server_time: 1793089474, plans: response.plans ?? [] },
        logid: 'lg-cache',
      })
    }
  )
  const cache = new QuotaCache({ fetchImpl, now: () => clock, ttlMs: 60_000 })
  return {
    cache,
    calls,
    advance: (ms) => {
      clock += ms
    },
    now: () => clock,
  }
}

const PLAN_A = [
  {
    plan_id: 'plan-a',
    status: 'active',
    entitlements: [{ entitlement_id: 'a1', meter: 'model_usage', unit_type: 'token', grant_units: 100, period: 'daily' }],
  },
]
const PLAN_B = [
  {
    plan_id: 'plan-b',
    status: 'active',
    entitlements: [{ entitlement_id: 'b1', meter: 'model_usage', unit_type: 'token', grant_units: 200, period: 'daily' }],
  },
]

test('QuotaCache serves the second call from cache inside the TTL', async () => {
  const { cache, calls, advance } = cacheHarness([{ plans: PLAN_A }])
  assert.equal(cache.ttlMs, 60_000)

  const first = await cache.get({ jwt: JWT })
  assert.equal(first.ok, true)
  assert.equal(first.fromCache, false)
  assert.equal(first.summary.byMeter.model_usage.totalGranted, 100)
  assert.equal(first.fetchedAt, 1_000_000)
  assert.equal(first.serverTime, 1793089474)

  advance(59_999)
  const second = await cache.get({ jwt: JWT })
  assert.equal(second.ok, true)
  assert.equal(second.fromCache, true, 'a fresh snapshot must not hit the network')
  assert.equal(second.fetchedAt, 1_000_000)
  assert.equal(calls.length, 1)
})

test('QuotaCache refetches after the TTL expires', async () => {
  const { cache, calls, advance } = cacheHarness([{ plans: PLAN_A }, { plans: PLAN_B }])
  await cache.get({ jwt: JWT })
  advance(60_000)
  const refreshed = await cache.get({ jwt: JWT })
  assert.equal(refreshed.ok, true)
  assert.equal(refreshed.fromCache, false)
  assert.equal(refreshed.fetchedAt, 1_060_000)
  assert.equal(refreshed.summary.byMeter.model_usage.totalGranted, 200)
  assert.equal(calls.length, 2)
})

test('QuotaCache forceRefresh skips a warm cache but still repopulates it', async () => {
  const { cache, calls, advance } = cacheHarness([{ plans: PLAN_A }, { plans: PLAN_B }])
  await cache.get({ jwt: JWT })
  const forced = await cache.get({ jwt: JWT, forceRefresh: true })
  assert.equal(forced.fromCache, false)
  assert.equal(forced.summary.byMeter.model_usage.totalGranted, 200)
  assert.equal(calls.length, 2)

  advance(1_000)
  const afterForce = await cache.get({ jwt: JWT })
  assert.equal(afterForce.fromCache, true, 'a forced refresh must also write the cache')
  assert.equal(afterForce.summary.byMeter.model_usage.totalGranted, 200)
  assert.equal(calls.length, 2)
})

test('QuotaCache does not let a failed fetch poison the cache', async () => {
  const { cache, calls } = cacheHarness([{ status: 500, payload: { code: 0 } }, { plans: PLAN_A }])
  const failed = await cache.get({ jwt: JWT })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'http_status')
  assert.equal(failed.status, 500)
  assert.equal(cache.peek(), undefined, 'a failure must not write a cache entry')

  const recovered = await cache.get({ jwt: JWT })
  assert.equal(recovered.ok, true, 'the next call must be able to fetch real data')
  assert.equal(recovered.fromCache, false)
  assert.equal(recovered.summary.byMeter.model_usage.totalGranted, 100)
  assert.equal(calls.length, 2)
})

test('QuotaCache returns lastKnown when a refresh fails after a good snapshot', async () => {
  const { cache, calls } = cacheHarness([{ plans: PLAN_A }, { status: 400, payload: { code: 3001, msg: 'parameter error' } }])
  const good = await cache.get({ jwt: JWT })
  assert.equal(good.ok, true)

  const failed = await cache.get({ jwt: JWT, forceRefresh: true })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'api_code')
  assert.equal(failed.upstreamCode, 3001)
  assert.ok(failed.lastKnown, 'the previous snapshot must be carried out for stale display')
  assert.equal(failed.lastKnown.fetchedAt, good.fetchedAt)
  assert.equal(failed.lastKnown.summary.byMeter.model_usage.totalGranted, 100)
  assert.equal(failed.lastKnown.serverTime, 1793089474)
  assert.equal(calls.length, 2)
})

test('QuotaCache invalidates when the token changes (different account)', async () => {
  const { cache, calls } = cacheHarness([{ plans: PLAN_A }, { plans: PLAN_B }])
  await cache.get({ jwt: 'account-one' })
  const other = await cache.get({ jwt: 'account-two' })
  assert.equal(other.fromCache, false)
  assert.equal(other.summary.byMeter.model_usage.totalGranted, 200, 'the new account must never see the old account data')
  assert.equal(calls.length, 2)

  // 换回旧 token 也不该命中（缓存里只有一份快照，属于 account-two）。
  const back = await cache.get({ jwt: 'account-one' })
  assert.equal(back.fromCache, false)
  assert.equal(calls.length, 3)
})

test('QuotaCache reports token_missing and clear() empties the snapshot', async () => {
  const { cache, calls } = cacheHarness([{ plans: PLAN_A }])
  const missing = await cache.get({ jwt: '  ' })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'token_missing')
  assert.equal(calls.length, 0)

  await cache.get({ jwt: JWT })
  assert.notEqual(cache.peek(), undefined)
  cache.clear()
  assert.equal(cache.peek(), undefined)
  const refetched = await cache.get({ jwt: JWT })
  assert.equal(refetched.fromCache, false)
  assert.equal(calls.length, 2)
})

test('QuotaCache issues one request per concurrent caller (it deliberately has no single-flight)', async () => {
  // 模块文档明确写了「无单飞」：额度查询是低频调用，并发去重会引入取消语义复杂度。
  // 这条测试把这个决定钉住，避免有人误以为它是 bug 又悄悄改掉。
  const { cache, calls } = cacheHarness([{ plans: PLAN_A }, { plans: PLAN_B }])
  const [first, second] = await Promise.all([cache.get({ jwt: JWT }), cache.get({ jwt: JWT })])
  assert.equal(calls.length, 2, 'two concurrent callers issue two requests by design')
  assert.equal(first.ok && second.ok, true)
  assert.equal(first.fromCache, false)
  assert.equal(second.fromCache, false)

  // 但并发之后缓存里是最后完成的那份，第三次调用必须命中。
  const third = await cache.get({ jwt: JWT })
  assert.equal(third.fromCache, true)
  assert.equal(calls.length, 2)
})

test('QuotaCache keeps ttlMs=0 meaning "never reuse"', async () => {
  let clock = 5_000
  const { fetchImpl, calls } = recordingFetch(() =>
    jsonResponse({ code: 0, msg: '', data: { server_time: 1, plans: PLAN_A } }),
  )
  const cache = new QuotaCache({ fetchImpl, now: () => clock, ttlMs: 0 })
  assert.equal(cache.ttlMs, 0)
  const first = await cache.get({ jwt: JWT })
  assert.equal(first.fromCache, false)
  clock += 1
  const second = await cache.get({ jwt: JWT })
  assert.equal(second.fromCache, false)
  assert.equal(calls.length, 2)
})
