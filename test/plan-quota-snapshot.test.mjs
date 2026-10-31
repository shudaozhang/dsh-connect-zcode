/**
 * 套餐额度显示的行为契约。
 *
 * 这些断言来自 2026-11-01 的实测：额度接口（`billing/balance`）在模型端点被 WAF 拦
 * （`3012`）时**依然正常**，所以「额度显示」必须在模型不通时也照常工作 —— 否则用户
 * 遇到 3012 时既看不到原因、也看不到额度还剩多少。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SNAPSHOT_TTL_MS,
  QuotaSnapshotter,
  balanceMatchesModel,
  describeQuota,
  formatUnitCount,
  summarizeBalances,
} from '../lib/plan-quota-snapshot.js'

/** 一组合乎实测形状的归一化 balance（`fetchBillingBalance` 的输出形态）。 */
const BALANCES = [
  {
    bucketId: 'bucket_1',
    planId: 'zcode-v3-start-plan-1030-wk',
    entitlementId: 'ent-...-1',
    showName: 'GLM-5.3-Flash',
    meter: 'model_usage',
    unitType: 'token',
    capabilities: ['model:glm-5.3-flash'],
    totalUnits: 500_000_000,
    usedUnits: 2_560_947,
    remainingUnits: 497_439_053,
    availableUnits: 497_439_053,
    expiresAt: 1_793_581_200,
  },
]

/**
 * 同一组余额的**上游原始形状**（snake_case）。
 *
 * 假 fetch 必须模拟上游，而不是模拟我们自己的归一结果：`fetchBillingBalance` 会把
 * snake_case 转成 camelCase，喂 camelCase 进去会让归一时在 `bucket_id` 上失配、
 * 把所有条目丢光（这条曾在实现里真的发生过一次）。
 */
const RAW_BALANCES = BALANCES.map((balance) => ({
  bucket_id: balance.bucketId,
  plan_id: balance.planId,
  entitlement_id: balance.entitlementId,
  show_name: balance.showName,
  meter: balance.meter,
  unit_type: balance.unitType,
  capabilities: balance.capabilities,
  total_units: balance.totalUnits,
  used_units: balance.usedUnits,
  remaining_units: balance.remainingUnits,
  available_units: balance.availableUnits,
  expires_at: balance.expiresAt,
}))

