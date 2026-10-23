/**
 * ZCode CLI discovery, model-catalogue normalisation and builtin inspection.
 *
 * Everything here uses Node built-ins only: `lib/diagnostics.js` (and the CLI in
 * `bin/`) reuse these helpers to inspect an installation *without* loading
 * `@deepseek-ai/dsh-llm`, so `doctor` still works when the plugin itself fails to
 * load against an incompatible host.
 *
 * Design note -- the CLI owns the model list. `session/create` answers with
 * `settings.model.available`, the account's authoritative catalogue, and the CLI
 * manages that account itself (it is a standalone process: it refuses
 * `provider/updateAccountConfig` with "Standalone Account 由本进程管理"). Earlier
 * versions of this bridge hard-coded a Start Plan provider id and injected an
 * entitlement patch; that provider does not exist on the npm CLI and the injection is
 * refused, so the catalogue reported here is the single source of truth.
 *
 * @module lib/zcode-runtime
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Candidate locations of the CLI (zcode.cjs).
 *
 * Why the ZCode CLI at all: the plan endpoint sits behind an Alibaba Cloud
 * invisible-verification challenge, so external HTTP callers -- real browsers and the
 * client renderer included -- are rejected with 3007/3012. The CLI carries its own
 * credential and challenge chain, and the app-server route through it is measured
 * working.
 *
 * Two shapes exist and they are not interchangeable:
 *   - the desktop client ships a raw `resources/glm/zcode.cjs`;
 *   - `npm i -g zcode-app-cli` ships `vendor/zcode.cjs` (the real bundle) behind a thin
 *     `bin/zcode.js` wrapper. Only the bundle answers `app-server`, so the wrapper is
 *     never a valid candidate.
 * The npm prefix is not fixed (this machine uses `D:\npm-global`), so it is discovered
 * from PATH rather than assumed to be under APPDATA.
 *
 * @type {readonly string[]}
 */
export const ZCODE_CLI_CANDIDATES = [
  process.env.ZCODE_CLI_PATH,
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')
    : undefined,
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'ZCode', 'resources', 'glm', 'zcode.cjs') : undefined,
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
  '/opt/ZCode/resources/glm/zcode.cjs',
  ...npmGlobalCliCandidates(),
].filter(
  /** @type {(candidate: string | undefined) => candidate is string} */
  ((candidate) => typeof candidate === 'string' && candidate !== ''),
)

/**
 * Locate a globally installed `zcode-app-cli` by looking at the directories on PATH.
 *
 * The global bin directory holds the `zcode`/`zcode.cmd` shim; the package itself is its
 * sibling `node_modules/zcode-app-cli`. This avoids hard-coding a prefix: npm's Windows
 * default is `%APPDATA%\npm`, but custom prefixes (this machine: `D:\npm-global`) are
 * common and only PATH knows about them.
 *
 * @returns {string[]} Candidate bundle paths (possibly none).
 */
function npmGlobalCliCandidates() {
  /** @type {string[]} */
  const found = []
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  for (const entry of pathValue.split(path.delimiter)) {
    const dir = entry.trim()
    if (dir === '') continue
    // Only consider directories that actually carry a zcode shim; otherwise every PATH
    // entry would contribute a bogus candidate.
    const shim = process.platform === 'win32' ? path.join(dir, 'zcode.cmd') : path.join(dir, 'zcode')
    try {
      if (!fs.statSync(shim).isFile()) continue
    } catch {
      continue
    }
    found.push(path.join(dir, 'node_modules', 'zcode-app-cli', 'vendor', 'zcode.cjs'))
  }
  return found
}

/**
 * Pick the CLI path: an explicit configuration value wins, then a desktop client's
 * bundled CLI, then the first known CLI candidate that exists on disk.
 *
 * The desktop client is consulted through {@link locateZcodeDesktop} rather than as one
 * more fixed path because its install root is configurable and, for a custom root such as
 * `E:\zcode`, only the uninstall registry knows where it is.
 *
 * @param {string | undefined} configuredPath The `zcodeCliPath` option ('' = auto).
 * @returns {string} The resolved path, or '' when nothing was found.
 */
export function locateZcodeCli(configuredPath) {
  const explicit = (configuredPath ?? '').trim()
  if (explicit !== '') return explicit
  // An explicit ZCODE_CLI_PATH outranks auto-detection, exactly as it did while it was the
  // first entry of ZCODE_CLI_CANDIDATES.
  const envPath = (process.env.ZCODE_CLI_PATH ?? '').trim()
  if (envPath !== '' && isFile(envPath)) return envPath
  // A desktop install bundles the real CLI, and it outranks an npm-global install: the
  // desktop client is the installation whose providers this bridge exists to expose.
  const desktop = locateZcodeDesktop('')
  if (desktop !== undefined && isFile(desktop.cliPath)) return desktop.cliPath
  for (const candidate of ZCODE_CLI_CANDIDATES) {
    if (isFile(candidate)) return candidate
  }
  return ''
}

/**
 * A ZCode desktop-client installation.
 *
 * Measured shape: the client is an Electron app whose launcher is `<root>/ZCode.exe` and
 * whose bundled CLI is `<root>/resources/glm/zcode.cjs`. The install root is **not** fixed:
 * this machine keeps the client at `E:\zcode`, and the registry entry is the only place
 * that says so (`InstallLocation` is empty, `UninstallString` points at
 * `E:\zcode\Uninstall ZCode.exe`).
 *
 * @typedef {object} ZcodeDesktop
 * @property {string} root Install root, e.g. `E:\zcode`.
 * @property {string} launcherPath `<root>/ZCode.exe`.
 * @property {string} cliPath `<root>/resources/glm/zcode.cjs`.
 * @property {string} version Desktop version from the uninstall registry, or 'unknown'.
 * @property {string} resourcesPath `<root>/resources`.
 * @property {string | undefined} builtinProviderConfigPath Bundled release json, when the
 *   install ships one.
 * @property {'config' | 'registry' | 'runtime'} discoverySource How the root was found:
 *   'config' = configured root, 'registry' = uninstall registry, 'runtime' = standard
 *   install directory.
 */

