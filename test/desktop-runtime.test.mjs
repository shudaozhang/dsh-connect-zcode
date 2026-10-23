/**
 * Unit tests for ZCode desktop-client discovery and data-root resolution.
 *
 * Everything here is offline and hermetic: the registry is exercised through the exported
 * parser and through the injectable query seam (so no `reg` process is ever spawned), and
 * fixtures are written to a temp directory beside this checkout -- this repo lives on D:,
 * so the tests never write to the system drive or touch a real ZCode installation.
 *
 * Run: node --test test/desktop-runtime.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  desktopCandidatesFromRegistryQuery,
  desktopCliEnv,
  inspectDesktopRoot,
  locateZcodeCli,
  locateZcodeDesktop,
  parseUninstallRegistryOutput,
  resolveDesktopBuiltinConfig,
  resolveZcodeDataRoot,
} from '../lib/zcode-runtime.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Fixtures live beside the checkout, never on the system drive. */
const TMP_ROOT = fs.mkdtempSync(path.join(path.dirname(REPO_ROOT), '.zcode-runtime-test-'))

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

/**
 * @param {string} name Directory name under the temp root.
 * @returns {string} The created directory.
 */
function fixtureDir(name) {
  const dir = path.join(TMP_ROOT, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * @param {string} filePath File to create.
 * @param {string} [content] File content.
 * @returns {void}
 */
function writeFixture(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

/**
 * Create a fake desktop install root with the two files discovery requires.
 *
 * @param {string} name Directory name under the temp root.
 * @returns {string} The install root.
 */
function makeDesktopFixture(name) {
  const root = fixtureDir(name)
  writeFixture(path.join(root, 'ZCode.exe'))
  writeFixture(path.join(root, 'resources', 'glm', 'zcode.cjs'))
  writeFixture(path.join(root, 'resources', 'config', 'provider', 'zcode-builtin.json'), '{"revision":33}')
  return root
}

/**
 * Create a fake data root (with downloaded provider releases) and its resolved object.
 *
 * @param {string} name Directory name under the temp root.
 * @param {readonly string[]} versions Version directories to create.
 * @returns {{ dataBaseDir: string, dataRoot: import('../lib/zcode-runtime.js').ZcodeDataRoot }}
 */
function makeDataRootFixture(name, versions) {
  const dataBaseDir = fixtureDir(name)
  const dataRoot = path.join(dataBaseDir, '.zcode', 'v2')
  fs.mkdirSync(dataRoot, { recursive: true })
  for (const version of versions) {
    writeFixture(
      path.join(dataRoot, 'runtime', 'provider', PLATFORM_DIR, version, 'endpoint-78d7c3bef4024722642626fe3669a799', 'zcode-builtin.json'),
      '{"revision":33}',
    )
  }
  return {
    dataBaseDir,
    dataRoot: {
      dataBaseDir,
      dataRoot,
      settingPath: path.join(dataRoot, 'setting.json'),
      source: 'configured',
    },
  }
}

/** Mirror of the platform directory the desktop uses under `runtime/provider`. */
const PLATFORM_DIR = process.platform === 'win32'
  ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
  : `${process.platform}-${process.arch}`

/**
 * Point the standard install-directory env vars at empty temp dirs for one assertion, so
 * auto-detection cannot find a real ZCode install that happens to exist on this machine.
 *
 * @template T
 * @param {() => T} run Assertion to run.
 * @returns {T} The assertion's result.
 */
function withEmptyStandardInstallDirs(run) {
  const keys = ['LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)']
  /** @type {Record<string, string | undefined>} */
  const saved = {}
  for (const key of keys) saved[key] = process.env[key]
  const empty = fixtureDir('no-standard-install')
  process.env.LOCALAPPDATA = path.join(empty, 'local')
  process.env.ProgramFiles = path.join(empty, 'program-files')
  process.env['ProgramFiles(x86)'] = path.join(empty, 'program-files-x86')
  try {
    return run()
  } finally {
    for (const key of keys) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** `reg query` output measured on this machine (DisplayName/UninstallString shape). */
const REG_OUTPUT = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\268ce9e6-a30b-5890-ad18-d4b3ebba5377',
  '    DisplayName    REG_SZ    ZCode 3.16.3',
  '    DisplayVersion    REG_SZ    3.16.3',
  '    UninstallString    REG_SZ    "E:\\zcode\\Uninstall ZCode.exe" /currentuser',
  '    InstallLocation    REG_SZ    ',
  '    DisplayIcon    REG_SZ    E:\\zcode\\uninstallerIcon.ico',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\other-app',
  '    DisplayName    REG_SZ    Other App',
  '    UninstallString    REG_SZ    "C:\\Other\\uninstall.exe"',
  '',
  'End of search: 2 match(es) found.',
].join('\r\n')

test('parseUninstallRegistryOutput reads the ZCode entry, ignoring other apps', () => {
  // The measured entry has an empty InstallLocation: UninstallString and DisplayIcon are
  // the only hints, and both must collapse to the same root.
  assert.deepEqual(parseUninstallRegistryOutput(REG_OUTPUT), [
    { root: 'E:\\zcode', version: '3.16.3', discoverySource: 'registry' },
  ])
})

test('parseUninstallRegistryOutput prefers InstallLocation and handles unquoted commands', () => {
  const output = [
    'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\zcode-machine',
    '    DisplayName    REG_SZ    ZCode',
    '    DisplayVersion    REG_SZ    3.15.3',
    '    InstallLocation    REG_SZ    C:\\Program Files\\ZCode',
    '    UninstallString    REG_SZ    C:\\Program Files\\ZCode\\Uninstall ZCode.exe /S',
  ].join('\r\n')
  const candidates = parseUninstallRegistryOutput(output)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].root, 'C:\\Program Files\\ZCode')
  assert.equal(candidates[0].version, '3.15.3')
})

test('parseUninstallRegistryOutput falls back to the DisplayName version', () => {
  const output = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\zcode-noversion',
    '    DisplayName    REG_SZ    ZCode 3.16.3',
    '    InstallLocation    REG_SZ    E:\\zcode',
  ].join('\r\n')
  assert.deepEqual(parseUninstallRegistryOutput(output), [
    { root: 'E:\\zcode', version: '3.16.3', discoverySource: 'registry' },
  ])
})

test('parseUninstallRegistryOutput returns nothing for empty, garbage or unrelated output', () => {
  assert.deepEqual(parseUninstallRegistryOutput(''), [])
  assert.deepEqual(parseUninstallRegistryOutput('End of search: 0 match(es) found.\r\n'), [])
  assert.deepEqual(parseUninstallRegistryOutput('    DisplayName    REG_SZ    ZCode 3.16.3\r\n'), [])
})

test('desktopCandidatesFromRegistryQuery parses the injected output without spawning', { skip: process.platform !== 'win32' }, () => {
  /** @type {Array<{ command: string, args: readonly string[] }>} */
  const calls = []
  const candidates = desktopCandidatesFromRegistryQuery((command, args) => {
    calls.push({ command, args })
    return REG_OUTPUT
  })
  // The registry is asked once per known uninstall key, and never with anything but `reg`.
  assert.ok(calls.length > 0)
  for (const call of calls) assert.equal(call.command, 'reg')
  assert.ok(calls[0].args.includes('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'))
  assert.deepEqual(candidates, [{ root: 'E:\\zcode', version: '3.16.3', discoverySource: 'registry' }])
})

test('desktopCandidatesFromRegistryQuery degrades to no candidates when the query fails', { skip: process.platform !== 'win32' }, () => {
  assert.deepEqual(desktopCandidatesFromRegistryQuery(() => {
    throw new Error('reg is unavailable')
  }), [])
})

test('inspectDesktopRoot describes a complete install', () => {
  const root = makeDesktopFixture('desktop-valid')
  assert.deepEqual(inspectDesktopRoot(root, 'runtime', '3.16.3'), {
    root,
    launcherPath: path.join(root, 'ZCode.exe'),
    cliPath: path.join(root, 'resources', 'glm', 'zcode.cjs'),
    version: '3.16.3',
    resourcesPath: path.join(root, 'resources'),
    builtinProviderConfigPath: path.join(root, 'resources', 'config', 'provider', 'zcode-builtin.json'),
    discoverySource: 'runtime',
  })
})

test('inspectDesktopRoot rejects missing and partial installs', () => {
  assert.equal(inspectDesktopRoot(fixtureDir('desktop-empty'), 'runtime'), undefined)
  assert.equal(inspectDesktopRoot('', 'runtime'), undefined)

  const launcherOnly = fixtureDir('desktop-launcher-only')
  writeFixture(path.join(launcherOnly, 'ZCode.exe'))
  assert.equal(inspectDesktopRoot(launcherOnly, 'runtime'), undefined)

  const noBundled = fixtureDir('desktop-no-bundled')
  writeFixture(path.join(noBundled, 'ZCode.exe'))
  writeFixture(path.join(noBundled, 'resources', 'glm', 'zcode.cjs'))
  const desktop = inspectDesktopRoot(noBundled, 'config', '')
  assert.equal(desktop?.builtinProviderConfigPath, undefined)
  // An unreported version must not become a bogus one.
  assert.equal(desktop?.version, 'unknown')
})

test('locateZcodeDesktop honours a configured root and never queries the registry', () => {
  const root = makeDesktopFixture('desktop-configured')
  let queried = false
  const desktop = locateZcodeDesktop(root, () => {
    queried = true
    return ''
  })
  assert.equal(desktop?.root, root)
  assert.equal(desktop?.discoverySource, 'config')
  assert.equal(queried, false)
})

test('locateZcodeDesktop finds a custom root through the registry', { skip: process.platform !== 'win32' }, () => {
  const root = makeDesktopFixture('desktop-registry-custom')
  const output = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\zcode-test',
    '    DisplayName    REG_SZ    ZCode 3.16.3',
    '    DisplayVersion    REG_SZ    3.16.3',
    `    UninstallString    REG_SZ    "${path.join(root, 'Uninstall ZCode.exe')}" /currentuser`,
  ].join('\r\n')
  const desktop = withEmptyStandardInstallDirs(() => locateZcodeDesktop('', () => output))
  assert.equal(desktop?.root, root)
  assert.equal(desktop?.version, '3.16.3')
  assert.equal(desktop?.discoverySource, 'registry')
})

