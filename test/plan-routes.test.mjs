/**
 * `lib/plan-routes.js` 的离线单测。
 *
 * 这些测试**不依赖本机装没装 ZCode 客户端**：release 用内联 JSON 构造，磁盘路径用临时
 * 目录伪造。唯一的例外是最后一个用例，它只在本机确实存在 release 时才跑（存在性检查在
 * 用例内部，缺了就 skip），用来防止「归一逻辑对着内联样本全绿、对着真文件却解析不出来」。
 *
 * 覆盖点：
 * - `inferPlanKind` / `inferFamily`：`access.mode` 优先，拼写变体（off-peak / offpeak）与
 *   providerId 兜底
 * - `authKindFor`：四种鉴权形态的映射
 * - `normalizeProviderRule`：只要 `account:*`、缺 baseUrl / 模型清单时丢弃、去重
 * - `normalizeRelease`：整份 release 归一 + 排序
 * - `compareProviders`：start-plan → coding-plan → offpeak → highspeed
 * - `planModelId` / `parsePlanModelId`：`#` / `/` / 裸 modelId 三种写法
 * - `expandPlanModels`：路由 × 模型展开
 * - `loadPlanCatalogue`：读不到时降级到内置快照，且**永不抛**
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  FALLBACK_PLAN_PROVIDERS,
  PLAN_KINDS,
  PLAN_KIND_ORDER,
  authKindFor,
  compareProviders,
  expandPlanModels,
  findLatestRelease,
  findProvider,
  inferFamily,
  inferPlanKind,
  loadPlanCatalogue,
  normalizeProviderRule,
  normalizeRelease,
  parsePlanModelId,
  planModelId,
} from '../lib/plan-routes.js'

/** 一条最小可用的 release provider 规则。 */
function rule(overrides = {}) {
  return {
    providerId: 'account:zai-start-plan',
    providerName: 'Start Plan',
    config: {
      group: 'zai-family',
      access: { type: 'zhipu-account', accountType: 'zai', mode: 'start-plan' },
      api: { type: 'anthropic-messages', baseUrl: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic' },
      builtinModelIds: ['GLM-5.3-Flash', 'GLM-5.2'],
      ...(overrides.config ?? {}),
    },
    ...(overrides.providerId === undefined ? {} : { providerId: overrides.providerId }),
    ...(overrides.providerName === undefined ? {} : { providerName: overrides.providerName }),
  }
}

/** 一份完整的 release 外壳。 */
function release(rules) {
  return { schemaVersion: 1, revision: 33, config: { providerConfigRules: { providerRules: rules } } }
}

// ── inferPlanKind ───────────────────────────────────────────────────────────

test('inferPlanKind 优先信 access.mode', () => {
  assert.equal(inferPlanKind('account:zai-start-plan', 'start-plan'), 'start-plan')
  assert.equal(inferPlanKind('account:zai-start-plan', 'individual-coding-plan'), 'individual-coding-plan')
  assert.equal(inferPlanKind('account:whatever', 'team-coding-plan'), 'team-coding-plan')
})

test('inferPlanKind 认得 off-peak / highspeed 的两种拼写', () => {
  assert.equal(inferPlanKind('account:zai-offpeak-idle-plan', 'off-peak'), 'offpeak-idle-plan')
  assert.equal(inferPlanKind('account:zai-offpeak-idle-plan', 'offpeak-idle-plan'), 'offpeak-idle-plan')
  assert.equal(inferPlanKind('account:zai-highspeed-card', 'highspeed'), 'highspeed-card')
  assert.equal(inferPlanKind('account:zai-highspeed-card', 'highspeed-card'), 'highspeed-card')
})

test('inferPlanKind 在没有 mode 时退回 providerId 后缀', () => {
  assert.equal(inferPlanKind('account:zai-start-plan'), 'start-plan')
  assert.equal(inferPlanKind('account:bigmodel-start-plan'), 'start-plan')
  assert.equal(inferPlanKind('account:zai-offpeak-idle-plan'), 'offpeak-idle-plan')
  assert.equal(inferPlanKind('account:zai-highspeed-card'), 'highspeed-card')
  assert.equal(inferPlanKind('account:zai-team-coding-plan'), 'team-coding-plan')
  assert.equal(inferPlanKind('account:zai-individual-coding-plan'), 'individual-coding-plan')
})

test('inferPlanKind 的兜底是 individual-coding-plan', () => {
  assert.equal(inferPlanKind('account:something-else'), 'individual-coding-plan')
  assert.equal(inferPlanKind('account:something-else', 'unknown-mode'), 'individual-coding-plan')
})

// ── inferFamily ─────────────────────────────────────────────────────────────

test('inferFamily 优先信 access.accountType', () => {
  assert.equal(inferFamily('account:zai-start-plan', 'bigmodel'), 'bigmodel')
  assert.equal(inferFamily('account:bigmodel-start-plan', 'zai'), 'zai')
})

test('inferFamily 在没有 accountType 时看 providerId', () => {
  assert.equal(inferFamily('account:bigmodel-start-plan'), 'bigmodel')
  assert.equal(inferFamily('account:zai-start-plan'), 'zai')
})

// ── authKindFor ─────────────────────────────────────────────────────────────

test('authKindFor 覆盖四种鉴权形态', () => {
  assert.equal(authKindFor('start-plan'), 'bearer-jwt')
  assert.equal(authKindFor('individual-coding-plan'), 'api-key')
  assert.equal(authKindFor('team-coding-plan'), 'api-key')
  assert.equal(authKindFor('offpeak-idle-plan'), 'bearer-jwt+coding-plan-key')
  assert.equal(authKindFor('highspeed-card'), 'bearer-jwt+coding-plan-key+card-id')
})

test('每个 PLAN_KIND 都有排序权重和鉴权形态', () => {
  for (const kind of PLAN_KINDS) {
    assert.equal(typeof PLAN_KIND_ORDER[kind], 'number', `${kind} 缺排序权重`)
    assert.equal(typeof authKindFor(kind), 'string', `${kind} 缺鉴权形态`)
  }
})

// ── normalizeProviderRule ───────────────────────────────────────────────────

test('normalizeProviderRule 归一一条 start-plan 规则', () => {
  const provider = normalizeProviderRule(rule())
  assert.ok(provider !== undefined)
  assert.equal(provider.providerId, 'account:zai-start-plan')
  assert.equal(provider.providerName, 'Start Plan')
  assert.equal(provider.family, 'zai')
  assert.equal(provider.planKind, 'start-plan')
  assert.equal(provider.baseUrl, 'https://zcode.z.ai/api/v1/zcode-plan/anthropic')
  assert.deepEqual([...provider.modelIds], ['GLM-5.3-Flash', 'GLM-5.2'])
  assert.equal(provider.authKind, 'bearer-jwt')
})

test('normalizeProviderRule 丢弃非 account:* 规则', () => {
  assert.equal(normalizeProviderRule(rule({ providerId: 'new-provider-3' })), undefined)
  assert.equal(normalizeProviderRule(rule({ providerId: 'deepseek' })), undefined)
})

test('normalizeProviderRule 在缺 baseUrl 或模型清单时丢弃', () => {
  assert.equal(normalizeProviderRule(rule({ config: { api: {} } })), undefined)
  assert.equal(normalizeProviderRule(rule({ config: { builtinModelIds: [], personalModelIds: [] } })), undefined)
})

test('normalizeProviderRule 去掉 baseUrl 末尾斜杠', () => {
  const provider = normalizeProviderRule(rule({ config: { api: { type: 'anthropic-messages', baseUrl: 'https://x.test/a/' } } }))
  assert.equal(provider?.baseUrl, 'https://x.test/a')
})

test('normalizeProviderRule 合并 builtinModelIds 与 personalModelIds 并去重', () => {
  const provider = normalizeProviderRule(rule({
    config: { builtinModelIds: ['GLM-5.3', 'GLM-5.3'], personalModelIds: ['GLM-5.3', 'GLM-5.2'] },
  }))
  assert.deepEqual([...provider.modelIds], ['GLM-5.3', 'GLM-5.2'])
})

test('normalizeProviderRule 对畸形输入返回 undefined 而不抛', () => {
  for (const bad of [null, undefined, 1, 'text', [], {}]) {
    assert.equal(normalizeProviderRule(bad), undefined)
  }
})

// ── normalizeRelease / 排序 ──────────────────────────────────────────────────

test('normalizeRelease 归一整份 release 并按套餐优先级排序', () => {
  const providers = normalizeRelease(release([
    rule({ providerId: 'account:zai-highspeed-card', config: { access: { accountType: 'zai', mode: 'highspeed' } } }),
    rule({ providerId: 'account:zai-start-plan' }),
    rule({ providerId: 'account:zai-individual-coding-plan', config: { access: { accountType: 'zai', mode: 'individual-coding-plan' } } }),
    rule({ providerId: 'account:zai-offpeak-idle-plan', config: { access: { accountType: 'zai', mode: 'off-peak' } } }),
    rule({ providerId: 'new-provider-3' }),
  ]))
  assert.deepEqual(providers.map((provider) => provider.planKind), [
    'start-plan',
    'individual-coding-plan',
    'offpeak-idle-plan',
    'highspeed-card',
  ])
})

test('normalizeRelease 对空 / 畸形 release 返回空数组', () => {
  assert.deepEqual(normalizeRelease(null), [])
  assert.deepEqual(normalizeRelease({}), [])
  assert.deepEqual(normalizeRelease({ config: {} }), [])
  assert.deepEqual(normalizeRelease({ config: { providerConfigRules: { providerRules: [] } } }), [])
})

test('compareProviders 同套餐时按 providerId 稳定排序', () => {
  const providers = normalizeRelease(release([
    rule({ providerId: 'account:zai-start-plan' }),
    rule({ providerId: 'account:bigmodel-start-plan', config: { access: { accountType: 'bigmodel', mode: 'start-plan' } } }),
  ]))
  assert.deepEqual(providers.map((provider) => provider.providerId), [
    'account:bigmodel-start-plan',
    'account:zai-start-plan',
  ])
  assert.equal(compareProviders(providers[0], providers[1]) < 0, true)
})

// ── 模型 id ─────────────────────────────────────────────────────────────────

test('planModelId 用 # 连接路由与模型', () => {
  assert.equal(planModelId('account:zai-start-plan', 'GLM-5.3-Flash'), 'account:zai-start-plan#GLM-5.3-Flash')
})

test('parsePlanModelId 支持 # 写法', () => {
  assert.deepEqual(parsePlanModelId('account:zai-start-plan#GLM-5.3-Flash'), {
    providerId: 'account:zai-start-plan',
    modelId: 'GLM-5.3-Flash',
  })
})

test('parsePlanModelId 支持 / 写法（仅当前半段是 account: 时）', () => {
  assert.deepEqual(parsePlanModelId('account:zai-start-plan/GLM-5.3-Flash'), {
    providerId: 'account:zai-start-plan',
    modelId: 'GLM-5.3-Flash',
  })
  // 不像 providerId 的斜杠串不能被误拆
  assert.equal(parsePlanModelId('GLM-5.3/Flash', []), undefined)
})

test('parsePlanModelId 对裸 modelId 按路由优先级解析', () => {
  const providers = normalizeRelease(release([
    rule({ providerId: 'account:zai-individual-coding-plan', config: { access: { accountType: 'zai', mode: 'individual-coding-plan' }, builtinModelIds: ['GLM-5.3'] } }),
    rule({ providerId: 'account:zai-start-plan' }),
  ]))
  // GLM-5.3-Flash 只在 start-plan 上
  assert.deepEqual(parsePlanModelId('GLM-5.3-Flash', providers), {
    providerId: 'account:zai-start-plan',
    modelId: 'GLM-5.3-Flash',
  })
  // GLM-5.3 只在 coding-plan 上
  assert.deepEqual(parsePlanModelId('GLM-5.3', providers), {
    providerId: 'account:zai-individual-coding-plan',
    modelId: 'GLM-5.3',
  })
})

test('parsePlanModelId 对无法解析的值返回 undefined', () => {
  for (const bad of ['', '   ', undefined, null, 'no-such-model', '#GLM-5.3', 'account:zai-start-plan#']) {
    assert.equal(parsePlanModelId(bad, []), undefined)
  }
})

// ── expandPlanModels / findProvider ─────────────────────────────────────────

test('expandPlanModels 展开成路由 × 模型并按优先级排序', () => {
  const providers = normalizeRelease(release([
    rule({ providerId: 'account:zai-individual-coding-plan', config: { access: { accountType: 'zai', mode: 'individual-coding-plan' }, builtinModelIds: ['GLM-5.3'] } }),
    rule({ providerId: 'account:zai-start-plan' }),
  ]))
  const flat = expandPlanModels(providers)
  assert.equal(flat.length, 3)
  assert.equal(flat[0].id, 'account:zai-start-plan#GLM-5.3-Flash')
  assert.equal(flat[0].planKind, 'start-plan')
  assert.equal(flat[2].id, 'account:zai-individual-coding-plan#GLM-5.3')
})

test('expandPlanModels 对空表返回空数组', () => {
  assert.deepEqual(expandPlanModels([]), [])
})

test('findProvider 按 providerId 精确匹配', () => {
  const providers = normalizeRelease(release([rule()]))
  assert.equal(findProvider(providers, 'account:zai-start-plan')?.providerId, 'account:zai-start-plan')
  assert.equal(findProvider(providers, 'account:nope'), undefined)
  assert.equal(findProvider(providers, ''), undefined)
})

// ── 内置降级表 ──────────────────────────────────────────────────────────────

test('内置降级表含 10 条路由，且每条都有模型与合法鉴权形态', () => {
  assert.equal(FALLBACK_PLAN_PROVIDERS.length, 10)
  for (const provider of FALLBACK_PLAN_PROVIDERS) {
    assert.ok(provider.modelIds.length > 0, `${provider.providerId} 没有模型`)
    assert.equal(provider.authKind, authKindFor(provider.planKind))
    assert.ok(provider.baseUrl.startsWith('https://'), `${provider.providerId} baseUrl 不是 https`)
    assert.ok(PLAN_KINDS.includes(provider.planKind), `${provider.providerId} planKind 非法`)
  }
})

test('内置降级表里 start-plan 用 zcode-plan 端点，coding-plan 用各家 anthropic 端点', () => {
  const start = FALLBACK_PLAN_PROVIDERS.find((provider) => provider.providerId === 'account:zai-start-plan')
  assert.equal(start?.baseUrl, 'https://zcode.z.ai/api/v1/zcode-plan/anthropic')
  const zai = FALLBACK_PLAN_PROVIDERS.find((provider) => provider.providerId === 'account:zai-individual-coding-plan')
  assert.equal(zai?.baseUrl, 'https://api.z.ai/api/anthropic')
  const bigmodel = FALLBACK_PLAN_PROVIDERS.find((provider) => provider.providerId === 'account:bigmodel-individual-coding-plan')
  assert.equal(bigmodel?.baseUrl, 'https://open.bigmodel.cn/api/anthropic')
})

// ── loadPlanCatalogue ──────────────────────────────────────────────────────

test('loadPlanCatalogue 在没有数据根时降级到内置表', () => {
  const catalogue = loadPlanCatalogue({})
  assert.equal(catalogue.source, 'fallback')
  assert.equal(catalogue.providers.length, FALLBACK_PLAN_PROVIDERS.length)
  assert.equal(typeof catalogue.reason, 'string')
})

test('loadPlanCatalogue 在数据根不存在时降级而不抛', () => {
  const catalogue = loadPlanCatalogue({ dataBaseDir: path.join(tmpdir(), 'definitely-not-a-zcode-dir-xyz') })
  assert.equal(catalogue.source, 'fallback')
})

test('loadPlanCatalogue 从伪造的 release 目录读路由', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zcode-plan-routes-'))
  try {
    const platformDir = process.platform === 'win32'
      ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
      : `${process.platform}-${process.arch}`
    const releaseDir = path.join(dir, '.zcode', 'v2', 'runtime', 'provider', platformDir, '3.16.3', 'endpoint-abc123')
    mkdirSync(releaseDir, { recursive: true })
    writeFileSync(path.join(releaseDir, 'zcode-builtin.json'), JSON.stringify(release([rule()])), 'utf8')

    const catalogue = loadPlanCatalogue({ dataBaseDir: dir })
    assert.equal(catalogue.source, 'builtin-release')
    assert.equal(catalogue.providers.length, 1)
    assert.equal(catalogue.providers[0].providerId, 'account:zai-start-plan')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadPlanCatalogue 对损坏的 release 降级而不抛', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zcode-plan-routes-bad-'))
  try {
    const platformDir = process.platform === 'win32'
      ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
      : `${process.platform}-${process.arch}`
    const releaseDir = path.join(dir, '.zcode', 'v2', 'runtime', 'provider', platformDir, '3.16.3', 'endpoint-bad')
    mkdirSync(releaseDir, { recursive: true })
    writeFileSync(path.join(releaseDir, 'zcode-builtin.json'), '{not json', 'utf8')

    const catalogue = loadPlanCatalogue({ dataBaseDir: dir })
    assert.equal(catalogue.source, 'fallback')
    assert.equal(catalogue.providers.length, FALLBACK_PLAN_PROVIDERS.length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadPlanCatalogue 在 release 无 account:* 规则时降级', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zcode-plan-routes-empty-'))
  try {
    const platformDir = process.platform === 'win32'
      ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
      : `${process.platform}-${process.arch}`
    const releaseDir = path.join(dir, '.zcode', 'v2', 'runtime', 'provider', platformDir, '3.16.3', 'endpoint-empty')
    mkdirSync(releaseDir, { recursive: true })
    writeFileSync(
      path.join(releaseDir, 'zcode-builtin.json'),
      JSON.stringify(release([rule({ providerId: 'new-provider-3' })])),
      'utf8',
    )
    const catalogue = loadPlanCatalogue({ dataBaseDir: dir })
    assert.equal(catalogue.source, 'fallback')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findLatestRelease 取修改时间最新的 release', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zcode-plan-routes-latest-'))
  try {
    const platformDir = process.platform === 'win32'
      ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
      : `${process.platform}-${process.arch}`
    const base = path.join(dir, '.zcode', 'v2', 'runtime', 'provider', platformDir)
    for (const [version, endpoint] of [['3.14.0', 'endpoint-old'], ['3.16.3', 'endpoint-new']]) {
      const releaseDir = path.join(base, version, endpoint)
      mkdirSync(releaseDir, { recursive: true })
      writeFileSync(path.join(releaseDir, 'zcode-builtin.json'), JSON.stringify(release([rule()])), 'utf8')
    }
    const found = findLatestRelease(dir)
    assert.ok(found !== undefined)
    assert.ok(found.includes('3.16.3'), `expected the newer release, got ${found}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findLatestRelease 在目录不存在时返回 undefined', () => {
  assert.equal(findLatestRelease(path.join(tmpdir(), 'no-such-zcode-root-abc')), undefined)
})
