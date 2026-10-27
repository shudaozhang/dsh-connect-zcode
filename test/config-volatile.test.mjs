// The settings-form gate: why a plugin's Config fields must be marked volatile.
//
// THE DEFECT THIS LOCKS DOWN. The card showed
//
//   插件配置当前不可用——请确认 dsh-connect-zcode 已在插件列表中启用。
//   保存失败，配置已回滚到宿主状态。
//
// for every interaction. Two client-side fixes (namespace spelling, switch semantics) were
// necessary but could never be sufficient, because the form the card binds did not exist:
// the DSH settings service only serves a plugin whose Config exposes at least one VOLATILE
// field. Its `describe()` is, verbatim from dsh-settings:
//
//   const form = volatileForm(schema);
//   if (form === void 0) return [];        // ← the entry is skipped entirely
//   active.add(entry.id);                  // ← so its namespace is never served
//
// `volatileForm()` keeps only `meta.volatile` fields and returns undefined when there are
// none — so `enabledModelIds` / `disabledModelIds` being ordinary arrays meant
// `include:dsh-connect-zcode` was absent from the describe mirror. No spelling the client
// could try would ever match. The write gate agrees (`isVolatilePath`).
//
// These tests therefore assert the SCHEMA MARKER and the two consequences of it: the
// describe projection now yields a form, and a volatile field still resolves to the right
// plain value after unwrapping. They are what a future refactor of the Config would break.
import assert from 'node:assert/strict'
import test from 'node:test'

import { asVolatile, Config, resolveOptions, unwrapVolatile, unwrapVolatileDeep } from '../lib/index.js'

/**
 * A faithful copy of `volatileForm()` from dsh-settings' host half.
 *
 * The real one is not importable from a plugin (it lives in the Host's own bundle), so it
 * is reproduced here — deliberately as the same shape, because the point of the test is
 * that OUR schema passes THIS projection.
 *
 * @param {any} schema A schemastery schema node.
 * @returns {any} The volatile-only object schema, or undefined when nothing is volatile.
 */
function volatileForm(schema) {
  if (schema.meta?.volatile === true) return schema
  if (schema.type === 'object') {
    /** @type {Record<string, any>} */
    const dict = {}
    for (const [key, child] of Object.entries(schema.dict ?? {})) {
      const form = volatileForm(child)
      if (form !== undefined) dict[key] = form
    }
    return Object.keys(dict).length === 0 ? undefined : { type: 'object', dict }
  }
  return undefined
}

test('the model-selection fields are volatile (the settings form gate)', () => {
  // Without this, `settings.describe()` skips the entry and the card can never bind.
  assert.equal(Config.dict.enabledModelIds.meta?.volatile, true,
    'enabledModelIds must be volatile or the namespace is never served')
  assert.equal(Config.dict.disabledModelIds.meta?.volatile, true,
    'disabledModelIds must be volatile or the namespace is never served')
})

test('describe() would now project a form for this entry', () => {
  const form = volatileForm(Config)
  assert.notEqual(form, undefined,
    'volatileForm(Config) must not be undefined, or describe() removes the namespace')
  assert.deepEqual(Object.keys(form.dict).sort(), [
    'disabledModelIds',
    'enabledModelIds',
    'planDisabledModelIds',
    'planEnabledModelIds',
    'planPinnedRoutes',
  ])
})

test('the control: the same fields WITHOUT the marker project to nothing', async () => {
  // Proves the marker — not the field names, not the client — is what the gate reads.
  const { default: z } = await import('@deepseek-ai/schemastery')
  const plain = z.object({
    enabledModelIds: z.array(z.string()).default([]),
    disabledModelIds: z.array(z.string()).default([]),
  })
  assert.equal(volatileForm(plain), undefined,
    'an unmarked Config must be skipped by describe(), which is the reported defect')
})

test('asVolatile degrades to an identity no-op on a schema without volatile()', () => {
  // Older schemastery pinning: the schema must stay byte-identical to the unmarked input,
  // because hand-setting meta.volatile would bypass validateVolatileSchema.
  /** @type {any} */
  const plain = { type: 'array', meta: {} }
  assert.equal(asVolatile(plain), plain, 'must return the input unchanged')
  assert.equal(plain.meta.volatile, undefined, 'must not hand-write the marker')
})