test('locateZcodeDesktop returns undefined when nothing is installed', { skip: process.platform !== 'win32' }, () => {
  const desktop = withEmptyStandardInstallDirs(() => locateZcodeDesktop('', () => 'End of search: 0 match(es) found.\r\n'))
  assert.equal(desktop, undefined)
})

test('locateZcodeDesktop returns undefined for a configured root that does not exist', () => {
  assert.equal(
    locateZcodeDesktop(path.join(TMP_ROOT, 'missing-install'), () => {
      throw new Error('the registry must not be consulted for a configured root')
    }),
    undefined,
  )
})

test('resolveZcodeDataRoot reads dataBaseDir from the desktop setting file', () => {
  const home = fixtureDir('home-setting')
  const customBase = path.join(TMP_ROOT, 'custom-data')
  writeFixture(path.join(home, '.zcode', 'v2', 'setting.json'), JSON.stringify({ dataBaseDir: customBase }))
  assert.deepEqual(resolveZcodeDataRoot('', home), {
    dataBaseDir: customBase,
    dataRoot: path.join(customBase, '.zcode', 'v2'),
    settingPath: path.join(home, '.zcode', 'v2', 'setting.json'),
    source: 'setting',
  })
})

test('resolveZcodeDataRoot prefers a configured dataBaseDir over the setting file', () => {
  const home = fixtureDir('home-configured')
  writeFixture(path.join(home, '.zcode', 'v2', 'setting.json'), JSON.stringify({ dataBaseDir: path.join(TMP_ROOT, 'from-setting') }))
  const explicit = path.join(TMP_ROOT, 'explicit-data')
  const resolved = resolveZcodeDataRoot(explicit, home)
  assert.equal(resolved.source, 'configured')
  assert.equal(resolved.dataBaseDir, explicit)
  assert.equal(resolved.dataRoot, path.join(explicit, '.zcode', 'v2'))
})

