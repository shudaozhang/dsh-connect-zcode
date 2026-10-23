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
 * @param {Record<string, any>} [documents] - explicit config document per namespace; a
 *   namespace without one gets a small default document. The document object is held by
 *   reference on purpose: a write mutates it, which is how the fake mirrors the Host
 *   answering with the new value.
 * @returns {any} the service.
 */
function fakeConfigForms(served, documents = {}) {
  /** @type {Map<string, any>} */
  const forms = new Map()
  const listeners = new Set()
  const snapshot = {
    status: 'ready',
    view: {
      writable: true,
      namespaces: served.map((ns) => ({
        ns,
        revision: 1,
        value: documents[ns] ?? { enabledModelIds: ['GLM-5.3'], disabledModelIds: [] },
      })),
    },
  }

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
      /**
       * Apply ops to the live document and republish, like the real controller's
       * `mirror.acceptView(response.value)` does after the Host accepts a write.
       *
       * @param {any[]} ops - ordered settings operations.
       * @returns {Promise<boolean>} whether the Host accepted them.
       */
      mutate: async (ops) => {
        const view = snapshot.view.namespaces.find((candidate) => candidate.ns === entryId)
        if (view === undefined) return false
        for (const op of ops) {
          if (op.op === 'set') view.value[op.path[0]] = structuredClone(op.value)
        }
        view.revision += 1
        derive()
        for (const listener of [...listeners]) listener()
        return true
      },
      set: async (field, next) => {
        const view = snapshot.view.namespaces.find((candidate) => candidate.ns === entryId)
        if (view === undefined) return false
        view.value[field] = structuredClone(next)
        view.revision += 1
        derive()
        for (const listener of [...listeners]) listener()
        return true
      },
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

// ── switch semantics ─────────────────────────────────────────────────────────
//
// The card must read switch state from THIS PLUGIN'S CONFIG, not from catalogue
// membership. The Host filters the advertised catalogue through `selectEnabledModels`, so
// a switched-off model simply disappears from it: deriving `on` from "is it in the
// catalogue?" made the switch flip back as soon as the (filtered) refresh landed, and made
// a deliberately disabled model look like one that went missing.

/**
 * A model catalogue that behaves like the Host's: filtered by the config it is given.
 *
 * @param {() => any} readValue - reads the current config document.
 * @param {ReadonlyArray<{ id: string, name: string }>} all - every model upstream reports.
 * @param {any} [staleBy] - when set, the catalogue keeps answering with the document as it
 *   was when this snapshot was taken, which is what a read already in flight (or one
 *   answered before the write committed) looks like.
 * @returns {any} the `remote.session` surface the directory talks to.
 */
function filteredCatalogueRemote(readValue, all, staleBy) {
  const visible = () => {
    const value = (staleBy ?? readValue()) ?? {}
    const disabled = Array.isArray(value.disabledModelIds) ? value.disabledModelIds : []
    const allow = Array.isArray(value.enabledModelIds) ? value.enabledModelIds : []
    return all.filter((model) => {
      if (disabled.includes(model.id)) return false
      if (allow.length === 0) return true
      return allow.includes(model.id)
    })
  }
  return {
    session: {
      modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'zcode-cli', models: visible() }] } }),
    },
  }
}

/**
 * Build a context whose config document is a live, mutable object.
 *
 * @param {any} configForms - the fake settings service.
 * @param {any} remote - the `remote.session` surface.
 * @returns {any} `{ ctx, slots }`.
 */
function makeTogglingContext(configForms, remote) {
  /** @type {any[]} */
  const slots = []
  const ctx = {
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get: (name) => {
      if (name === 'configForms') return configForms
      if (name === 'remote.session') return remote.session
      if (name === 'remote') return remote
      return undefined
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, register) => {
        register()
        return () => {}
      },
      register: (options) => {
        slots.push({ options })
        return () => {}
      },
    },
  }
  return { ctx, slots }
}

/** Let the first catalogue read settle. @returns {Promise<void>} */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test('a switch reads off the config, so a filtered catalogue cannot flip it back', async () => {
  const document = { enabledModelIds: [], disabledModelIds: [] }
  const configForms = fakeConfigForms(['include:dsh-connect-zcode'], { 'include:dsh-connect-zcode': document })
  const all = [{ id: 'GLM-5.3', name: 'GLM-5.3' }, { id: 'GLM-5.2', name: 'GLM-5.2' }]
  const remote = filteredCatalogueRemote(() => document, all)
  const exports = loadBundle({ react: reactStub })
  const { ctx, slots } = makeTogglingContext(configForms, remote)
  exports.apply(ctx)
  const { directory } = slots[0].options.inject()
  await settle()

  assert.deepEqual(
    directory.getSnapshot().rows.map((row) => [row.id, row.on]),
    [['GLM-5.2', true], ['GLM-5.3', true]],
    'everything is on by default',
  )

  await directory.setModel('GLM-5.3', false)
  // A click only edits the draft: no write, no catalogue re-read, so the list cannot grey
  // out under the pointer. This is the reported "勾选后列表短暂变灰" symptom.
  assert.deepEqual(document.disabledModelIds, [], 'a switch must NOT write before Save')
  assert.equal(directory.getSnapshot().dirty, true, 'the panel must announce unsaved changes')
  const drafted = directory.getSnapshot().rows.find((row) => row.id === 'GLM-5.3')
  assert.equal(drafted.on, false, 'the draft must be what the switch draws')

  await directory.save()
  const afterOff = directory.getSnapshot().rows
  assert.deepEqual(document.disabledModelIds, ['GLM-5.3'], 'save lands it as a disabledModelIds entry')
  assert.equal(directory.getSnapshot().dirty, false, 'a successful save clears the draft')
  // GLM-5.3 leaves the (filtered) catalogue but must still render, switched OFF.
  const off = afterOff.find((row) => row.id === 'GLM-5.3')
  assert.ok(off !== undefined, 'a disabled model must stay listed so it can be re-enabled')
  assert.equal(off.on, false, 'the switch must read the config, not catalogue membership')
  assert.equal(off.reported, true, 'a deliberately disabled model is not "not reported"')

  await directory.setModel('GLM-5.3', true)
  assert.deepEqual(document.disabledModelIds, ['GLM-5.3'], 'still nothing written before Save')
  await directory.save()
  assert.deepEqual(document.disabledModelIds, [], 'save clears the disable entry')
  assert.equal(directory.getSnapshot().rows.find((row) => row.id === 'GLM-5.3').on, true)
})