/**
 * An install root that may be a desktop client, before it is validated on disk.
 *
 * @typedef {object} ZcodeDesktopCandidate
 * @property {string} root Candidate install root.
 * @property {string} version Version reported by the candidate's source ('' when unknown).
 * @property {'config' | 'registry' | 'runtime'} discoverySource Where the candidate came from.
 */

/**
 * Uninstall registry keys that can carry a ZCode entry.
 *
 * The desktop installer is per-user by default (`HKCU`), but machine-wide and 32-bit
 * installs register under the other two, so all three are asked.
 *
 * @type {readonly string[]}
 */
const ZCODE_UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

/**
 * @param {string} filePath Candidate path.
 * @returns {boolean} Whether the path is an existing regular file (never throws).
 */
function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

/**
 * Strip one layer of surrounding quotes.
 *
 * @param {string} value Raw registry value.
 * @returns {string} The unquoted, trimmed value.
 */
function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).trim()
  return trimmed
}

/**
 * Extract the executable from an UninstallString.
 *
 * The measured shape is `"E:\zcode\Uninstall ZCode.exe" /currentuser`; an unquoted command
 * is also accepted by taking everything up to the first `.exe`.
 *
 * @param {string} command Raw `UninstallString`.
 * @returns {string} The executable path, or '' when it cannot be told.
 */
function executableFromUninstallString(command) {
  const trimmed = command.trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1)
    return end < 0 ? '' : trimmed.slice(1, end).trim()
  }
  const quoted = /^(.*?\.exe)(?:\s|$)/i.exec(trimmed)
  if (quoted !== null) return quoted[1]
  return trimmed.split(/\s+/)[0] ?? ''
}

/**
 * Directory that holds a registry-supplied executable or icon path.
 *
 * Windows paths are parsed with `path.win32` so the parser behaves the same wherever the
 * tests run.
 *
 * @param {string} executablePath Absolute Windows path.
 * @returns {string} Its parent directory, or '' when there is none.
 */
function rootFromExecutablePath(executablePath) {
  const unquoted = unquote(executablePath)
  if (unquoted === '') return ''
  const dir = path.win32.dirname(unquoted)
  return dir === '.' || dir === '' ? '' : dir
}

/**
 * Version embedded in a DisplayName such as `ZCode 3.16.3`.
 *
 * @param {string} label DisplayName value.
 * @returns {string} The dotted version, or '' when the label carries none.
 */
function versionFromLabel(label) {
  const match = /(\d+(?:\.\d+){1,3})/.exec(label)
  return match === null ? '' : match[1]
}

/**
 * Parse the stdout of `reg query <uninstall key> /s /f ZCode /d`.
 *
 * `reg query` prints one block per key: a `HKEY_...` header followed by indented
 * `Name    REG_TYPE    Data` lines. Only blocks whose DisplayName starts with `ZCode` are
 * kept; the install root is derived from `InstallLocation`, then the executable named by
 * `UninstallString`, then `DisplayIcon`, because any of the three can be the only usable
 * value (on this machine InstallLocation is empty and UninstallString is the only hint).
 *
 * @param {string} output Raw stdout.
 * @returns {ZcodeDesktopCandidate[]} Candidates with `discoverySource: 'registry'`.
 */
export function parseUninstallRegistryOutput(output) {
  /** @type {ZcodeDesktopCandidate[]} */
  const candidates = []
  if (typeof output !== 'string' || output.trim() === '') return candidates
  /** @type {Map<string, string>} */
  let values = new Map()
  /** @param {Map<string, string>} block One registry key's values. */
  const flush = (block) => {
    const displayName = text(block.get('DisplayName'))
    if (!/^zcode/i.test(displayName)) return
    const version = text(block.get('DisplayVersion')) || versionFromLabel(displayName)
    /** @type {string[]} */
    const roots = []
    const installLocation = unquote(text(block.get('InstallLocation')))
    if (installLocation !== '') roots.push(installLocation)
    const uninstallRoot = rootFromExecutablePath(executableFromUninstallString(text(block.get('UninstallString'))))
    if (uninstallRoot !== '') roots.push(uninstallRoot)
    const iconRoot = rootFromExecutablePath(text(block.get('DisplayIcon')))
    if (iconRoot !== '') roots.push(iconRoot)
    /** @type {Set<string>} */
    const seen = new Set()
    for (const root of roots) {
      const key = root.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ root, version, discoverySource: 'registry' })
    }
  }
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) {
      flush(values)
      values = new Map()
      continue
    }
    const match = /^\s{2,}([A-Za-z0-9_]+)\s+REG_[A-Z0-9_]+\s*(.*)$/.exec(line)
    if (match !== null) values.set(match[1], match[2])
  }
  flush(values)
  return candidates
}

/**
 * Decode `reg.exe` stdout.
 *
 * Windows writes redirected registry output in the console code page: UTF-8 on recent
 * builds, GBK on a Chinese locale. Trying UTF-8 first and falling back keeps a non-ASCII
 * install path from turning into replacement characters.
 *
 * @param {Buffer | string} stdout Captured output.
 * @returns {string} Decoded text.
 */
function decodeRegistryOutput(stdout) {
  if (typeof stdout === 'string') return stdout
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(stdout)
  } catch {
    try {
      return new TextDecoder('gbk').decode(stdout)
    } catch {
      return stdout.toString('latin1')
    }
  }
}

/**
 * Run one `reg query` invocation and return its decoded stdout.
 *
 * @param {string} command Executable name (`reg`).
 * @param {readonly string[]} args Arguments.
 * @returns {string} Stdout text.
 */