test('resolveZcodeDataRoot falls back to the home directory', () => {
  const home = fixtureDir('home-plain')
  const resolved = resolveZcodeDataRoot('', home)
  assert.equal(resolved.source, 'home')
  assert.equal(resolved.dataBaseDir, home)
  assert.equal(resolved.dataRoot, path.join(home, '.zcode', 'v2'))
  assert.equal(resolved.settingPath, path.join(home, '.zcode', 'v2', 'setting.json'))
})

test('resolveZcodeDataRoot ignores a malformed or empty setting file', () => {
  const broken = fixtureDir('home-broken-setting')
  writeFixture(path.join(broken, '.zcode', 'v2', 'setting.json'), '{not json')
  assert.equal(resolveZcodeDataRoot('', broken).source, 'home')

  const empty = fixtureDir('home-empty-setting')
  writeFixture(path.join(empty, '.zcode', 'v2', 'setting.json'), JSON.stringify({ dataBaseDir: '' }))
  assert.equal(resolveZcodeDataRoot('', empty).source, 'home')
})

test('resolveZcodeDataRoot resolves a relative setting path against the home directory', () => {
  const home = fixtureDir('home-relative-setting')
  writeFixture(path.join(home, '.zcode', 'v2', 'setting.json'), JSON.stringify({ dataBaseDir: 'data-custom' }))
  const resolved = resolveZcodeDataRoot('', home)
  assert.equal(resolved.source, 'setting')
  assert.equal(resolved.dataBaseDir, path.join(home, 'data-custom'))
})

