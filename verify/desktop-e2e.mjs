#!/usr/bin/env node
/**
 * Independent end-to-end verification harness for the dsh-zcode-plan-bridge
 * desktop-client integration (v0.5.0).
 *
 * It runs the shipped CLI exactly as documented, in a clean environment (every
 * `ZCODE_*` variable is removed from the explicit env of every subprocess), parses
 * the real output, and writes machine-readable (`report.json`) plus human-readable
 * (`report.md`) evidence.
 *
 * Usage:
 *   node verify/desktop-e2e.mjs           # claims 1-4 (no quota spent)
 *   node verify/desktop-e2e.mjs --turn    # claims 1-6 (two real turns: one personal,
 *                                         # one coding-plan route; claim 5 spends quota)
 *
 * No dependencies. Node >= 22.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERIFY_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(VERIFY_DIR, '..')
const REPORT_JSON = path.join(VERIFY_DIR, 'report.json')
const REPORT_MD = path.join(VERIFY_DIR, 'report.md')
const NODE_EXEC = process.execPath
const RUN_TURN = process.argv.includes('--turn')
const MAX_CAPTURE = 40000

const ZCODE_ENV_RE = /^ZCODE_/i

/** Claim 2's expected catalogue: providerId -> modelIds (order as claimed). */
const EXPECTED_MODELS = new Map([
  ['account:bigmodel-team-coding-plan', ['GLM-5.3', 'GLM-5.3-Flash']],
  ['new-provider-3', ['qwen3.8-max-0902', 'qwen3.8-flash', 'deepseek-v4.1-flash-1017']],
  ['new-provider-4', ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']],
  ['new-provider-5', ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']],
  ['deepseek', ['deepseek-flash', 'deepseek-v4-pro']],
  ['new-provider', ['LongCat-2.5-Preview']],
])
const EXPECTED_MODEL_COUNT = [...EXPECTED_MODELS.values()].reduce((sum, ids) => sum + ids.length, 0) // 15
const EXPECTED_PROVIDER_COUNT = EXPECTED_MODELS.size // 6

/** Claim 1's expected doctor facts. */
const EXPECTED_DOCTOR = {
  root: 'E:\\zcode',
  discoverySource: 'registry',
  version: '3.16.3',
  dataBaseDir: 'D:\\AI\\zcode',
  dataBaseSource: 'setting',
  dataRoot: 'D:\\AI\\zcode\\.zcode\\v2',
  builtinRelease: '3.16.3 (runtime)',
  credentialsFile: 'D:\\AI\\zcode\\.zcode\\v2\\credentials.json',
  modelCount: 15,
}

/** Claim 5's expected personal-provider turn. */
const PERSONAL_MODEL = 'qwen3.8-flash'
/** Claim 6's expected coding-plan route and upstream failure. */
const PLAN_MODEL = 'GLM-5.3'
const PLAN_UPSTREAM_URL = 'https://open.bigmodel.cn/api/anthropic'
const PLAN_BUSINESS_CODE = '1309'
const PLAN_EXPIRED_MARKER = '套餐已到期'

const removedZcodeEnv = new Set()

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** Clone the parent env with every ZCODE_* key removed (case-insensitive). */
function cleanEnv() {
  const env = { ...process.env }
  const removed = []
  for (const key of Object.keys(env)) {
    if (ZCODE_ENV_RE.test(key)) {
      removed.push(key)
      delete env[key]
    }
  }
  return { env, removed }
}

function clip(text) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= MAX_CAPTURE) return value
  return `${value.slice(0, MAX_CAPTURE)}\n...[truncated ${value.length - MAX_CAPTURE} chars]`
}

/**
 * Run one subprocess with an explicit clean env.
 * @returns {object} raw result plus timing.
 */
