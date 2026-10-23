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

test('settings binding waits for the namespace instead of giving up at mount', () => {
  // The defect: a single `forms.get(ns)` at mount left the card permanently read-only,
  // because the settings mirror answers after the Plugins page mounts.
  assert.match(source, /whileServed\(/u, 'must use configForms.whileServed')
  assert.match(source, /SETTINGS_NS_CANDIDATES/u, 'must try the known namespace spellings')
  // Both prefixed and bare spellings have to be watched.
  assert.match(source, /`include:\$\{SETTINGS_NS\}`/u)
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
