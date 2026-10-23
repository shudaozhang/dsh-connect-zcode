// Regression test for the settings-namespace binding in `lib/client.js`.
//
// WHY THIS EXISTS. The shipped card bound the BARE package name and every write was
// rejected. The cause was subtle enough to survive a static source check, so this test
// reproduces the exact Host semantics it depends on:
//
//   * `ConfigForms.get(entryId)` LAZILY CONSTRUCTS a controller for ANY id —
//     `new ConfigFormController(this.owner, { namespace: entryId }, …)` — so it never
//     returns undefined, and a "did get() give me something?" probe always succeeds.
//   * `ConfigFormController.derive()` matches the describe mirror's namespaces by EXACT
//     equality, so a controller bound to a spelling the Host does not serve reports
//     `status: "unavailable"` for its entire lifetime.
//
// The live Desktop host serves this plugin as `include:dsh-connect-zcode` (see
// `plugin_manager list_plugins` / the `Config` inspect provider: entryId
// `include:dsh-connect-zcode`, patchId `dsh-connect-zcode`). The card must therefore bind
// the SERVED spelling, not the first one it can construct.
//
// The bundle is a classic script, so the test loads it the way the loader does: a fake
// `__ModuleLoader__.load` captures the factory and a fake `require` answers the platform
// module table it asks for. Only the sync-surface of React is needed because `apply()`
// registers slots; it never renders.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** A React stand-in: `apply()` only builds elements, it does not render them. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/**
 * Load the bundle and return its exports the way `window.__ModuleLoader__` would.
 *
 * @param {Record<string, any>} modules - id → module for the bundle's `require`.
 * @returns {any} the captured module exports (`apply`, `inject`, `name`).
 */
function loadBundle(modules) {
  /** @type {any} */
  let captured
  const g = /** @type {any} */ (globalThis)
  const previous = g.__ModuleLoader__
  g.__ModuleLoader__ = {
    load: (definition) => {
      captured = definition
    },
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(source)()
  } finally {
    g.__ModuleLoader__ = previous
  }
  assert.ok(captured !== undefined, 'the bundle must call __ModuleLoader__.load')
  return captured.factory((id) => {
    if (Object.hasOwn(modules, id)) return modules[id]
    throw new Error(`unexpected require("${id}")`)
  })
}

/**
 * A `configForms` service that copies the two measured Host behaviours exactly.
 *
 * @param {string[]} served - namespaces the describe mirror answers with.
 * @returns {any} the service.
 */
function fakeConfigForms(served) {
  /** @type {Map<string, any>} */
  const forms = new Map()
  const listeners = new Set()
  let snapshot = { status: 'ready', view: { writable: true, namespaces: served.map((ns) => ({ ns, revision: 1, value: { enabledModelIds: ['GLM-5.3'], disabledModelIds: [] } })) } }

  const makeForm = (entryId) => {
    const storeListeners = new Set()
    /** @type {any} */
    let state = { status: 'loading', value: undefined, revision: undefined, writable: false }
    const derive = () => {
      const view = snapshot.view.namespaces.find((candidate) => candidate.ns === entryId)
      if (view === undefined) {
        // EXACT-equality miss → permanently unavailable. This is the whole defect.
        state = { status: 'unavailable', value: undefined, revision: undefined, writable: snapshot.view.writable }
      } else {
        state = { status: 'ready', value: view.value, revision: view.revision, writable: snapshot.view.writable }
      }
      for (const listener of [...storeListeners]) listener()
    }
    derive()
    return {
      getSnapshot: () => state,
      subscribe: (listener) => {
        storeListeners.add(listener)
        return () => storeListeners.delete(listener)
      },
      mutate: async () => true,
      set: async () => true,
      namespace: entryId,
    }
  }

  return {
    /** Lazy construction for ANY id — never undefined. */
    get: (entryId) => {
      const existing = forms.get(entryId)
      if (existing !== undefined) return existing
      const form = makeForm(entryId)
      forms.set(entryId, form)
      return form
    },
    describe: () => ({
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }),
    whileServed: (namespaces, register) => {
      const check = () => {
        const list = new Set(snapshot.view.namespaces.map((row) => row.ns))
        if (namespaces.some((ns) => list.has(ns))) register(list)
      }
      check()
      return () => {}
    },
  }
}

/**
 * Build the client context the bundle's `apply` expects.
 *
 * @param {any} configForms - the fake settings service.
 * @returns {any} `{ ctx, slots }` where `slots` records registrations.
 */
function makeContext(configForms) {
  /** @type {any[]} */
  const slots = []
  const ctx = {
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get: (name) => (name === 'configForms' ? configForms : undefined),
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (name, register) => {
        register()
        return () => {}
      },
      register: (options, Component) => {
        slots.push({ options, Component })
        return () => {}
      },
    },
  }
  return { ctx, slots }
}

test('binds the namespace the Host actually serves, not the first it can construct', () => {
  // The live host's real id. Only the `include:` spelling is served.
  const configForms = fakeConfigForms(['include:dsh-connect-zcode'])
  const exports = loadBundle({ react: reactStub })
  const { ctx, slots } = makeContext(configForms)

  exports.apply(ctx)
  assert.ok(slots.length > 0, 'the card must be registered')

  const { directory } = slots[0].options.inject()
  const snapshot = directory.getSnapshot()
  assert.equal(snapshot.boundNamespace, 'include:dsh-connect-zcode',
    'must bind the served spelling, not the bare package name')
  assert.equal(snapshot.bound, true)
  assert.notEqual(snapshot.status, 'unavailable', 'must not report the config as unavailable')
})

test('a bare-name binding self-heals once the mirror names the served spelling', () => {
  const configForms = fakeConfigForms(['include:dsh-connect-zcode'])
  const exports = loadBundle({ react: reactStub })
  const { ctx, slots } = makeContext(configForms)
  exports.apply(ctx)
  const { directory } = slots[0].options.inject()

  const snapshot = directory.getSnapshot()
  assert.equal(snapshot.bound, true)
  assert.equal(snapshot.boundNamespace, 'include:dsh-connect-zcode')
})

test('a namespace the Host really does serve under the bare name is used as-is', () => {
  const configForms = fakeConfigForms(['dsh-connect-zcode'])
  const exports = loadBundle({ react: reactStub })
  const { ctx, slots } = makeContext(configForms)
  exports.apply(ctx)
  const { directory } = slots[0].options.inject()
  const snapshot = directory.getSnapshot()
  assert.equal(snapshot.boundNamespace, 'dsh-connect-zcode')
  assert.notEqual(snapshot.status, 'unavailable')
})

test('a host that never serves this plugin reports unavailable with the served list', () => {
  // Nothing zcode-shaped: the card must stay honest rather than fabricate a form.
  const configForms = fakeConfigForms(['llm-pi-ai', 'llm-deepseek'])
  const exports = loadBundle({ react: reactStub })
  const { ctx, slots } = makeContext(configForms)
  exports.apply(ctx)
  const { directory } = slots[0].options.inject()
  const snapshot = directory.getSnapshot()
  assert.equal(snapshot.bound, false, 'must not claim a binding it does not have')
  assert.deepEqual(snapshot.served, ['llm-pi-ai', 'llm-deepseek'], 'must expose the served list for the banner')
})