test('a volatile field resolves to a live reference, and unwrapVolatile reads through it', () => {
  const resolved = Config({ enabledModelIds: ['GLM-5.3', 'GLM-5.2'], disabledModelIds: ['x'] })
  // schemastery wraps a marked field in `{ get(): T }`; Array.isArray on it is false.
  assert.equal(Array.isArray(resolved.enabledModelIds), false,
    'the resolved value is a reference, not an array')
  assert.equal(typeof resolved.enabledModelIds.get, 'function')
  assert.deepEqual(unwrapVolatile(resolved.enabledModelIds), ['GLM-5.3', 'GLM-5.2'])
  assert.deepEqual(unwrapVolatile(resolved.disabledModelIds), ['x'])
  // Ordinary fields are untouched.
  assert.equal(unwrapVolatile(resolved.enabled), true)
})

test('resolveOptions unwraps, so the model selection survives the reference', () => {
  const options = resolveOptions(Config({ enabledModelIds: ['GLM-5.3'], disabledModelIds: ['GLM-5.2'] }))
  assert.deepEqual(options.enabledModelIds, ['GLM-5.3'])
  assert.deepEqual(options.disabledModelIds, ['GLM-5.2'])
  // Defaults must still be plain empty arrays.
  const defaults = resolveOptions(Config({}))
  assert.deepEqual(defaults.enabledModelIds, [])
  assert.deepEqual(defaults.disabledModelIds, [])
})

test('planRouteMode defaults to merged (one model per entry, auto-failover) and accepts explicit', () => {
  // The default is the user-visible promise: the picker shows each model once. Getting this
  // wrong silently brings back the 22-entry route-per-model list.
  assert.equal(resolveOptions(Config({})).planRouteMode, 'merged')
  assert.equal(resolveOptions(Config({ planRouteMode: 'merged' })).planRouteMode, 'merged')
  assert.equal(resolveOptions(Config({ planRouteMode: 'explicit' })).planRouteMode, 'explicit')
  // A bad value is rejected by the schema itself, before resolveOptions runs — that is the
  // stronger guarantee, so pin it rather than the (still present) coercion fallback.
  assert.throws(() => Config({ planRouteMode: /** @type {any} */ ('nonsense') }), /planRouteMode/u)
  // A config object that bypassed the schema still resolves to a usable mode.
  assert.equal(resolveOptions(/** @type {any} */ ({ planRouteMode: 'nonsense' })).planRouteMode, 'merged')
  assert.equal(Config.dict.planRouteMode.meta?.volatile, undefined,
    'the mode is a structural setting, not a per-session form toggle')
})

test('a volatile update is visible through the SAME config object', async () => {
  // This is why `options()` cannot key its cache on object identity alone: the Loader
  // commits a volatile edit in place (`updateVolatile`), leaving the config object
  // identical, so `raw === lastRaw` alone would serve the pre-edit selection forever.
  const cosmokit = await import('@deepseek-ai/cosmokit')
  const before = Config({ enabledModelIds: [], disabledModelIds: [] })
  assert.deepEqual(resolveOptions(before).disabledModelIds, [])

  const written = Config({ enabledModelIds: [], disabledModelIds: ['GLM-5.3'] })
  cosmokit.updateVolatile(before.disabledModelIds, written.disabledModelIds)

  assert.deepEqual(resolveOptions(before).disabledModelIds, ['GLM-5.3'],
    'the same config object must observe the new value')
})

test('planPinnedRoutes resolves to a plain list and defaults to empty (no pin)', () => {
  // The pin list must survive the volatile reference exactly like the other model lists,
  // and an absent value must mean "nothing pinned" — not "pin everything to nothing".
  assert.deepEqual(resolveOptions(Config({})).planPinnedRoutes, [])
  assert.deepEqual(
    resolveOptions(Config({ planPinnedRoutes: ['account:zai-start-plan#GLM-5.3-Flash'] })).planPinnedRoutes,
    ['account:zai-start-plan#GLM-5.3-Flash'],
  )
  assert.equal(Config.dict.planPinnedRoutes.meta?.volatile, true,
    'the pin list is edited from the same settings form as the other model lists')
})

test('unwrapVolatileDeep peels references at any depth', () => {
  const resolved = Config({ enabledModelIds: ['a'], disabledModelIds: ['b'] })
  const deep = unwrapVolatileDeep({
    model: resolved.enabledModelIds,
    nested: { list: [resolved.disabledModelIds, 'plain'] },
    count: 1,
  })
  assert.deepEqual(deep, { model: ['a'], nested: { list: [['b'], 'plain'] }, count: 1 })
})