/** 造一个返回固定 `billing/balance` 信封的假 fetch，并记录调用次数。 */
function quotaFetch(rawBalances, calls = { n: 0 }) {
  return /** @type {typeof fetch} */ (async () => {
    calls.n += 1
    return new Response(JSON.stringify({
      code: 0,
      msg: '',
      data: { server_time: 1_793_467_000, plans: [], balances: rawBalances },
      logid: 'lg-test',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

test('formatUnitCount uses Chinese magnitudes so a description stays one line', () => {
  assert.equal(formatUnitCount(497_439_053), '4.97 亿')
  assert.equal(formatUnitCount(500_000_000), '5.00 亿')
  assert.equal(formatUnitCount(12_345), '1.2 万')
  assert.equal(formatUnitCount(999), '999')
  assert.equal(formatUnitCount(Number.NaN), '?')
})

test('summarizeBalances adds up what is left and remembers which models it covers', () => {
  const summary = summarizeBalances(BALANCES)
  assert.equal(summary.available, 497_439_053)
  assert.equal(summary.total, 500_000_000)
  assert.deepEqual(summary.models, ['GLM-5.3-Flash'])
  // available_units 缺失时退回 remaining_units
  const noAvailable = summarizeBalances([{ ...BALANCES[0], availableUnits: undefined }])
  assert.equal(noAvailable.available, 497_439_053)
})

test('balanceMatchesModel matches on capabilities case-insensitively and on show_name', () => {
  assert.equal(balanceMatchesModel(BALANCES[0], 'GLM-5.3-Flash'), true)
  assert.equal(balanceMatchesModel(BALANCES[0], 'glm-5.3-flash'), true)
  assert.equal(balanceMatchesModel(BALANCES[0], 'GLM-5.3'), false)
  assert.equal(balanceMatchesModel(BALANCES[0], ''), false)
  // show_name 命中（capabilities 为空时）
  assert.equal(balanceMatchesModel({ ...BALANCES[0], capabilities: [] }, 'GLM-5.3-Flash'), true)
})

test('describeQuota reports remaining/total for the model that actually owns the balance', () => {
  const state = { ok: true, fetchedAt: 0, balances: BALANCES }
  assert.equal(
    describeQuota(state, 'start → coding', 'GLM-5.3-Flash'),
    'start → coding · quota 4.97 亿/5.00 亿 (99%)',
  )
  // 额度不属于这个模型时必须说出来，而不是显示成"没额度"
  assert.equal(
    describeQuota(state, 'coding', 'GLM-5.3'),
    'coding · quota: no plan for GLM-5.3',
  )
  // 不指定模型时汇总全部
  assert.equal(describeQuota(state, 'chain'), 'chain · quota 4.97 亿/5.00 亿 (99%)')
})

test('describeQuota never invents a zero when the lookup failed', () => {
  // 0 会被读成"额度用完了"，所以失败一律写 unknown。
  assert.equal(
    describeQuota({ ok: false, fetchedAt: 0, reason: 'token_missing' }, 'chain'),
    'chain · quota unknown (no token)',
  )
  assert.equal(
    describeQuota({ ok: false, fetchedAt: 0, reason: 'network' }, 'chain'),
    'chain · quota unknown (network)',
  )
  // 成功但没有余额条目：明确说"账号未报告余额"
  assert.equal(
    describeQuota({ ok: true, fetchedAt: 0, balances: [] }, 'chain'),
    'chain · quota: account reports no balance',
  )
  // 没有快照时原样返回
  assert.equal(describeQuota(undefined, 'chain'), 'chain')
})

test('QuotaSnapshotter returns a success state and caches it for the TTL', async () => {
  const calls = { n: 0 }
  const now = { t: 1_000_000 }
  const snapshotter = new QuotaSnapshotter({
    fetchImpl: quotaFetch(RAW_BALANCES, calls),
    now: () => now.t,
    appVersion: '3.17.1',
  })
  const first = await snapshotter.get({ token: 'jwt', dataBaseDir: 'D:/fake' })
  assert.equal(first.ok, true)
  assert.equal(first.balances.length, 1)
  assert.equal(calls.n, 1)

  // TTL 内不再打上游
  now.t += DEFAULT_SNAPSHOT_TTL_MS - 1
  const second = await snapshotter.get({ token: 'jwt', dataBaseDir: 'D:/fake' })
  assert.equal(calls.n, 1, 'a cached snapshot must not hit the network again')
  assert.equal(second.fetchedAt, first.fetchedAt)
})

test('QuotaSnapshotter refreshes after the TTL expires', async () => {
  const calls = { n: 0 }
  const now = { t: 1_000_000 }
  const snapshotter = new QuotaSnapshotter({
    fetchImpl: quotaFetch(RAW_BALANCES, calls),
    now: () => now.t,
  })
  await snapshotter.get({ token: 'jwt', dataBaseDir: 'D:/fake' })
  now.t += DEFAULT_SNAPSHOT_TTL_MS + 1
  await snapshotter.get({ token: 'jwt', dataBaseDir: 'D:/fake' })
  assert.equal(calls.n, 2)
})

test('QuotaSnapshotter degrades to a failure state instead of throwing', async () => {
  const noToken = new QuotaSnapshotter({ fetchImpl: quotaFetch(RAW_BALANCES) })
  const state = await noToken.get({ token: '', dataBaseDir: 'D:/fake' })
  assert.equal(state.ok, false)
  assert.equal(state.reason, 'token_missing')
  // 关键契约：永不抛出 —— 它挂在 listModels() 里，抛了就连模型都列不出来。
  assert.equal(describeQuota(state, 'chain'), 'chain · quota unknown (no token)')
})

test('QuotaSnapshotter survives a throwing fetch', async () => {
  const snapshotter = new QuotaSnapshotter({
    fetchImpl: /** @type {typeof fetch} */ (async () => { throw new Error('socket hang up') }),
  })
  const state = await snapshotter.get({ token: 'jwt', dataBaseDir: 'D:/fake' })
  assert.equal(state.ok, false)
  assert.match(describeQuota(state, 'chain'), /quota unknown/u)
})

test('QuotaSnapshotter coalesces concurrent callers into one request', async () => {
  const calls = { n: 0 }
  const snapshotter = new QuotaSnapshotter({ fetchImpl: quotaFetch(RAW_BALANCES, calls) })
  const [a, b, c] = await Promise.all([
    snapshotter.get({ token: 'jwt', dataBaseDir: 'D:/fake' }),
    snapshotter.get({ token: 'jwt', dataBaseDir: 'D:/fake' }),
    snapshotter.get({ token: 'jwt', dataBaseDir: 'D:/fake' }),
  ])
  assert.equal(calls.n, 1, 'three concurrent callers must share one request')
  assert.equal(a.ok && b.ok && c.ok, true)
})

test('QuotaSnapshotter backs off after a failure instead of retrying every call', async () => {
  const calls = { n: 0 }
  const now = { t: 1_000_000 }
  const failing = /** @type {typeof fetch} */ (async () => {
    calls.n += 1
    throw new Error('network down')
  })
  const snapshotter = new QuotaSnapshotter({ fetchImpl: failing, now: () => now.t })
  await snapshotter.get({ token: 'jwt', dataBaseDir: 'D:/fake' })
  assert.equal(calls.n, 1)
  // 失败后紧跟着再问，不该再打一次上游（选择器会被反复打开）。
  await snapshotter.get({ token: 'jwt', dataBaseDir: 'D:/fake' })
  assert.equal(calls.n, 1, 'a failed lookup must back off before hammering upstream')
})