test('resolveDesktopBuiltinConfig prefers the release matching the desktop version', () => {
  const root = makeDesktopFixture('desktop-builtin-exact')
  const fixture = makeDataRootFixture('data-builtin-exact', ['3.14.5', '3.16.3'])
  const desktop = inspectDesktopRoot(root, 'config', '3.16.3')
  const builtin = resolveDesktopBuiltinConfig(desktop, fixture.dataRoot)
  assert.equal(builtin?.source, 'runtime')
  assert.equal(
    builtin?.path,
    path.join(fixture.dataRoot.dataRoot, 'runtime', 'provider', PLATFORM_DIR, '3.16.3', 'endpoint-78d7c3bef4024722642626fe3669a799', 'zcode-builtin.json'),
  )
})

test('resolveDesktopBuiltinConfig falls back to the newest downloaded release', () => {
  const root = makeDesktopFixture('desktop-builtin-newest')
  const fixture = makeDataRootFixture('data-builtin-newest', ['3.14.5', '3.16.3'])
  // A desktop version that has no downloaded release (e.g. a configured root whose
  // version is unknown) must use the newest release rather than nothing.
  const desktop = inspectDesktopRoot(root, 'config', '9.9.9')
  const builtin = resolveDesktopBuiltinConfig(desktop, fixture.dataRoot)
  assert.equal(builtin?.source, 'runtime')
  assert.equal(
    builtin?.path,
    path.join(fixture.dataRoot.dataRoot, 'runtime', 'provider', PLATFORM_DIR, '3.16.3', 'endpoint-78d7c3bef4024722642626fe3669a799', 'zcode-builtin.json'),
  )
})