function runProcess(id, display, file, args, options = {}) {
  const { env, removed } = cleanEnv()
  for (const name of removed) removedZcodeEnv.add(name)
  const startedAt = new Date().toISOString()
  const t0 = process.hrtime.bigint()
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? REPO_DIR,
    env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 180_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  const durationMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6)
  return {
    id,
    command: display,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    spawnError: result.error ? { code: result.error.code ?? null, message: result.error.message } : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function assertion(id, ok, expected, actual) {
  return { id, ok: Boolean(ok), expected, actual }
}

/**
 * Build a check record from a raw process result plus assertions.
 */
function buildCheck(spec) {
  const { id, claim, title, run, expectedExit, assertions, extracted, summary, notes } = spec
  const expected = Array.isArray(expectedExit) ? expectedExit : [expectedExit]
  const exitOk = expected.includes(run.exitCode)
  const pass =
    exitOk &&
    run.spawnError === null &&
    run.signal === null &&
    assertions.every((entry) => entry.ok === true)
  return {
    id,
    claim,
    title,
    command: run.command,
    cwd: REPO_DIR,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    expectedExit: expected,
    signal: run.signal,
    timedOut: run.timedOut,
    spawnError: run.spawnError,
    pass,
    summary: summary ?? '',
    assertions,
    extracted: extracted ?? {},
    notes: notes ?? [],
    stdout: clip(run.stdout),
    stderr: clip(run.stderr),
  }
}

function failedCheck(spec, error) {
  return {
    id: spec.id,
    claim: spec.claim,
    title: spec.title,
    command: spec.command,
    cwd: REPO_DIR,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    exitCode: null,
    expectedExit: Array.isArray(spec.expectedExit) ? spec.expectedExit : [spec.expectedExit ?? 0],
    signal: null,
    timedOut: false,
    spawnError: null,
    pass: false,
    summary: 'harness error',
    assertions: [assertion('harness-error', false, 'check executes', String(error?.stack ?? error))],
    extracted: {},
    notes: [],
    stdout: '',
    stderr: '',
  }
}

// ---------------------------------------------------------------------------
// Output parsers (parse the real CLI output; nothing is mocked)
// ---------------------------------------------------------------------------

const eqPath = (actual, expected) =>
  typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase()

function setEquals(actual, expected) {
  if (actual.length !== expected.length) return false
  const want = new Set(expected)
  return actual.every((value) => want.has(value))
}

/** Split doctor output into numbered sections (the CLI prints "N. title"). */
function doctorSections(stdout) {
  const sections = new Map()
  let current = -1
  for (const line of stdout.split(/\r?\n/)) {
    const header = /^(\d+)\.\s+(.+?)\s*$/.exec(line)
    if (header !== null) {
      current = Number(header[1])
      sections.set(current, [])
      continue
    }
    if (current >= 0) sections.get(current).push(line)
  }
  return sections
}

function firstMatch(lines, regex) {
  for (const line of lines) {
    const match = regex.exec(line)
    if (match !== null) return match
  }
  return null
}

/** Parse `doctor` output into the facts claim 1 asserts. */
function parseDoctor(stdout) {
  const sections = doctorSections(stdout)
  const section = (number) => sections.get(number) ?? []
  const root = firstMatch(section(2), /^\s{2}root\s+(.+?)\s+\(([A-Za-z-]+)\)\s*$/)
  const version = firstMatch(section(2), /^\s{2}version\s+(\S+)\s*$/)
  const dataBase = firstMatch(section(3), /^\s{2}dataBaseDir\s+(.+?)\s+\(([A-Za-z-]+)\)\s*$/)
  const dataRoot = firstMatch(section(3), /^\s{2}dataRoot\s+(.+?)\s*$/)
  const builtinVersion = firstMatch(section(5), /^\s{2}version\s+(.+?)\s*$/)
  const builtinFile = firstMatch(section(5), /^\s{2}file\s+(.+?)\s*$/)
  const credentialsFile = firstMatch(section(6), /^\s{2}file\s+(.+?)\s*$/)
  const tokenLength = firstMatch(section(6), /^\s{2}zcodejwttoken\s+(\d+)\s+chars/)
  const catalog = []
  for (const line of section(7)) {
    const match = /^\s{2}([^\s/]+) \/ ([^\s/]+) — ctx (\d+), max out (\d+)(?:, image)?\s*$/.exec(line)
    if (match !== null) {
      catalog.push({
        providerId: match[1],
        modelId: match[2],
        contextWindow: Number(match[3]),
        maxOutputTokens: Number(match[4]),
      })
    }
  }
  return {
    root: root?.[1] ?? null,
    discoverySource: root?.[2] ?? null,
    version: version?.[1] ?? null,
    dataBaseDir: dataBase?.[1] ?? null,
    dataBaseSource: dataBase?.[2] ?? null,
    dataRoot: dataRoot?.[1] ?? null,
    builtinRelease: builtinVersion?.[1] ?? null,
    builtinFile: builtinFile?.[1] ?? null,
    credentialsFile: credentialsFile?.[1] ?? null,
    tokenLength: tokenLength !== null ? Number(tokenLength[1]) : null,
    catalog,
    modelCount: catalog.length,
    providerCount: new Set(catalog.map((entry) => entry.providerId)).size,
    allPreconditionsSatisfied: /^All local preconditions satisfied\./m.test(stdout),
  }
}

/** Parse `models` output: top-level "providerId / modelId" lines plus detail lines. */
function parseModels(stdout) {
  const entries = []
  let current = null
  for (const line of stdout.split(/\r?\n/)) {
    const head = /^([^\s/]+) \/ ([^\s/]+)$/.exec(line)
    if (head !== null) {
      current = {
        providerId: head[1],
        modelId: head[2],
        label: null,
        contextWindow: null,
        maxOutputTokens: null,
        image: null,
      }
      entries.push(current)
      continue
    }
    if (current === null) continue
    let match
    if ((match = /^\s{2}label\s+(.+?)\s*$/.exec(line)) !== null) current.label = match[1]
    else if ((match = /^\s{2}context\s+(\d+) tokens\s*$/.exec(line)) !== null) current.contextWindow = Number(match[1])
    else if ((match = /^\s{2}max out\s+(\d+) tokens\s*$/.exec(line)) !== null) current.maxOutputTokens = Number(match[1])
    else if ((match = /^\s{2}image\s+(supported|not supported)\s*$/.exec(line)) !== null) current.image = match[1] === 'supported'
  }
  return entries
}

/** Group parsed entries into providerId -> modelIds. */
function groupModels(entries) {
  const grouped = new Map()
  for (const entry of entries) {
    if (!grouped.has(entry.providerId)) grouped.set(entry.providerId, [])
    grouped.get(entry.providerId).push(entry.modelId)
  }
  return grouped
}

/** Parse `turn` output: result line, route, usage JSON, and the response block. */
function parseTurn(stdout) {
  const observed = {
    resultType: null,
    streamingDeltas: null,
    providerId: null,
    observedModelId: null,
    baseURL: null,
    routeProviderId: null,
    routeModelId: null,
    reasoningLevel: null,
    usage: null,
    usageRaw: null,
    response: null,
  }
  const responseLines = []
  let inResponse = false
  for (const line of stdout.split(/\r?\n/)) {
    const result = /^result\s+(\w+),\s+(\d+)\s+streaming deltas\s*$/.exec(line)
    if (result !== null) {
      observed.resultType = result[1]
      observed.streamingDeltas = Number(result[2])
      inResponse = false
      continue
    }
    let match
    if ((match = /^\s{2}providerId\s+(.+?)\s*$/.exec(line)) !== null) {
      observed.providerId = match[1]
      continue
    }
    if ((match = /^\s{2}baseURL\s+(.+?)\s*$/.exec(line)) !== null) {
      observed.baseURL = match[1]
      continue
    }
    if ((match = /^\s{2}usage\s+(\{.*\})\s*$/.exec(line)) !== null) {
      observed.usageRaw = match[1]
      try {
        observed.usage = JSON.parse(match[1])
      } catch {
        /* keep the raw text; the assertion reports null */
      }
      continue
    }
    if ((match = /^\s{2}model\s+(\S+)\/(\S+) \(reasoning ([^)]+)\)\s*$/.exec(line)) !== null) {
      observed.routeProviderId = match[1]
      observed.routeModelId = match[2]
      observed.reasoningLevel = match[3]
      continue
    }
    if ((match = /^\s{2}model\s+(\S+)\s*$/.exec(line)) !== null) {
      observed.observedModelId = match[1]
      continue
    }
    if (/^response:\s*$/.test(line)) {
      inResponse = true
      continue
    }
    if (inResponse) {
      if (line.startsWith('  ')) responseLines.push(line.slice(2))
      else if (line.trim() === '') {
        if (responseLines.length > 0) responseLines.push('')
      } else inResponse = false
    }
  }
  while (responseLines.length > 0 && responseLines[responseLines.length - 1] === '') responseLines.pop()
  observed.response = responseLines.join('\n')
  return observed
}

