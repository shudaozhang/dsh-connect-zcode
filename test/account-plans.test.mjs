// Unit tests for multi-plan account registration and route collapse preference.
// Run with: node --test test/account-plans.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeAccountFamily,
  buildAccountConfigSnapshot,
  pickAccountProviders,
} from '../lib/account-sync.js'
import { collapseCatalog } from '../lib/zcode-runtime.js'

/** Minimal builtin-release rules mirroring the real zcode-builtin.json shape. */
const rules = [
  {
    providerId: 'account:zai-start-plan',
    config: { access: { type: 'zhipu-account', accountType: 'zai', mode: 'start-plan' }, builtinModelIds: ['GLM-5.3-Flash'] },
  },
  {
    providerId: 'account:bigmodel-start-plan',
    config: { access: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'start-plan' }, builtinModelIds: ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo'] },
  },
  {
    providerId: 'account:bigmodel-individual-coding-plan',
    config: { access: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'individual-coding-plan' }, builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'] },
  },
  {
    providerId: 'account:bigmodel-team-coding-plan',
    config: { access: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'team-coding-plan' }, builtinModelIds: ['GLM-5.3'] },
  },
  {
    providerId: 'account:bigmodel-offpeak-idle-plan',
    config: { access: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'off-peak' }, builtinModelIds: ['GLM-5.3'], visibility: 'hidden' },
  },
  {
    providerId: 'new-provider-3',
    config: { access: { type: 'api-key' }, builtinModelIds: ['qwen3.8-flash'] },
  },
]

test('pickAccountProviders registers every visible plan, Start Plan first', () => {
  const picked = pickAccountProviders(rules, [])
  assert.deepEqual(picked.map((rule) => rule.providerId), [
    'account:zai-start-plan',
    'account:bigmodel-start-plan',
    'account:bigmodel-individual-coding-plan',
    'account:bigmodel-team-coding-plan',
  ])
})

test('pickAccountProviders skips hidden plan rules (off-peak, highspeed cards)', () => {
  const picked = pickAccountProviders(rules, [])
  assert.equal(picked.some((rule) => rule.providerId.includes('offpeak')), false)
})

test('pickAccountProviders narrows to the signed-in account family', () => {
  const picked = pickAccountProviders(rules, [], 'bigmodel')
  assert.deepEqual(picked.map((rule) => rule.providerId), [
    'account:bigmodel-start-plan',
    'account:bigmodel-individual-coding-plan',
    'account:bigmodel-team-coding-plan',
  ])
})

test('an unknown family falls back to every plan rather than none', () => {
  const picked = pickAccountProviders(rules, [], 'something-else')
  assert.equal(picked.length, 4)
})

test('a linked coding-plan credential only breaks ties inside the same rank', () => {
  // Two individual coding plans: the credential-linked one wins the tie.
  const twoIndividuals = [
    { providerId: 'account:zai-individual-coding-plan', config: { access: { type: 'zhipu-account', accountType: 'zai', mode: 'individual-coding-plan' } } },
    { providerId: 'account:bigmodel-individual-coding-plan', config: { access: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'individual-coding-plan' } } },
  ]
  const tied = pickAccountProviders(twoIndividuals, [
    'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key',
  ])
  assert.deepEqual(tied.map((rule) => rule.providerId), [
    'account:bigmodel-individual-coding-plan',
    'account:zai-individual-coding-plan',
  ])

  // Rank dominates: a credential-linked team plan still sorts behind every start plan.
  const linked = pickAccountProviders(rules, [
    'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:123:api-key',
  ], 'bigmodel')
  assert.equal(linked[0].providerId, 'account:bigmodel-start-plan')
  assert.deepEqual(
    linked.filter((rule) => rule.providerId.includes('coding-plan')).map((rule) => rule.providerId),
    ['account:bigmodel-individual-coding-plan', 'account:bigmodel-team-coding-plan'],
  )
})

test('activeAccountFamily reads oauth:active_provider', () => {
  assert.equal(activeAccountFamily({ 'oauth:active_provider': 'bigmodel' }), 'bigmodel')
  assert.equal(activeAccountFamily({}), '')
  assert.equal(activeAccountFamily(undefined), '')
})

test('the snapshot carries every picked plan in one revision', () => {
  const picked = pickAccountProviders(rules, [], 'bigmodel')
  const snapshot = buildAccountConfigSnapshot({
    rule: picked,
    builtinPath: 'C:/fake/zcode-builtin.json',
    builtinReleaseRevision: 33,
    revisionSuffix: 'test',
  })
  assert.ok(snapshot !== undefined)
  assert.deepEqual(snapshot.providerIds, [
    'account:bigmodel-start-plan',
    'account:bigmodel-individual-coding-plan',
    'account:bigmodel-team-coding-plan',
  ])
  assert.deepEqual(Object.keys(snapshot.providers).sort(), snapshot.providerIds.slice().sort())
  // Every plan is marked entitled so the CLI actually registers it.
  for (const id of snapshot.providerIds) {
    assert.equal(snapshot.providers[id].access.entitled, true)
    assert.equal(snapshot.states[id].entitled, true)
    assert.equal(snapshot.states[id].availability, 'available')
  }
  // Start Plan's own model list travels with it.
  assert.deepEqual(snapshot.providers['account:bigmodel-start-plan'].builtinModelIds, ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo'])
})

test('a single rule still builds a valid snapshot (backwards compatible)', () => {
  const snapshot = buildAccountConfigSnapshot({
    rule: rules[1],
    builtinPath: 'C:/fake/zcode-builtin.json',
    builtinReleaseRevision: 33,
    revisionSuffix: 'one',
  })
  assert.deepEqual(snapshot?.providerIds, ['account:bigmodel-start-plan'])
})

const entry = (providerId, modelId) => ({
  providerId,
  modelId,
  label: modelId,
  providerLabel: providerId,
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  reasoningLevels: ['max'],
  defaultReasoningLevel: 'max',
  supportsImage: true,
})

test('collapseCatalog prefers the Start Plan over a coding plan for the same model id', () => {
  const collapsed = collapseCatalog([
    entry('account:bigmodel-individual-coding-plan', 'GLM-5.3-Flash'),
    entry('account:bigmodel-start-plan', 'GLM-5.3-Flash'),
  ])
  assert.equal(collapsed.length, 1)
  assert.equal(collapsed[0].providerId, 'account:bigmodel-start-plan')
})

test('collapseCatalog still prefers any account route over a personal provider', () => {
  const collapsed = collapseCatalog([
    entry('new-provider-3', 'GLM-5.3'),
    entry('account:bigmodel-team-coding-plan', 'GLM-5.3'),
  ])
  assert.equal(collapsed[0].providerId, 'account:bigmodel-team-coding-plan')
})

test('collapseCatalog keeps personal providers for ids no plan serves', () => {
  const collapsed = collapseCatalog([
    entry('account:bigmodel-start-plan', 'GLM-5.3-Flash'),
    entry('new-provider-3', 'qwen3.8-flash'),
  ])
  assert.deepEqual(collapsed.map((item) => item.modelId).sort(), ['GLM-5.3-Flash', 'qwen3.8-flash'])
})