function queryRegistry(command, args) {
  // `encoding: 'buffer'` keeps the raw bytes so the console code page can be decoded
  // explicitly; it also selects the Buffer-returning overload of execFileSync.
  const stdout = execFileSync(command, args, { encoding: 'buffer', windowsHide: true, timeout: 5000 })
  return decodeRegistryOutput(stdout)
}

/**
 * Ask the uninstall registry for ZCode desktop installs.
 *
 * `reg query` is a subprocess, so this is only reached from auto-detection (never for a
 * configured root), and every failure -- no `reg`, no match, denied hive, timeout --
 * degrades to "no candidates" instead of throwing. The `execFileSyncImpl` parameter is the
 * test seam: tests pass a plain function and assert no process is ever spawned.
 *
 * @param {(command: string, args: readonly string[]) => string} [execFileSyncImpl] Injectable query.
 * @returns {ZcodeDesktopCandidate[]} Candidates with `discoverySource: 'registry'`.
 */
export function desktopCandidatesFromRegistryQuery(execFileSyncImpl) {
  if (process.platform !== 'win32') return []
  const run = execFileSyncImpl ?? queryRegistry
  /** @type {ZcodeDesktopCandidate[]} */
  const candidates = []
  for (const key of ZCODE_UNINSTALL_KEYS) {
    /** @type {string} */
    let output
    try {
      output = String(run('reg', ['query', key, '/s', '/f', 'ZCode', '/d']) ?? '')
    } catch {
      continue
    }
    for (const candidate of parseUninstallRegistryOutput(output)) candidates.push(candidate)
  }
  return dedupeCandidates(candidates)
}

/**
 * Collapse candidates that point at the same root, preferring the one with a version.
 *
 * @param {readonly ZcodeDesktopCandidate[]} candidates Raw candidates.
 * @returns {ZcodeDesktopCandidate[]} One candidate per root.
 */
function dedupeCandidates(candidates) {
  /** @type {Map<string, ZcodeDesktopCandidate>} */
  const byRoot = new Map()
  for (const candidate of candidates) {
    const key = candidate.root.toLowerCase()
    const existing = byRoot.get(key)
    if (existing === undefined) byRoot.set(key, candidate)
    else if (existing.version === '' && candidate.version !== '') byRoot.set(key, candidate)
  }
  return [...byRoot.values()]
}

/**
 * Standard desktop install roots, cheapest to check and free of subprocesses.
 *
 * @returns {ZcodeDesktopCandidate[]} Candidates with `discoverySource: 'runtime'`.
 */
function wellKnownDesktopCandidates() {
  /** @type {ZcodeDesktopCandidate[]} */
  const candidates = []
  if (process.platform !== 'win32') return candidates
  const localAppData = text(process.env.LOCALAPPDATA)
  if (localAppData !== '') {
    candidates.push({ root: path.join(localAppData, 'Programs', 'ZCode'), version: '', discoverySource: 'runtime' })
  }
  const programFiles = text(process.env.ProgramFiles)
  if (programFiles !== '') {
    candidates.push({ root: path.join(programFiles, 'ZCode'), version: '', discoverySource: 'runtime' })
  }
  const programFilesX86 = text(process.env['ProgramFiles(x86)'])
  if (programFilesX86 !== '') {
    candidates.push({ root: path.join(programFilesX86, 'ZCode'), version: '', discoverySource: 'runtime' })
  }
  return candidates
}

/**
 * Validate one candidate root and describe the desktop install it carries.
 *
 * Both the Electron launcher and the bundled CLI must exist: a directory with only one of
 * them is a partial install and cannot be launched the way the desktop launches its CLI.
 * The bundled builtin release is reported when present, but the downloaded runtime
 * release is resolved later, once the data root is known (see
 * {@link resolveDesktopBuiltinConfig}).
 *
 * @param {string} root Candidate install root.
 * @param {'config' | 'registry' | 'runtime'} discoverySource How the root was found.
 * @param {string} [version] Version reported by the source, '' when unknown.
 * @returns {ZcodeDesktop | undefined} The validated install, or undefined.
 */
export function inspectDesktopRoot(root, discoverySource, version = '') {
  const installRoot = text(root)
  if (installRoot === '') return undefined
  const launcherPath = path.join(installRoot, 'ZCode.exe')
  const resourcesPath = path.join(installRoot, 'resources')
  const cliPath = path.join(resourcesPath, 'glm', 'zcode.cjs')
  if (!isFile(launcherPath) || !isFile(cliPath)) return undefined
  const bundled = path.join(resourcesPath, 'config', 'provider', 'zcode-builtin.json')
  return {
    root: installRoot,
    launcherPath,
    cliPath,
    version: text(version) || 'unknown',
    resourcesPath,
    builtinProviderConfigPath: isFile(bundled) ? bundled : undefined,
    discoverySource,
  }
}

/**
 * Find the ZCode desktop client.
 *
 * Precedence: a configured root wins and is validated as-is -- a pinned root that does not
 * exist is a configuration error, not a reason to launch a different installation. With no
 * configured root the uninstall registry is asked first (a custom root such as `E:\zcode`
 * is invisible anywhere else), then the standard install directories.
 *
 * @param {string | undefined} configuredRoot The `zcodeClientRoot` option ('' = auto).
 * @param {(command: string, args: readonly string[]) => string} [execFileSyncImpl] Test seam for the registry query.
 * @returns {ZcodeDesktop | undefined} The install, or undefined when none exists.
 */
export function locateZcodeDesktop(configuredRoot, execFileSyncImpl) {
  const explicit = text(configuredRoot)
  if (explicit !== '') return inspectDesktopRoot(explicit, 'config', '')
  /** @type {ZcodeDesktopCandidate[]} */
  const candidates = [
    ...desktopCandidatesFromRegistryQuery(execFileSyncImpl),
    ...wellKnownDesktopCandidates(),
  ]
  for (const candidate of candidates) {
    const desktop = inspectDesktopRoot(candidate.root, candidate.discoverySource, candidate.version)
    if (desktop !== undefined) return desktop
  }
  return undefined
}