test('Save is a single write and one catalogue re-read', async () => {
  // The pointed complaint was that each click re-read the filtered catalogue and blanked
  // the list. Exactly one write per Save is what removes that.
  const document = { enabledModelIds: [], disabledModelIds: [] }
  const configForms = fakeConfigForms(['include:dsh-connect-zcode'], { 'include:dsh-connect-zcode': document })
  const originalGet = configForms.get
  /** @type {string[]} */
  const namespacesWritten = []
  configForms.get = (id) => {
    const form = originalGet(id)
    const mutate = form.mutate
    form.mutate = async (ops) => {
      namespacesWritten.push(form.namespace)
      return await mutate(ops)
    }
    return form
  }
  let catalogReads = 0
  const all = [{ id: 'GLM-5.3', name: 'GLM-5.3' }, { id: 'GLM-5.2', name: 'GLM-5.2' }]
  const base = filteredCatalogueRemote(() => document, all)
  const remote = {
    session: {
      modelCatalog: async () => {
        catalogReads += 1
        return await base.session.modelCatalog()
      },
    },
  }
  const exports = loadBundle({ react: reactStub })
  const { ctx, slots } = makeTogglingContext(configForms, remote)
  exports.apply(ctx)
  const { directory } = slots[0].options.inject()
  await settle()

  const readsAfterMount = catalogReads
  // Three clicks in a row: zero writes, zero re-reads.
  await directory.setModel('GLM-5.3', false)
  await directory.setModel('GLM-5.2', false)
  await directory.setModel('GLM-5.3', true)
  assert.deepEqual(namespacesWritten, [], 'no write until Save')
  assert.equal(catalogReads, readsAfterMount, 'no catalogue re-read until Save')

  await directory.save()
  assert.deepEqual(namespacesWritten, ['include:dsh-connect-zcode'],
    'Open must name the namespace the Host serves, exactly once')
  assert.equal(catalogReads > readsAfterMount, true, 'save refreshes the catalogue once')
  assert.equal(directory.getSnapshot().writeError, null)
  // The reconciled document carries both edits.
  assert.deepEqual(document.disabledModelIds, ['GLM-5.2'])
})

test('Discard drops the draft without touching the Host', async () => {
  const document = { enabledModelIds: [], disabledModelIds: [] }
  const configForms = fakeConfigForms(['include:dsh-connect-zcode'], { 'include:dsh-connect-zcode': document })
  const all = [{ id: 'GLM-5.3', name: 'GLM-5.3' }]
  const remote = filteredCatalogueRemote(() => document, all)
  const exports = loadBundle({ react: reactStub })
  const { ctx, slots } = makeTogglingContext(configForms, remote)
  exports.apply(ctx)
  const { directory } = slots[0].options.inject()
  await settle()

  await directory.setModel('GLM-5.3', false)
  assert.equal(directory.getSnapshot().dirty, true)
  directory.discard()
  assert.equal(directory.getSnapshot().dirty, false, 'discard clears the draft')
  assert.deepEqual(document.disabledModelIds, [], 'discard writes nothing')
  assert.equal(directory.getSnapshot().rows.find((row) => row.id === 'GLM-5.3').on, true,
    'the row returns to the saved state')
})

test('a stale catalogue read cannot flip a switch back', async () => {
  // THE RACE. The Host re-reads the catalogue after a write, and that read is filtered by
  // the config as it stood when the read STARTED. Deriving `on` from catalogue membership
  // therefore showed the pre-write state for one refresh -- the switch appeared to bounce
  // back. `on` must come from the config document.
  const document = { enabledModelIds: [], disabledModelIds: [] }
  // Freeze the catalogue at the all-enabled state: every read answers as if nothing was
  // ever disabled, which is the worst case for a catalogue-derived `on`.
  const frozen = { enabledModelIds: [], disabledModelIds: [] }
  const configForms = fakeConfigForms(['include:dsh-connect-zcode'], { 'include:dsh-connect-zcode': document })
  const all = [{ id: 'GLM-5.3', name: 'GLM-5.3' }]
  const remote = filteredCatalogueRemote(() => document, all, frozen)
  const exports = loadBundle({ react: reactStub })
  const { ctx, slots } = makeTogglingContext(configForms, remote)
  exports.apply(ctx)
  const { directory } = slots[0].options.inject()
  await settle()

  await directory.setModel('GLM-5.3', false)
  await directory.save()

  // The write landed...
  assert.deepEqual(document.disabledModelIds, ['GLM-5.3'], 'off must persist')
  // ...and the switch must reflect it even though the catalogue still advertises the model.
  const row = directory.getSnapshot().rows.find((candidate) => candidate.id === 'GLM-5.3')
  assert.equal(row.on, false, 'a stale catalogue must not resurrect a disabled model')
})