test('resolveDesktopBuiltinConfig falls back to the bundled release', () => {
  const root = makeDesktopFixture('desktop-builtin-bundled')
  const desktop = inspectDesktopRoot(root, 'config', '3.16.3')
  // An empty data root means "no downloaded releases"; the bundled copy must win.
  assert.deepEqual(resolveDesktopBuiltinConfig(desktop, ''), {
    path: path.join(root, 'resources', 'config', 'provider', 'zcode-builtin.json'),
    source: 'config',
  })
})

test('resolveDesktopBuiltinConfig returns undefined when neither source exists', () => {
  const root = fixtureDir('desktop-builtin-none')
  writeFixture(path.join(root, 'ZCode.exe'))
  writeFixture(path.join(root, 'resources', 'glm', 'zcode.cjs'))
  const desktop = inspectDesktopRoot(root, 'config', '3.16.3')
  assert.equal(resolveDesktopBuiltinConfig(desktop, ''), undefined)
  assert.equal(resolveDesktopBuiltinConfig(undefined, ''), undefined)
})

test('desktopCliEnv emits the measured desktop environment', () => {
  const desktopRoot = makeDesktopFixture('desktop-env')
  const fixture = makeDataRootFixture('data-env', ['3.16.3'])
  writeFixture(path.join(fixture.dataRoot.dataRoot, 'provider_config.json'), '{"providers":[]}')
  const desktop = inspectDesktopRoot(desktopRoot, 'registry', '3.16.3')
  assert.deepEqual(desktopCliEnv(desktop, fixture.dataRoot), {
    // The launcher is the Electron binary; without this it boots the GUI path and exits 0.
    ELECTRON_RUN_AS_NODE: '1',
    ZCODE_DATA_BASE_DIR: fixture.dataBaseDir,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.join(
      fixture.dataRoot.dataRoot,
      'runtime',
      'provider',
      PLATFORM_DIR,
      '3.16.3',
      'endpoint-78d7c3bef4024722642626fe3669a799',
      'zcode-builtin.json',
    ),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(fixture.dataRoot.dataRoot, 'provider_config.json'),
  })
})

test('desktopCliEnv always forces ELECTRON_RUN_AS_NODE to 1', () => {
  const desktopRoot = makeDesktopFixture('desktop-env-electron')
  const fixture = makeDataRootFixture('data-env-electron', [])
  const desktop = inspectDesktopRoot(desktopRoot, 'config', '3.16.3')
  const env = desktopCliEnv(desktop, fixture.dataRoot)
  // Even if the host process carries a different value (or none), the child must get '1':
  // ZCode.exe only runs the CLI script in Electron's Node mode.
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(Object.keys(env).includes('ELECTRON_RUN_AS_NODE'), true)
})

test('desktopCliEnv omits the personal provider config when it does not exist', () => {
  const desktopRoot = makeDesktopFixture('desktop-env-no-personal')
  const fixture = makeDataRootFixture('data-env-no-personal', [])
  const desktop = inspectDesktopRoot(desktopRoot, 'config', '3.16.3')
  const env = desktopCliEnv(desktop, fixture.dataRoot)
  assert.equal(env.ZCODE_DATA_BASE_DIR, fixture.dataBaseDir)
  assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, path.join(desktopRoot, 'resources', 'config', 'provider', 'zcode-builtin.json'))
  assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, undefined)
})

test('desktopCliEnv is empty without a desktop install', () => {
  assert.deepEqual(desktopCliEnv(undefined, undefined), {})
})

test('locateZcodeCli still honours an explicit configured path', () => {
  // Backwards compatibility: an explicit value is returned verbatim, without probing.
  assert.equal(locateZcodeCli('C:\\custom\\zcode.cjs'), 'C:\\custom\\zcode.cjs')
})