/**
 * The live ZCode data root.
 *
 * It is **not** always `~/.zcode`: the desktop client records its data directory in
 * `~/.zcode/v2/setting.json` (`dataBaseDir`), and on this machine that points at
 * `D:\AI\zcode`, so the live root is `D:\AI\zcode\.zcode\v2` while `~/.zcode/v2` is a
 * stale copy without a `provider_config.json`. A configured override wins over the
 * setting, and the setting wins over the home-directory default.
 *
 * @typedef {object} ZcodeDataRoot
 * @property {string} dataBaseDir Base directory, e.g. `D:\AI\zcode`.
 * @property {string} dataRoot `<dataBaseDir>/.zcode/v2`.
 * @property {string} settingPath Desktop settings file that carries `dataBaseDir`.
 * @property {'configured' | 'setting' | 'home'} source Where `dataBaseDir` came from.
 */

/**
 * Build a {@link ZcodeDataRoot} from a base directory.
 *
 * @param {string} dataBaseDir Base directory.
 * @param {string} settingPath Settings file that was (or would be) consulted.
 * @param {'configured' | 'setting' | 'home'} source Where the base directory came from.
 * @returns {ZcodeDataRoot} The resolved data root.
 */
function makeDataRoot(dataBaseDir, settingPath, source) {
  return { dataBaseDir, dataRoot: path.join(dataBaseDir, '.zcode', 'v2'), settingPath, source }
}

/**
 * Resolve the ZCode data root without throwing on a missing or malformed setting file.
 *
 * @param {string | undefined} configuredDataBaseDir The `zcodeDataBaseDir` option ('' = auto).
 * @param {string} [homeDir] Home directory; a test seam, defaults to `os.homedir()`.
 * @returns {ZcodeDataRoot} The resolved data root.
 */
export function resolveZcodeDataRoot(configuredDataBaseDir, homeDir = os.homedir()) {
  const home = text(homeDir) || os.homedir()
  const settingPath = path.join(home, '.zcode', 'v2', 'setting.json')
  const explicit = text(configuredDataBaseDir)
  if (explicit !== '') return makeDataRoot(path.resolve(explicit), settingPath, 'configured')
  /** @type {any} */
  let setting
  try {
    setting = JSON.parse(fs.readFileSync(settingPath, 'utf8'))
  } catch {
    setting = undefined
  }
  const fromSetting = text(setting?.dataBaseDir)
  if (fromSetting !== '') {
    // The desktop stores an absolute path here; resolve a relative one against the home
    // directory rather than against whatever cwd the bridge happens to have.
    const dataBaseDir = path.isAbsolute(fromSetting) ? fromSetting : path.resolve(home, fromSetting)
    return makeDataRoot(dataBaseDir, settingPath, 'setting')
  }
  return makeDataRoot(home, settingPath, 'home')
}

/**
 * A builtin provider release chosen for the desktop CLI.
 *
 * @typedef {object} DesktopBuiltinConfig
 * @property {string} path Absolute `zcode-builtin.json` path.
 * @property {'runtime' | 'config'} source 'runtime' = downloaded release, 'config' =
 *   bundled copy shipped inside the install.
 */

/**
 * Platform directory the desktop uses under `runtime/provider`.
 *
 * @returns {string} e.g. `windows-x86_64`.
 */