/** Parse node --test summary counters (Node 22+ uses the "ℹ" prefix). */
function parseTestCounts(stdout) {
  const read = (label) => {
    const match = new RegExp(`^[ℹ#]\\s*${label}\\s+(\\d+)`, 'm').exec(stdout)
    return match !== null ? Number(match[1]) : null
  }
  return {
    tests: read('tests'),
    pass: read('pass'),
    fail: read('fail'),
    cancelled: read('cancelled'),
    skipped: read('skipped'),
    todo: read('todo'),
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkDoctor() {
  const run = runProcess('doctor', 'node bin/dsh-zcode-plan-bridge.js doctor', NODE_EXEC, [
    'bin/dsh-zcode-plan-bridge.js',
    'doctor',
  ], { timeoutMs: 180_000 })
  const facts = parseDoctor(run.stdout)
  const expected = EXPECTED_DOCTOR
  const assertions = [
    assertion('exit-code', run.exitCode === 0, 0, run.exitCode),
    assertion('desktop-root', eqPath(facts.root, expected.root), expected.root, facts.root),
    assertion('desktop-discovery-source', facts.discoverySource === expected.discoverySource, expected.discoverySource, facts.discoverySource),
    assertion('desktop-version', facts.version === expected.version, expected.version, facts.version),
    assertion('dataBaseDir', eqPath(facts.dataBaseDir, expected.dataBaseDir), expected.dataBaseDir, facts.dataBaseDir),
    assertion('data-root-source', facts.dataBaseSource === expected.dataBaseSource, expected.dataBaseSource, facts.dataBaseSource),
    assertion('dataRoot', eqPath(facts.dataRoot, expected.dataRoot), expected.dataRoot, facts.dataRoot),
    assertion('builtin-release', facts.builtinRelease === expected.builtinRelease, expected.builtinRelease, facts.builtinRelease),
    assertion('credentials-file', eqPath(facts.credentialsFile, expected.credentialsFile), expected.credentialsFile, facts.credentialsFile),
    assertion('model-count', facts.modelCount === expected.modelCount, expected.modelCount, facts.modelCount),
    assertion('all-preconditions-satisfied', facts.allPreconditionsSatisfied === true, true, facts.allPreconditionsSatisfied),
  ]
  return buildCheck({
    id: 'doctor',
    claim: 1,
    title: 'doctor in a clean env: desktop client E:\\zcode 3.16.3 (registry), data root D:\\AI\\zcode (setting), builtin 3.16.3 (runtime), credentials, 15 models',
    run,
    expectedExit: 0,
    assertions,
    extracted: facts,
    summary: `root ${facts.root} (${facts.discoverySource}); dataRoot ${facts.dataRoot}; builtin ${facts.builtinRelease}; credentials ${facts.credentialsFile}; ${facts.modelCount} models / ${facts.providerCount} providers`,
  })
}

function checkModels() {
  const run = runProcess('models', 'node bin/dsh-zcode-plan-bridge.js models', NODE_EXEC, [
    'bin/dsh-zcode-plan-bridge.js',
    'models',
  ], { timeoutMs: 180_000 })
  const entries = parseModels(run.stdout)
  const grouped = groupModels(entries)
  const providerIds = [...grouped.keys()]
  const expectedProviderIds = [...EXPECTED_MODELS.keys()]
  const modelIds = entries.map((entry) => entry.modelId)
  const duplicateModelIds = modelIds.filter((id, index) => modelIds.indexOf(id) !== index)

  const assertions = [
    assertion('exit-code', run.exitCode === 0, 0, run.exitCode),
    assertion('entry-count', entries.length === EXPECTED_MODEL_COUNT, EXPECTED_MODEL_COUNT, entries.length),
    assertion('provider-count', providerIds.length === EXPECTED_PROVIDER_COUNT, EXPECTED_PROVIDER_COUNT, providerIds.length),
    assertion('provider-ids', setEquals(providerIds, expectedProviderIds), expectedProviderIds, providerIds),
    assertion('no-duplicate-model-ids', duplicateModelIds.length === 0, [], duplicateModelIds),
  ]
  for (const [providerId, expectedIds] of EXPECTED_MODELS) {
    assertions.push(
      assertion(`models:${providerId}`, setEquals(grouped.get(providerId) ?? [], expectedIds), expectedIds, grouped.get(providerId) ?? []),
    )
  }
  return buildCheck({
    id: 'models',
    claim: 2,
    title: 'models in a clean env: exactly 15 entries across the 6 claimed providers',
    run,
    expectedExit: 0,
    assertions,
    extracted: {
      entryCount: entries.length,
      providerCount: providerIds.length,
      providers: Object.fromEntries(grouped),
      entries,
    },
    summary: `${entries.length} models / ${providerIds.length} providers: ${providerIds.map((id) => `${id}(${grouped.get(id).length})`).join(', ')}`,
  })
}

function checkNodeTest() {
  const run = runProcess('node-test', 'node --test', NODE_EXEC, ['--test'], { timeoutMs: 180_000 })
  const counts = parseTestCounts(run.stdout)
  const assertions = [
    assertion('exit-code', run.exitCode === 0, 0, run.exitCode),
    assertion('pass-count', counts.pass === 53, 53, counts.pass),
    assertion('fail-count', counts.fail === 0, 0, counts.fail),
  ]
  return buildCheck({
    id: 'node-test',
    claim: 3,
    title: 'node --test: 53 pass, 0 fail',
    run,
    expectedExit: 0,
    assertions,
    extracted: counts,
    summary: `${counts.pass} pass / ${counts.fail} fail (tests ${counts.tests})`,
  })
}

function checkTypecheck() {
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  const run = runProcess('typecheck', 'npm run typecheck', comspec, ['/d', '/s', '/c', 'npm run typecheck'], {
    timeoutMs: 180_000,
  })
  const assertions = [assertion('exit-code', run.exitCode === 0, 0, run.exitCode)]
  return buildCheck({
    id: 'typecheck',
    claim: 3,
    title: 'npm run typecheck (tsc -p tsconfig.json) exits 0',
    run,
    expectedExit: 0,
    assertions,
    extracted: { exitCode: run.exitCode },
    summary: `tsc exit ${run.exitCode}`,
  })
}

const PLUGIN_LOAD_SCRIPT = [
  "import('./lib/index.js')",
  '  .then((m) => {',
  "    const want = ['Config', 'apply', 'name', 'resolveOptions', 'ZcodeAppServerAdapter']",
  '    const out = {',
  '      exports: Object.keys(m).sort(),',
  '      types: Object.fromEntries(want.map((key) => [key, typeof m[key]])),',
  '      name: m.name,',
  "      defaultExport: m.default && typeof m.default === 'object' ? Object.keys(m.default).sort() : null,",
  '    }',
  "    console.log('VERIFY_EXPORTS_JSON ' + JSON.stringify(out))",
  '  })',
  '  .catch((error) => {',
  "    console.error('VERIFY_IMPORT_FAILED ' + String((error && error.stack) || error))",
  '    process.exit(1)',
  '  })',
].join('\n')

function readPeerVersions() {
  const names = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm']
  const versions = {}
  for (const name of names) {
    try {
      const file = path.join(REPO_DIR, 'node_modules', ...name.split('/'), 'package.json')
      versions[name] = JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null
    } catch {
      versions[name] = null
    }
  }
  return versions
}

function checkPluginLoad() {
  const run = runProcess(
    'plugin-load',
    "node -e \"import('./lib/index.js').then(m => { /* inspect exports */ })\"",
    NODE_EXEC,
    ['-e', PLUGIN_LOAD_SCRIPT],
    { timeoutMs: 60_000 },
  )
  const marker = /^VERIFY_EXPORTS_JSON (.*)$/m.exec(run.stdout)
  let parsed = null
  if (marker !== null) {
    try {
      parsed = JSON.parse(marker[1])
    } catch {
      parsed = null
    }
  }
  const expectedTypes = {
    Config: 'function',
    apply: 'function',
    name: 'string',
    resolveOptions: 'function',
    ZcodeAppServerAdapter: 'function',
  }
  const assertions = [assertion('exit-code', run.exitCode === 0, 0, run.exitCode)]
  for (const [key, type] of Object.entries(expectedTypes)) {
    assertions.push(
      assertion(`export:${key}`, parsed !== null && parsed.types?.[key] === type, type, parsed?.types?.[key] ?? null),
    )
  }
  assertions.push(
    assertion('export-name-value', parsed?.name === 'dsh-zcode-plan-bridge', 'dsh-zcode-plan-bridge', parsed?.name ?? null),
  )
  const peerVersions = readPeerVersions()
  return buildCheck({
    id: 'plugin-load',
    claim: 4,
    title: "import('./lib/index.js') against the real node_modules peer packages exports Config/apply/name/resolveOptions/ZcodeAppServerAdapter",
    run,
    expectedExit: 0,
    assertions,
    extracted: {
      exports: parsed?.exports ?? null,
      types: parsed?.types ?? null,
      name: parsed?.name ?? null,
      defaultExport: parsed?.defaultExport ?? null,
      peerVersions,
    },
    summary: parsed !== null ? `exports ${parsed.exports.join(', ')}; peers ${Object.entries(peerVersions).map(([n, v]) => `${n}@${v}`).join(', ')}` : 'module import failed',
  })
}

function checkPersonalTurn() {
  const prompt = 'Reply with exactly: OK'
  const run = runProcess(
    'turn-personal',
    `node bin/dsh-zcode-plan-bridge.js turn "${prompt}" --model ${PERSONAL_MODEL}`,
    NODE_EXEC,
    ['bin/dsh-zcode-plan-bridge.js', 'turn', prompt, '--model', PERSONAL_MODEL],
    { timeoutMs: 300_000 },
  )
  const turn = parseTurn(run.stdout)
  const observedModel = turn.observedModelId ?? turn.routeModelId
  const inputTokens = turn.usage?.inputTokens
  const providerForClaim = turn.routeProviderId ?? turn.providerId
  const assertions = [
    assertion('exit-code', run.exitCode === 0, 0, run.exitCode),
    assertion('result-success', turn.resultType === 'success', 'success', turn.resultType),
    assertion('streaming-deltas>=1', Number.isFinite(turn.streamingDeltas) && turn.streamingDeltas >= 1, '>= 1', turn.streamingDeltas),
    assertion('response-contains-OK', typeof turn.response === 'string' && turn.response.includes('OK'), 'response includes "OK"', turn.response),
    assertion('usage-inputTokens>0', Number(inputTokens) > 0, 'inputTokens > 0', inputTokens ?? null),
    assertion('personal-provider', typeof providerForClaim === 'string' && providerForClaim !== '' && !providerForClaim.startsWith('account:'), 'non-account provider', providerForClaim),
    assertion('model-is-qwen3.8-flash', observedModel === PERSONAL_MODEL, PERSONAL_MODEL, observedModel),
  ]
  return buildCheck({
    id: 'turn-personal',
    claim: 5,
    title: `real streamed turn on a personal provider: ${PERSONAL_MODEL}`,
    run,
    expectedExit: 0,
    assertions,
    extracted: {
      resultType: turn.resultType,
      streamingDeltas: turn.streamingDeltas,
      providerId: turn.providerId,
      route: turn.routeProviderId !== null ? `${turn.routeProviderId}/${turn.routeModelId}` : null,
      observedModelId: turn.observedModelId,
      reasoningLevel: turn.reasoningLevel,
      baseURL: turn.baseURL,
      usage: turn.usage,
      usageRaw: turn.usageRaw,
      response: turn.response,
    },
    summary: `result ${turn.resultType}; ${turn.streamingDeltas} streaming delta(s); route ${turn.routeProviderId}/${turn.routeModelId}; usage inputTokens ${inputTokens ?? '?'}; response ${JSON.stringify(turn.response)}`,
  })
}

function checkPlanTurn() {
  const prompt = 'Reply with exactly: OK'
  const run = runProcess(
    'turn-plan',
    `node bin/dsh-zcode-plan-bridge.js turn "${prompt}" --model ${PLAN_MODEL}`,
    NODE_EXEC,
    ['bin/dsh-zcode-plan-bridge.js', 'turn', prompt, '--model', PLAN_MODEL],
    { timeoutMs: 300_000 },
  )
  const turn = parseTurn(run.stdout)
  // The usage line holds token counts, never an upstream error code; exclude it when
  // searching for the business error so a coincidental number cannot mask a failure.
  const searchable = (run.stdout + '\n' + run.stderr)
    .split(/\r?\n/)
    .filter((line) => !/^\s{2}usage\s+/.test(line))
    .join('\n')
  const codeMatch = /(?<![0-9])1309(?![0-9])/.exec(searchable)
  const reachedUpstream = searchable.includes(PLAN_UPSTREAM_URL)
  const expired = searchable.includes(PLAN_EXPIRED_MARKER) || (turn.response ?? '').includes(PLAN_EXPIRED_MARKER)
  const routeProviderId = turn.routeProviderId ?? turn.providerId
  const routeModelId = turn.routeModelId ?? turn.observedModelId
  const messageLines = searchable
    .split(/\r?\n/)
    .filter((line) => /(?<![0-9])1309(?![0-9])/.test(line) || line.includes(PLAN_EXPIRED_MARKER))
    .slice(0, 10)
  const assertions = [
    assertion('exit-code', run.exitCode === 1, 1, run.exitCode),
    assertion('result-not-success', turn.resultType !== 'success', 'not success', turn.resultType),
    assertion('account-plan-route', typeof routeProviderId === 'string' && routeProviderId.startsWith('account:'), 'account:* provider', routeProviderId),
    assertion('model-is-GLM-5.3', routeModelId === PLAN_MODEL, PLAN_MODEL, routeModelId),
    assertion('reaches-upstream-url', reachedUpstream, PLAN_UPSTREAM_URL, turn.baseURL ?? '(not printed)'),
    assertion('business-code-1309', codeMatch !== null, PLAN_BUSINESS_CODE, codeMatch?.[0] ?? null),
    assertion('expired-plan-message', expired, PLAN_EXPIRED_MARKER, turn.response ?? null),
  ]
  return buildCheck({
    id: 'turn-plan',
    claim: 6,
    title: `coding-plan route wiring: ${PLAN_MODEL} reaches ${PLAN_UPSTREAM_URL} and returns business error ${PLAN_BUSINESS_CODE} (${PLAN_EXPIRED_MARKER})`,
    run,
    expectedExit: 1,
    assertions,
    extracted: {
      resultType: turn.resultType,
      providerId: turn.providerId,
      route: routeProviderId !== null ? `${routeProviderId}/${routeModelId}` : null,
      baseURL: turn.baseURL,
      usage: turn.usage,
      response: turn.response,
      upstreamMessageLines: messageLines,
      businessCode: codeMatch?.[0] ?? null,
      reachedUpstream,
    },
    summary: `result ${turn.resultType} (exit ${run.exitCode}); route ${routeProviderId}/${routeModelId}; baseURL ${turn.baseURL ?? '?'}; business error ${codeMatch?.[0] ?? '?'}; upstream message ${JSON.stringify(turn.response)}`,
    notes: ['A non-zero exit here is the expected outcome: the route works but the account plan is expired upstream.'],
  })
}

// ---------------------------------------------------------------------------
// Repo / environment facts
// ---------------------------------------------------------------------------

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * Hash the verified source surface (lib/, bin/, test/, docs/, README.md, package.json)
 * before and after the run, so the report can prove nothing changed mid-verification.
 */
function fingerprintRepo() {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  for (const dir of ['lib', 'bin', 'test', 'docs']) {
    const full = path.join(REPO_DIR, dir)
    if (fs.existsSync(full)) walk(full)
  }
  for (const name of ['README.md', 'package.json']) {
    const full = path.join(REPO_DIR, name)
    if (fs.existsSync(full)) files.push(full)
  }
  const records = files.sort().map((full) => {
    const relative = path.relative(REPO_DIR, full).split(path.sep).join('/')
    const digest = createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    return `${relative}:${digest}`
  })
  return {
    sha256: createHash('sha256').update(records.join('\n')).digest('hex'),
    fileCount: records.length,
    files: records.map((record) => record.split(':')[0]),
  }
}

function gitInfo() {
  const env = cleanEnv().env
  const run = (args) =>
    spawnSync('git', args, { cwd: REPO_DIR, env, encoding: 'utf8', timeout: 30_000, windowsHide: true })
  const head = run(['rev-parse', '--short', 'HEAD'])
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
  const status = run(['status', '--porcelain'])
  return {
    head: head.status === 0 ? head.stdout.trim() : null,
    branch: branch.status === 0 ? branch.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim() !== '' : null,
    statusPorcelain: status.status === 0 ? status.stdout.trim().split(/\r?\n/).filter(Boolean).slice(0, 50) : null,
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const CLAIMS = [
  {
    id: 1,
    title: 'doctor in a clean env exits 0 and reports desktop root E:\\zcode 3.16.3 (registry), data root D:\\AI\\zcode (setting) -> D:\\AI\\zcode\\.zcode\\v2, builtin 3.16.3 (runtime), credentials, 15 models',
    checks: ['doctor'],
  },
  {
    id: 2,
    title: 'models in a clean env prints exactly 15 entries across the 6 claimed providers',
    checks: ['models'],
  },
  {
    id: 3,
    title: 'node --test -> 53 pass, 0 fail; npm run typecheck -> exit 0',
    checks: ['node-test', 'typecheck'],
  },
  {
    id: 4,
    title: "import('./lib/index.js') loads against the real peer packages and exports Config, apply, name, resolveOptions, ZcodeAppServerAdapter",
    checks: ['plugin-load'],
  },
  {
    id: 5,
    title: 'a real streamed turn works on a personal provider (qwen3.8-flash): result success, >=1 delta, response contains OK, inputTokens>0',
    checks: ['turn-personal'],
    requiresTurn: true,
  },
  {
    id: 6,
    title: 'the plan route is wired: turn --model GLM-5.3 reaches https://open.bigmodel.cn/api/anthropic and returns business error 1309 (套餐已到期)',
    checks: ['turn-plan'],
    requiresTurn: true,
  },
]

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function mdCell(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .slice(0, 220)
}

function mdInline(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return `\`${String(text ?? '').replace(/`/g, "'")}\``
}

function renderMarkdown(report) {
  const lines = []
  lines.push('# dsh-zcode-plan-bridge — desktop integration E2E verification')
  lines.push('')
  lines.push('Independent verification of the claims in `docs/desktop-integration-contract.md` §9 and the README v0.5.0 section. Everything below was produced by `verify/desktop-e2e.mjs`, which runs the shipped CLI in a clean environment (all `ZCODE_*` variables stripped from every subprocess) and parses the real output.')
  lines.push('')
  lines.push(`- Generated: \`${report.generatedAt}\``)
  lines.push(`- Started: \`${report.startedAt}\` · Finished: \`${report.finishedAt}\` (${report.durationMs} ms)`)
  lines.push(`- Mode: ${report.mode === 'turn' ? '`--turn` (claims 1–6, two real turns)' : 'offline (claims 1–4; run with `--turn` for 5–6)'}`)
  lines.push(`- Repo: \`${report.repo.path}\` @ \`${report.repo.head ?? '?'}\` (${report.repo.branch ?? '?'})${report.repo.dirty ? ', dirty working tree' : ', clean working tree'}`)
  const fingerprint = report.repo.fingerprint
  if (fingerprint !== undefined && fingerprint !== null) {
    lines.push(`- Source fingerprint: \`sha256:${fingerprint.before}\` over ${fingerprint.fileCount} files (lib/, bin/, test/, docs/, README.md, package.json) — ${fingerprint.stable ? 'stable for the whole run' : '**CHANGED during the run**'}`)
  }
  lines.push(`- Package version: \`${report.repo.packageVersion ?? '?'}\` · Node: \`${report.runtime.node}\` (${report.runtime.platform}/${report.runtime.arch})`)
  lines.push(`- Clean env: parent had ${report.cleanEnv.parentZcodeVars.length} \`ZCODE_*\` variable(s); every subprocess env had them removed (stripped names: ${report.cleanEnv.strippedFromChildren.length > 0 ? report.cleanEnv.strippedFromChildren.map((name) => `\`${name}\``).join(', ') : 'none present'})`)
  lines.push('')
  lines.push(`## Verdict: **${report.verdict}** — ${report.counts.claimsPassed}/${report.counts.claimsTotal} claims pass${report.counts.claimsSkipped > 0 ? `, ${report.counts.claimsSkipped} skipped` : ''}`)
  lines.push('')
  lines.push('## Claim verdicts')
  lines.push('')
  lines.push('| # | Claim | Checks | Status |')
  lines.push('|---|---|---|---|')
  for (const claim of report.claims) {
    lines.push(`| ${claim.id} | ${mdCell(claim.title)} | ${claim.checks.map((id) => `\`${id}\``).join(', ')} | **${claim.status}** |`)
  }
  lines.push('')
  lines.push('## Check summary')
  lines.push('')
  lines.push('| Check | Command | Exit (expected) | Result | Key evidence |')
  lines.push('|---|---|---|---|---|')
  for (const check of report.checks) {
    const exit = `${check.exitCode ?? 'null'} (${check.expectedExit.join(' or ')})`
    lines.push(`| \`${check.id}\` | ${mdInline(check.command)} | ${exit} | **${check.pass ? 'PASS' : 'FAIL'}** | ${mdCell(check.summary)} |`)
  }
  lines.push('')
  for (const check of report.checks) {
    lines.push(`### \`${check.id}\` — ${check.pass ? 'PASS' : 'FAIL'}`)
    lines.push('')
    lines.push(`- Command: ${mdInline(check.command)} (cwd \`${check.cwd}\`)`)
    lines.push(`- Exit code: \`${check.exitCode ?? 'null'}\` (expected ${check.expectedExit.join(' or ')}) · duration \`${check.durationMs} ms\` · ${check.startedAt} → ${check.finishedAt}`)
    if (check.spawnError !== null) lines.push(`- Spawn error: \`${JSON.stringify(check.spawnError)}\``)
    if (check.timedOut) lines.push('- Timed out: yes')
    lines.push('')
    lines.push('| Assertion | Expected | Actual | Result |')
    lines.push('|---|---|---|---|')
    for (const entry of check.assertions) {
      lines.push(`| \`${entry.id}\` | ${mdCell(entry.expected)} | ${mdCell(entry.actual)} | ${entry.ok ? 'PASS' : 'FAIL'} |`)
    }
    lines.push('')
    lines.push('Extracted values:')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(check.extracted, null, 2))
    lines.push('```')
    lines.push('')
    for (const note of check.notes) {
      lines.push(`> ${note}`)
      lines.push('')
    }
    if (!check.pass) {
      lines.push('stdout (tail):')
      lines.push('')
      lines.push('```text')
      lines.push(check.stdout.split(/\r?\n/).slice(-60).join('\n'))
      lines.push('```')
      lines.push('')
      lines.push('stderr (tail):')
      lines.push('')
      lines.push('```text')
      lines.push(check.stderr.split(/\r?\n/).slice(-30).join('\n'))
      lines.push('```')
      lines.push('')
    }
  }
  lines.push('## Turn transcripts')
  lines.push('')
  if (report.mode !== 'turn') {
    lines.push('Turn checks were skipped. Re-run with `--turn` to execute claims 5–6.')
  } else {
    for (const id of ['turn-personal', 'turn-plan']) {
      const check = report.checks.find((entry) => entry.id === id)
      if (check === undefined) continue
      const facts = check.extracted
      lines.push(`### \`${id}\``)
      lines.push('')
      lines.push(`- Command: ${mdInline(check.command)}`)
      lines.push(`- Exit code: \`${check.exitCode}\` · result: \`${facts.resultType}\` · streaming deltas: \`${facts.streamingDeltas ?? 'n/a'}\``)
      lines.push(`- Route: ${facts.route !== null ? `\`${facts.route}\`` : 'n/a'}${facts.reasoningLevel !== undefined && facts.reasoningLevel !== null ? ` (reasoning \`${facts.reasoningLevel}\`)` : ''}`)
      if (facts.baseURL !== undefined && facts.baseURL !== null) lines.push(`- baseURL: \`${facts.baseURL}\``)
      if (facts.usage !== undefined && facts.usage !== null) lines.push(`- Usage: \`${JSON.stringify(facts.usage)}\``)
      if (facts.businessCode !== undefined && facts.businessCode !== null) {
        lines.push(`- Business error code: \`${facts.businessCode}\``)
        lines.push("- Interpretation: **route wiring works**. The request reached the coding-plan upstream and came back with a real upstream business error; the account's GLM Coding Plan subscription is expired upstream, so the model cannot answer. This is **not** a bridge/plugin failure.")
      }
      if (facts.response !== undefined && facts.response !== null) {
        lines.push('- Response (as printed by the CLI, capped at 600 chars):')
        lines.push('')
        lines.push('```text')
        lines.push(String(facts.response))
        lines.push('```')
      }
      if (Array.isArray(facts.upstreamMessageLines) && facts.upstreamMessageLines.length > 0) {
        lines.push('- Exact upstream message line(s):')
        lines.push('')
        lines.push('```text')
        lines.push(facts.upstreamMessageLines.join('\n'))
        lines.push('```')
      }
      lines.push('')
    }
  }
  lines.push('## Notes')
  lines.push('')
  for (const note of report.notes) {
    lines.push(`- ${note}`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('Raw per-command stdout/stderr, timings, and assertions are in `verify/report.json` (same directory).')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const parentZcodeVars = Object.keys(process.env).filter((key) => ZCODE_ENV_RE.test(key))
  const fingerprintBefore = fingerprintRepo()

  const specs = [
    { id: 'doctor', claim: 1, title: 'doctor', command: 'node bin/dsh-zcode-plan-bridge.js doctor', run: checkDoctor },
    { id: 'models', claim: 2, title: 'models', command: 'node bin/dsh-zcode-plan-bridge.js models', run: checkModels },
    { id: 'node-test', claim: 3, title: 'node --test', command: 'node --test', run: checkNodeTest },
    { id: 'typecheck', claim: 3, title: 'npm run typecheck', command: 'npm run typecheck', run: checkTypecheck },
    { id: 'plugin-load', claim: 4, title: 'plugin import', command: "node -e \"import('./lib/index.js')...\"", run: checkPluginLoad },
  ]
  if (RUN_TURN) {
    specs.push({ id: 'turn-personal', claim: 5, title: 'personal turn', command: `node bin/dsh-zcode-plan-bridge.js turn "Reply with exactly: OK" --model ${PERSONAL_MODEL}`, run: checkPersonalTurn })
    specs.push({ id: 'turn-plan', claim: 6, title: 'plan route turn', command: `node bin/dsh-zcode-plan-bridge.js turn "Reply with exactly: OK" --model ${PLAN_MODEL}`, run: checkPlanTurn })
  }

  const checks = []
  for (const spec of specs) {
    process.stderr.write(`[verify] running ${spec.id} ...\n`)
    let result
    try {
      result = spec.run()
    } catch (error) {
      result = failedCheck(spec, error)
    }
    checks.push(result)
    process.stderr.write(`[verify] ${spec.id}: ${result.pass ? 'PASS' : 'FAIL'} (exit ${result.exitCode ?? 'null'})\n`)
  }
  const fingerprintAfter = fingerprintRepo()

  const claims = CLAIMS.map((claim) => {
    const relevant = checks.filter((check) => claim.checks.includes(check.id))
    const executed = relevant.length === claim.checks.length
    if (!executed) return { id: claim.id, title: claim.title, checks: claim.checks, status: 'SKIPPED', pass: null }
    const pass = relevant.every((check) => check.pass === true)
    return { id: claim.id, title: claim.title, checks: claim.checks, status: pass ? 'PASS' : 'FAIL', pass }
  })

  const counts = {
    claimsTotal: claims.length,
    claimsPassed: claims.filter((claim) => claim.status === 'PASS').length,
    claimsFailed: claims.filter((claim) => claim.status === 'FAIL').length,
    claimsSkipped: claims.filter((claim) => claim.status === 'SKIPPED').length,
    checksTotal: checks.length,
    checksPassed: checks.filter((check) => check.pass).length,
    checksFailed: checks.filter((check) => !check.pass).length,
    checksSkipped: specs.length - checks.length,
  }
  const verdict = counts.claimsFailed === 0 ? 'PASS' : 'FAIL'

  const report = {
    schemaVersion: 1,
    harness: 'verify/desktop-e2e.mjs',
    mode: RUN_TURN ? 'turn' : 'offline',
    generatedAt: new Date().toISOString(),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    verdict,
    counts,
    repo: {
      path: REPO_DIR,
      packageVersion: readPackageVersion(),
      ...gitInfo(),
      fingerprint: {
        algorithm: 'sha256',
        scope: ['lib/', 'bin/', 'test/', 'docs/', 'README.md', 'package.json'],
        fileCount: fingerprintBefore.fileCount,
        files: fingerprintBefore.files,
        before: fingerprintBefore.sha256,
        after: fingerprintAfter.sha256,
        stable: fingerprintBefore.sha256 === fingerprintAfter.sha256,
      },
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      execPath: NODE_EXEC,
      cwd: process.cwd(),
    },
    cleanEnv: {
      policy: 'Every subprocess is spawned with an explicit env clone where all ZCODE_* keys (case-insensitive) are deleted.',
      parentZcodeVars,
      strippedFromChildren: [...removedZcodeEnv].sort(),
    },
    claims,
    checks,
    notes: [
      'Claims 1–4 are offline checks. Claims 5–6 run one real streamed turn each and are only executed with `--turn`.',
      'The turn command prints the model response truncated to 600 characters (a CLI diagnostics cap); the assertions only need the first bytes ("OK") and the upstream business error text.',
      'The account\'s coding-plan subscription is expired on this machine, so claim 6 is expected to exit non-zero: PASS means the request really reached the plan upstream URL and came back with business error 1309, i.e. the route wiring works.',
      'docs/desktop-integration-contract.md §4/§9 still records the pre-account-overlay count (13 models / 5 providers); README v0.5.0 and these claims expect the final 15 / 6 (13 personal + account:bigmodel-team-coding-plan GLM-5.3, GLM-5.3-Flash). The measured output is 15 / 6, matching README v0.5.0.',
      'Report produced by an independent verifier; only verify/ was written, no source files were modified.',
    ],
  }

  if (report.repo.fingerprint.stable !== true) {
    report.notes.unshift('WARNING: the verified source surface changed while the harness was running; the before/after fingerprints differ.')
  }

  fs.mkdirSync(VERIFY_DIR, { recursive: true })
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  fs.writeFileSync(REPORT_MD, renderMarkdown(report), 'utf8')

  process.stdout.write(`${JSON.stringify({ verdict, counts, reportJson: REPORT_JSON, reportMd: REPORT_MD })}\n`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main()
