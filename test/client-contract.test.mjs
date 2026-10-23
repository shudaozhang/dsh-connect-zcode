// Contract checks for the browser half (`lib/client.js`).
//
// The panel is React rendered inside the Host's browser sandbox, so it is verified live in
// the GUI. What *can* be checked offline is the contract it depends on -- the bundle format
// the loader requires, the slots it registers into, and the settings binding that the
// "配置不可用" defect broke. These assertions are deliberately static (read the source)
// rather than a simulated React tree: a mock heavy enough to render the component would
// test the mock, not the Host.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('the bundle parses as a classic script (the loader concatenates and executes it)', () => {
  assert.doesNotThrow(() => new Function(source), 'must parse without module syntax')
  assert.equal(/^\s*(import|export)\s/m.test(source), false, 'must not use import/export statements')
})

test('the bundle registers itself through __ModuleLoader__.load', () => {
  assert.match(source, /__ModuleLoader__\.load\(\{/u)
  assert.match(source, /id:\s*"dsh-connect-zcode"/u)
  assert.match(source, /factory:\s*function\s*\(require\)/u)
})

test('exports the plugin body the loader expects', () => {
  assert.match(source, /exports\.apply\s*=/u)
  assert.match(source, /exports\.inject\s*=/u)
  assert.match(source, /exports\.name\s*=/u)
  assert.match(source, /const inject = \["slots", "locale"\]/u)
})

test('the model card lives on the Plugins page, not in the left rail', () => {
  for (const slot of ['plugins.bundle.config', 'plugins.row.config']) {
    assert.match(source, new RegExp(`["']${slot.replace('.', '\\.')}["']`, 'u'), `${slot} must be registered`)
  }
  // The sidebar/main standalone entry was the previous (rejected) shape.
  assert.equal(source.includes('"sidebar.panellist"'), false, 'no sidebar entry')
  assert.equal(source.includes('name: "main"'), false, 'no standalone main panel')
})

test('the card is keyed by package name and by <pkg>#<rowId>', () => {
  assert.match(source, /const PACKAGE_NAME = "dsh-connect-zcode"/u)
  assert.match(source, /`\$\{PACKAGE_NAME\}#\$\{PACKAGE_NAME\}`/u)
})

test('settings binding asks the Host instead of guessing a namespace', () => {
  // THE DEFECT: `configForms.get(entryId)` lazily CONSTRUCTS a controller for ANY id
  // (`ConfigForms.get`: `new ConfigFormController(this.owner, { namespace: entryId }, …)`),
  // so a `get()`-returns-something check can never fail. The old code walked the candidate
  // list, took the first truthy result, and bound the BARE package name. The live host
  // serves this plugin as `include:dsh-connect-zcode`, and `ConfigFormController.derive()`
  // matches with EXACT equality, so that form was `unavailable` for its whole lifetime:
  // the red "插件配置当前不可用" banner plus every write rejected by the Host.
  assert.match(source, /forms\.describe\(\)/u, 'must read the served-namespace directory')
  assert.match(source, /servedNamespaces/u, 'must consult the served set')
  assert.match(source, /resolveServedNamespace/u, 'must resolve a name from the served set')
  assert.match(source, /whileServed\(/u, 'must still follow later arrivals')
  // It must NOT treat a bare forms.get() as proof that a namespace is served.
  const bindBlock = source.slice(source.indexOf('const bindNow'), source.indexOf('const bindNow') + 1400)
  assert.doesNotMatch(
    bindBlock,
    /for \(const namespace of SETTINGS_NS_CANDIDATES\)[\s\S]{0,200}?forms\.get\(namespace\)/u,
    'must not probe candidate spellings with forms.get()',
  )
})

test('an unserved binding self-heals to a served one instead of staying red', () => {
  assert.match(source, /config\.status === "unavailable"/u)
  assert.match(source, /target !== boundNamespace/u, 'must move the binding when the served set disagrees')
})

test('editing is gated on being bound, not on the scope writable flag', () => {
  // `writable` stays false until the mirror settles, so gating on it disabled every
  // switch on a healthy install.
  assert.match(source, /const controlsDisabled = busy \|\| snapshot\.bound !== true/u)
})

test('a missing/served-later config is a pending state, not an error banner', () => {
  // `config === undefined` used to fall into the same branch as a load failure... it still
  // renders as "loading"; what must NOT happen is treating it as "unavailable".
  const start = source.indexOf('let status = "ready"')
  const publishBlock = source.slice(start, start + 900)
  assert.match(publishBlock, /config === undefined/u, "undefined config must be handled explicitly")
  // It must land on "loading" (pending), never straight on the "unavailable" banner.
  const undefinedBranch = publishBlock.slice(
    publishBlock.indexOf("config === undefined"),
    publishBlock.indexOf("config === undefined") + 400,
  )
  assert.doesNotMatch(undefinedBranch, /status = "unavailable"/u)
})

test('every switch writes this plugin\'s own config through ConfigForm.mutate', () => {
  assert.match(source, /configForms/u)
  assert.match(source, /controller\.mutate\(/u)
  assert.match(source, /op: "set"/u)
  assert.match(source, /path: \["disabledModelIds"\]/u)
  assert.match(source, /path: \["enabledModelIds"\]/u)
})

test('the panel degrades instead of throwing when the Host API is missing', () => {
  assert.match(source, /try\s*\{[\s\S]*?\}\s*catch\s*\(/u)
  assert.match(source, /host provider unaffected/u)
})