function runtimeProviderPlatformDir() {
  if (process.platform === 'win32') return `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
  return `${process.platform}-${process.arch}`
}

/**
 * Sorted subdirectory names, or [] when the directory cannot be read.
 *
 * @param {string} dirPath Directory to list.
 * @returns {string[]} Sorted directory names.
 */
function listDirectories(dirPath) {
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * Compare two version directory names numerically (`3.16.3` > `3.14.5`).
 *
 * @param {string} left Left name.
 * @param {string} right Right name.
 * @returns {number} Negative when left is older, positive when newer, 0 when equal.
 */
function compareVersions(left, right) {
  /** @type {number[]} */
  const leftParts = left.split(/[^0-9]+/).filter((part) => part !== '').map(Number)
  /** @type {number[]} */
  const rightParts = right.split(/[^0-9]+/).filter((part) => part !== '').map(Number)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Newest version directory name.
 *
 * @param {readonly string[]} versionDirs Directory names.
 * @returns {string} The newest name, or '' when the list is empty.
 */
function newestVersion(versionDirs) {
  /** @type {string} */
  let newest = ''
  for (const name of versionDirs) {
    if (newest === '' || compareVersions(name, newest) > 0) newest = name
  }
  return newest
}

/**
 * First `endpoint-*` release inside one version directory.
 *
 * @param {string} versionPath Absolute `<providerRoot>/<version>` path.
 * @returns {string} Absolute release path, or '' when there is none.
 */
function findEndpointRelease(versionPath) {
  for (const endpointName of listDirectories(versionPath)) {
    if (!endpointName.startsWith('endpoint-')) continue
    const release = path.join(versionPath, endpointName, 'zcode-builtin.json')
    if (isFile(release)) return release
  }
  return ''
}

/**
 * Downloaded release for the installed desktop version, else the newest downloaded one.
 *
 * @param {string} dataRootPath Absolute `<dataBaseDir>/.zcode/v2`.
 * @param {string} version Desktop version, 'unknown' when the registry had none.
 * @returns {string} Absolute release path, or '' when nothing was downloaded.
 */
function findRuntimeBuiltin(dataRootPath, version) {
  const providerRoot = path.join(dataRootPath, 'runtime', 'provider', runtimeProviderPlatformDir())
  const versionDirs = listDirectories(providerRoot)
  if (versionDirs.length === 0) return ''
  /** @type {string[]} */
  const preferred = []
  const wanted = text(version)
  if (wanted !== '' && versionDirs.includes(wanted)) preferred.push(wanted)
  const newest = newestVersion(versionDirs)
  if (newest !== '' && !preferred.includes(newest)) preferred.push(newest)
  for (const versionDir of preferred) {
    const release = findEndpointRelease(path.join(providerRoot, versionDir))
    if (release !== '') return release
  }
  return ''
}

/**
 * Normalise the data-root argument of the desktop helpers.
 *
 * @param {ZcodeDataRoot | string | undefined} dataRoot Resolved root, a bare data-root
 *   path, or undefined to auto-detect. An empty string means "no data root" and is kept
 *   empty, so callers can ask for the bundled release only.
 * @returns {ZcodeDataRoot} A data root; never undefined.
 */
function normalizeDataRoot(dataRoot) {
  if (typeof dataRoot === 'string') {
    const dataRootPath = text(dataRoot)
    if (dataRootPath === '') return { dataBaseDir: '', dataRoot: '', settingPath: '', source: 'configured' }
    return {
      dataBaseDir: dataBaseDirFromDataRoot(dataRootPath),
      dataRoot: dataRootPath,
      settingPath: '',
      source: 'configured',
    }
  }
  if (typeof dataRoot === 'object' && dataRoot !== null && typeof dataRoot.dataRoot === 'string') return dataRoot
  return resolveZcodeDataRoot('')
}

/**
 * Best-effort base directory for a bare `<base>/.zcode/v2` path.
 *
 * @param {string} dataRootPath Absolute data-root path.
 * @returns {string} The base directory, or the path itself when it has another shape.
 */
function dataBaseDirFromDataRoot(dataRootPath) {
  const normalized = path.normalize(dataRootPath)
  if (path.basename(normalized) === 'v2' && path.basename(path.dirname(normalized)) === '.zcode') {
    return path.dirname(path.dirname(normalized))
  }
  return normalized
}

/**
 * Pick the builtin provider release the desktop CLI should load.
 *
 * The desktop downloads one release per client version into
 * `<dataRoot>/runtime/provider/<platform>/<version>/endpoint-<hash>/zcode-builtin.json` and also
 * ships a copy at `<root>/resources/config/provider/zcode-builtin.json`. The downloaded
 * release for the *installed* desktop version is what the client itself would use, and a
 * newer downloaded release can carry a schema the installed CLI rejects, so the exact
 * version wins, then the newest downloaded version, then the bundled copy.
 *
 * @param {ZcodeDesktop | undefined} desktop The desktop install.
 * @param {ZcodeDataRoot | string | undefined} dataRoot Resolved data root (or a bare
 *   data-root path, or undefined to auto-detect).
 * @returns {DesktopBuiltinConfig | undefined} The release to use, or undefined.
 */
export function resolveDesktopBuiltinConfig(desktop, dataRoot) {
  if (desktop === undefined) return undefined
  const dataRootPath = normalizeDataRoot(dataRoot).dataRoot
  if (dataRootPath !== '') {
    const runtime = findRuntimeBuiltin(dataRootPath, desktop.version)
    if (runtime !== '') return { path: runtime, source: 'runtime' }
  }
  const bundled = text(desktop.builtinProviderConfigPath)
  if (bundled !== '' && isFile(bundled)) return { path: bundled, source: 'config' }
  const adjacent = path.join(desktop.root, 'resources', 'config', 'provider', 'zcode-builtin.json')
  if (isFile(adjacent)) return { path: adjacent, source: 'config' }
  return undefined
}

/**
 * Environment the desktop client passes to its bundled CLI.
 *
 * Measured: without these the bundle cannot find its builtin release and exits with
 * "无法定位 CLI ZCode Builtin Provider Config". `ELECTRON_RUN_AS_NODE=1` is equally
 * required: `<root>/ZCode.exe` is the Electron binary, and launched as
 * `ZCode.exe <cli> app-server ...` it only executes the CLI script when that variable is
 * set -- otherwise Electron boots the GUI path (single-instance forwarding), exits 0 and
 * app-server never starts. The value is forced explicitly so it also overrides a stale
 * value inherited from the host environment.
 *
 * Only the keys that apply are returned -- no empty values -- so a caller can spread this
 * into a spawn env. The personal provider file is included only when it exists: passing a
 * missing path makes the CLI fail instead of falling back to its own default.
 *
 * @param {ZcodeDesktop | undefined} desktop The desktop install (undefined = node mode).
 * @param {ZcodeDataRoot | string | undefined} [dataRoot] Resolved data root.
 * @returns {Record<string, string>} Environment variables to merge into the spawn env.
 */
export function desktopCliEnv(desktop, dataRoot) {
  /** @type {Record<string, string>} */
  const env = {}
  if (desktop === undefined) return env
  // Electron runs the CLI script only in Node mode; without this the launcher starts the
  // GUI path and exits before app-server is reachable.
  env.ELECTRON_RUN_AS_NODE = '1'
  const resolved = normalizeDataRoot(dataRoot)
  if (resolved.dataBaseDir !== '') env.ZCODE_DATA_BASE_DIR = resolved.dataBaseDir
  const builtin = resolveDesktopBuiltinConfig(desktop, resolved)
  if (builtin !== undefined) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin.path
  const personal = path.join(resolved.dataRoot, 'provider_config.json')
  if (resolved.dataRoot !== '' && isFile(personal)) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal
  return env
}

/**
 * Reasoning level the bridge asks for when neither the caller nor the catalogue picks
 * one. The `session/setModel` schema requires the field, so a value must always exist.
 */
export const DEFAULT_REASONING_LEVEL = 'max'

/**
 * Capacities used when neither the CLI nor configuration states a value. The measured
 * signed-in account reports a 1M context window and a 128K output cap for the GLM-5.3
 * family, which is what these encode; they are fallbacks, not the catalogue.
 */
export const DEFAULT_MAX_TOKENS = 128000
export const DEFAULT_CONTEXT_WINDOW = 1000000

/**
 * Modalities this bridge can forward.
 *
 * The JSDoc type above is a compile-time-only reference (`tsc --checkJs`), erased at
 * runtime, so this module still has no runtime dependency on the harness packages and
 * `doctor` keeps working when the plugin cannot be loaded.
 *
 * @type {readonly import('@deepseek-ai/dsh-llm').ModelModality[]}
 */
export const MODEL_MODALITIES = ['text', 'image']

/**
 * Models to advertise when the CLI cannot be reached or reports nothing usable.
 *
 * A last resort, so a misconfigured or signed-out install still shows an actionable
 * entry instead of an empty provider. A working CLI always wins over this list.
 *
 * @type {readonly CatalogEntry[]}
 */
export const FALLBACK_CATALOG = [
  {
    providerId: 'account:zai-individual-coding-plan',
    modelId: 'GLM-5.3-Flash',
    label: 'GLM-5.3-Flash',
    providerLabel: 'Z.AI Coding Plan',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_TOKENS,
    reasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: DEFAULT_REASONING_LEVEL,
    supportsImage: true,
  },
  {
    providerId: 'account:zai-individual-coding-plan',
    modelId: 'GLM-5.3',
    label: 'GLM-5.3',
    providerLabel: 'Z.AI Coding Plan',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_TOKENS,
    reasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: DEFAULT_REASONING_LEVEL,
    supportsImage: true,
  },
]

/**
 * One model the CLI reports as usable for this account.
 *
 * @typedef {object} CatalogEntry
 * @property {string} providerId CLI-side provider id (`account:...` for plan channels).
 * @property {string} modelId CLI-side model id, e.g. `GLM-5.3`.
 * @property {string} label Display name the CLI would show.
 * @property {string} providerLabel Display name of the owning provider.
 * @property {number | undefined} contextWindow Context capacity, when reported.
 * @property {number | undefined} maxOutputTokens Per-request output cap, when reported.
 * @property {readonly string[]} reasoningLevels Selectable reasoning levels, least first.
 * @property {string | undefined} defaultReasoningLevel Level the CLI itself would pick.
 * @property {boolean} supportsImage Whether the route accepts image input.
 */

/**
 * @param {unknown} value Candidate field.
 * @returns {string} The field when it is a non-empty string, otherwise ''.
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * @param {unknown} value Candidate field.
 * @returns {number | undefined} The field when it is a positive finite number.
 */
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Convert one `settings.model.available` entry into a {@link CatalogEntry}.
 *
 * The CLI's shape is `{ ref:{providerId,modelId}, label, providerLabel, contextWindow,
 * maxOutputTokens, reasoning:{levels:[{value,label}],defaultLevel},
 * properties:{inputFormat:{supportsImage}} }`. Fields are read defensively: a catalogue
 * entry without a provider/model ref is dropped rather than half-populated.
 *
 * @param {any} entry Raw catalogue entry from the CLI.
 * @returns {CatalogEntry | undefined} The normalised entry, or undefined when unusable.
 */
export function normalizeCatalogEntry(entry) {
  const providerId = text(entry?.ref?.providerId)
  const modelId = text(entry?.ref?.modelId)
  if (providerId === '' || modelId === '') return undefined
  const levels = Array.isArray(entry?.reasoning?.levels)
    ? entry.reasoning.levels
        .map((/** @type {any} */ level) => text(level?.value))
        .filter(/** @type {(value: string) => boolean} */ ((value) => value !== ''))
    : []
  return {
    providerId,
    modelId,
    label: text(entry?.label) || modelId,
    providerLabel: text(entry?.providerLabel) || providerId,
    contextWindow: positive(entry?.contextWindow),
    maxOutputTokens: positive(entry?.maxOutputTokens),
    reasoningLevels: levels,
    defaultReasoningLevel: text(entry?.reasoning?.defaultLevel) || undefined,
    supportsImage: entry?.properties?.inputFormat?.supportsImage === true,
  }
}

/**
 * Read the catalogue out of a `session/create` (or `session/close`) result.
 *
 * @param {any} result The `session/create` result.
 * @returns {CatalogEntry[]} Normalised entries, in CLI order.
 */
export function readModelCatalog(result) {
  const available = result?.settings?.model?.available
  if (!Array.isArray(available)) return []
  /** @type {CatalogEntry[]} */
  const catalog = []
  for (const entry of available) {
    const normalised = normalizeCatalogEntry(entry)
    if (normalised !== undefined) catalog.push(normalised)
  }
  return catalog
}

/**
 * Read the model the CLI selected for a freshly created session.
 *
 * @param {any} result The `session/create` result.
 * @returns {{ providerId: string, modelId: string } | undefined} The current model.
 */
export function readCurrentModel(result) {
  const providerId = text(result?.session?.model?.providerId)
  const modelId = text(result?.session?.model?.modelId)
  if (providerId === '' || modelId === '') return undefined
  return { providerId, modelId }
}

/**
 * Collapse the catalogue to one entry per model id.
 *
 * The same model id can be served by several providers (the plan account and a plain
 * API key both list `GLM-5.3`). DSH model ids must be unique within the provider, so the
 * bridge keeps a single entry per id and prefers account-backed channels: the whole
 * point of this plugin is to spend the CLI's own account, not a metered API key.
 *
 * Among account channels the Start Plan wins, because a desktop account can hold both a
 * coding plan and a Start Plan serving the *same* ids, and the coding-plan route can be
 * expired while Start Plan still has quota (measured here: coding plan answers
 * `1309 套餐已到期`, Start Plan serves GLM-5.3-Flash fine). Pinning an exact route is still
 * possible through `cliModels` (`cliModelId: "account:bigmodel-team-coding-plan/GLM-5.3"`).
 *
 * @param {readonly CatalogEntry[]} catalog Entries as reported by the CLI.
 * @returns {CatalogEntry[]} One entry per model id, preferred channel first.
 */
export function collapseCatalog(catalog) {
  /** @type {Map<string, CatalogEntry>} */
  const byId = new Map()
  for (const entry of catalog) {
    const existing = byId.get(entry.modelId)
    if (existing === undefined) {
      byId.set(entry.modelId, entry)
      continue
    }
    if (routeRank(entry) < routeRank(existing)) byId.set(entry.modelId, entry)
  }
  return [...byId.values()]
}

/**
 * Rank two routes that serve the same model id; lower wins.
 *
 *   1. Start Plan (the free/dev-day pool the desktop client shows quota for)
 *   2. individual coding plan, 3. team coding plan
 *   4. any other account route
 *   5. personal (API-key) providers
 *
 * @param {CatalogEntry} entry Candidate route.
 * @returns {number} Sort rank.
 */
function routeRank(entry) {
  const providerId = entry.providerId
  if (providerId.includes('start-plan')) return 0
  if (providerId.includes('individual-coding-plan')) return 1
  if (providerId.includes('team-coding-plan')) return 2
  if (providerId.startsWith('account:')) return 3
  return 4
}

/**
 * Pick the catalogue entry that should serve a DSH model id.
 *
 * Accepts the collapsed ids DSH was shown plus explicit `providerId/modelId` refs, so a
 * user can pin one exact route in configuration when a model id is served twice. An empty
 * model means "no preference": the account's preferred route is returned, which is what
 * the diagnostics probes want (they ask "what would this account use by default?").
 *
 * @param {readonly CatalogEntry[]} catalog Entries as reported by the CLI.
 * @param {string} model DSH model id or explicit `providerId/modelId`.
 * @returns {CatalogEntry | undefined} The matching entry.
 */
export function pickCatalogEntry(catalog, model) {
  const wanted = text(model)
  const collapsed = collapseCatalog(catalog)
  if (wanted === '') return collapsed[0]
  const direct = collapsed.find((entry) => entry.modelId === wanted)
  if (direct !== undefined) return direct
  return catalog.find((entry) => `${entry.providerId}/${entry.modelId}` === wanted)
}

/**
 * A ZCode builtin runtime directory candidate.
 *
 * @typedef {object} BuiltinRuntime
 * @property {string} version Real client version (`3.14.4`), never a provenance label.
 * @property {string} activeFilePath Absolute zcode-builtin.json path.
 * @property {number} mtimeMs File modification time.
 * @property {number | undefined} revision `revision` declared inside the file.
 * @property {'bundled' | 'active'} source Where the file came from.
 */

/**
 * Version of the installed CLI package.
 *
 * Used for the client-fingerprint headers (`user-agent: ZCode/<version>`): the upstream WAF
 * rejects requests whose fingerprint does not look like a real client build. npm publishes
 * the CLI as `3.14.4-30`, where the trailing number is a rebuild counter, so the numeric
 * `3.14.4` is what goes into the header.
 *
 * @param {string} cliPath Resolved zcode.cjs path.
 * @returns {string} Version such as `3.14.4`, or '' when nothing readable is next to it.
 */
export function readCliVersion(cliPath) {
  const cliDir = path.dirname(text(cliPath))
  // The npm package root sits one level above vendor/ (where vendor/zcode.cjs lives).
  for (const file of [path.join(cliDir, '..', 'package.json'), path.join(cliDir, 'package.json')]) {
    try {
      const version = text(JSON.parse(fs.readFileSync(file, 'utf8'))?.version)
      if (version !== '') return version.split('-')[0]
    } catch {
      /* Not the CLI package root; try the next candidate. */
    }
  }
  return ''
}

/**
 * Locate a zcode-builtin.json.
 *
 * Two sources exist and they are *not* interchangeable: the release shipped inside the
 * CLI installation (`<cliDir>/provider/zcode-builtin.json`, always decodable by that
 * exact CLI build) and the release the desktop client downloaded into
 * `<base>/.zcode/v2/runtime/provider/<platform>/<version>/<endpoint>/zcode-builtin.json`.
 * A newer client release can carry a schema the installed CLI rejects outright, so the
 * bundled copy is preferred and the runtime copy is only a fallback.
 *
 * This is inspection-only: the bridge does not feed either file to the CLI, because the
 * standalone CLI manages its own account and derives the same model list either way.
 *
 * @param {string | undefined} dataBaseDir ZCode data root ('' = user home).
 * @param {string} [cliPath] Resolved CLI path; its sibling `provider/` is checked first.
 * @returns {BuiltinRuntime | undefined} The chosen file, or undefined when none exists.
 */
export function resolveBuiltinRuntime(dataBaseDir, cliPath = '') {
  const explicitCli = text(cliPath)
  const cliVersion = explicitCli === '' ? '' : readCliVersion(explicitCli)
  if (explicitCli !== '') {
    const bundledPath = path.join(path.dirname(explicitCli), 'provider', 'zcode-builtin.json')
    const bundled = inspectBuiltin(bundledPath, 'bundled', cliVersion)
    if (bundled !== undefined) return bundled
  }
  const base = text(dataBaseDir) !== '' ? text(dataBaseDir) : os.homedir()
  const platformDir = process.platform === 'win32'
    ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
    : `${process.platform}-${process.arch}`
  const root = path.join(base, '.zcode', 'v2', 'runtime', 'provider', platformDir)
  /** @type {BuiltinRuntime | undefined} */
  let best
  /** @type {BuiltinRuntime | undefined} */
  let bestDev
  /** @type {import('node:fs').Dirent[]} */
  let versions
  try {
    versions = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const versionDir of versions) {
    if (!versionDir.isDirectory()) continue
    /** @type {import('node:fs').Dirent[]} */
    let endpoints
    try {
      endpoints = fs.readdirSync(path.join(root, versionDir.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const endpointDir of endpoints) {
      if (!endpointDir.isDirectory() || !endpointDir.name.startsWith('endpoint-')) continue
      const activeFilePath = path.join(root, versionDir.name, endpointDir.name, 'zcode-builtin.json')
      const candidate = inspectBuiltin(activeFilePath, 'active', versionDir.name)
      if (candidate === undefined) continue
      if (candidate.version === '0.0.0-dev') bestDev = candidate
      else if (best === undefined || candidate.mtimeMs > best.mtimeMs) best = candidate
    }
  }
  return best ?? bestDev
}

/**
 * Inspect one zcode-builtin.json without throwing on a malformed or missing file.
 *
 * @param {string} filePath Absolute path.
 * @param {'bundled' | 'active'} source Which source this path belongs to.
 * @param {string} [fallbackVersion] Version label when the path carries none.
 * @returns {BuiltinRuntime | undefined} The inspected file.
 */
function inspectBuiltin(filePath, source, fallbackVersion) {
  /** @type {fs.Stats} */
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    return undefined
  }
  /** @type {number | undefined} */
  let revision
  try {
    const release = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    revision = typeof release?.revision === 'number' ? release.revision : undefined
  } catch {
    /* Unreadable JSON is still worth reporting as a location, minus the revision. */
  }
  // Never return a provenance label here: `version` ends up in the client-fingerprint
  // headers, and `ZCode/bundled` is not a version the upstream WAF accepts.
  const version = text(fallbackVersion) !== '' ? text(fallbackVersion) : 'unknown'
  return { version, activeFilePath: filePath, mtimeMs: stat.mtimeMs, revision, source }
}

/**
 * Compute the `basedOnZCodeBuiltinRevision` form used by the CLI's registry.
 *
 * @param {string} activeFilePath Absolute zcode-builtin.json path.
 * @returns {string} `zcode-builtin:<revision>:<sha256 of the resolved path>`.
 * @throws {SyntaxError} When the builtin file is not valid JSON.
 */
export function computeBuiltinRevision(activeFilePath) {
  const release = JSON.parse(fs.readFileSync(activeFilePath, 'utf8'))
  const hash = createHash('sha256').update(path.resolve(activeFilePath)).digest('hex')
  return `zcode-builtin:${release?.revision}:${hash}`
}

/**
 * Read the provider inventory declared by zcode-builtin.json, for diagnostics.
 *
 * The release stores providers as an array under
 * `config.providerConfigRules.providerRules`; each item carries `providerId` and its
 * `config.api.type`/`config.access.type`. Older bridge code looked for a
 * top-level `providers` map, which never existed, so `doctor` always reported an empty
 * list.
 *
 * @param {string} activeFilePath Absolute zcode-builtin.json path.
 * @returns {{ revision: unknown, providers: { id: string, name: string, access: string, api: string }[] }} Summary.
 */
export function readBuiltinInventory(activeFilePath) {
  const release = JSON.parse(fs.readFileSync(activeFilePath, 'utf8'))
  /** @type {{ id: string, name: string, access: string, api: string }[]} */
  const providers = []
  const rules = release?.config?.providerConfigRules?.providerRules
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      const id = text(rule?.providerId)
      if (id === '') continue
      providers.push({
        id,
        name: text(rule?.providerName) || id,
        access: text(rule?.config?.access?.type),
        api: text(rule?.config?.api?.type),
      })
    }
  }
  return { revision: release?.revision, providers }
}

/**
 * Apply the plugin's per-model enable/disable selection to an advertised model list.
 *
 * Why the plugin filters instead of the CLI: the CLI reports what the *account* can serve,
 * which on a desktop install is every provider the user ever configured (five providers /
 * fifteen models here, including API-key channels they may not want in DSH's picker).
 * Enabling a subset is a display decision, so it happens on the DSH side and never
 * touches the CLI's registry or the routing table.
 *
 * Semantics (mirrors the reference connect plugins):
 *   - `enabledModelIds` empty  -> every model is enabled (the default: follow the CLI);
 *   - `enabledModelIds` non-empty -> only those ids, in catalogue order;
 *   - `disabledModelIds` always wins over the allow list, so a single id can be dropped
 *     without rewriting the allow list.
 *
 * @template {{ id: string }} Model
 * @param {readonly Model[]} models Models in catalogue order.
 * @param {readonly string[]} [enabledModelIds] Allow list ('' / [] = all).
 * @param {readonly string[]} [disabledModelIds] Block list, applied last.
 * @returns {{ models: Model[], unknownEnabledIds: string[], unknownDisabledIds: string[] }}
 *   The filtered list plus the configured ids that matched nothing (for a warning).
 */
export function selectEnabledModels(models, enabledModelIds = [], disabledModelIds = []) {
  const enabled = normalizeIdList(enabledModelIds)
  const disabled = normalizeIdList(disabledModelIds)
  const known = new Set(models.map((model) => model.id))
  const unknownEnabledIds = enabled.filter((id) => !known.has(id))
  const unknownDisabledIds = disabled.filter((id) => !known.has(id))
  /** @type {readonly Model[]} */
  const allowed = enabled.length === 0 ? models : models.filter((model) => enabled.includes(model.id))
  /** @type {readonly Model[]} */
  const filtered = disabled.length === 0 ? allowed : allowed.filter((model) => !disabled.includes(model.id))
  return {
    models: [...filtered],
    unknownEnabledIds,
    unknownDisabledIds,
  }
}

/**
 * Trim, drop empties and de-duplicate a configured id list, preserving order.
 *
 * @param {readonly string[] | undefined} ids Configured ids.
 * @returns {string[]} Normalised ids.
 */
export function normalizeIdList(ids) {
  if (!Array.isArray(ids)) return []
  /** @type {string[]} */
  const out = []
  for (const raw of ids) {
    const id = text(raw)
    if (id === '' || out.includes(id)) continue
    out.push(id)
  }
  return out
}
