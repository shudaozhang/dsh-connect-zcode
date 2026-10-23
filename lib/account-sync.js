/**
 * Register the desktop client's coding-plan account provider with the CLI app-server.
 *
 * Why this exists
 * ---------------
 * The ZCode desktop client's CLI serves two kinds of providers:
 *
 *   1. *personal* providers, read from `provider_config.json` (API-key based). The CLI
 *      reports them in `session/create` on its own -- nothing to do here.
 *   2. *account* (coding-plan) providers, declared by the builtin release as
 *      `account:<family>-<kind>-coding-plan` with `access.type = 'zhipu-account'`.
 *      The CLI only activates those when a host hands it an account-config snapshot:
 *      `provider/updateAccountConfig` -> `provider/refreshRegistry`.
 *
 * The upstream bridge dropped account injection because the npm build refuses it
 * ("Standalone Account 由本进程管理，不接收 Host 覆盖"). That is a property of the
 * *npm* build with a standalone account source. Measured 2026-10-23 against the
 * desktop bundle (`E:\zcode\resources\glm\zcode.cjs`, CLI 0.17.0): the RPC is
 * accepted, the registry picks the provider up, `session/create` reports its models
 * (13 -> 15 on this machine) and a turn reaches the real plan endpoint over SSE.
 *
 * Wire schema (reverse-engineered from the bundle, strict Zod objects -- extra keys
 * are rejected):
 *
 *   provider/updateAccountConfig params = {
 *     revision: string,                        // any non-empty id; identical revision = no-op
 *     basedOnZCodeBuiltinRevision: string,     // `zcode-builtin:<revision>:<sha256(realpath file)>`
 *     providers: Record<providerId, {          // strict: only these two keys
 *       builtinModelIds?: string[],
 *       access?: { type: string, entitled?: boolean } | null,
 *     }>,
 *     states?: Record<providerId, {            // required for zhipu-account + entitled
 *       availability: 'available' | 'pending' | 'unavailable' | 'unknown',
 *       current: boolean,
 *       entitled: boolean,
 *     }>,
 *   }
 *
 *   provider/refreshRegistry params = { reason: string }
 *
 * Everything in this module is offline and side-effect free except
 * {@link applyDesktopAccountConfig}, which performs exactly those two RPCs.
 *
 * @module lib/account-sync
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { resolveDesktopBuiltinConfig } from './zcode-runtime.js'

/** RPC method that installs the account-provider snapshot. */
const UPDATE_ACCOUNT_CONFIG = 'provider/updateAccountConfig'

/** RPC method that rebuilds the CLI's provider registry from its sources. */
const REFRESH_REGISTRY = 'provider/refreshRegistry'

/** Provider-id prefix that marks an account (coding-plan) provider. */
const ACCOUNT_PROVIDER_PREFIX = 'account:'

/** Account access type that carries plan entitlements. */
const ACCOUNT_ACCESS_TYPE = 'zhipu-account'

/**
 * One provider rule as declared by a builtin release.
 *
 * @typedef {object} BuiltinProviderRule
 * @property {string} providerId
 * @property {string} [providerName]
 * @property {object} config
 * @property {{ type?: string, accountType?: string, mode?: string }} [config.access]
 * @property {string} [config.visibility] `hidden` marks off-peak / highspeed card rules.
 * @property {string[]} [config.builtinModelIds]
 */

/**
 * @typedef {{ request: (method: string, params: unknown, timeoutMs: number) => Promise<any> }} RpcRequester
 *
 * @typedef {object} AccountConfigSnapshot
 * @property {string} revision
 * @property {string} basedOnZCodeBuiltinRevision
 * @property {Record<string, { builtinModelIds?: string[], access?: { type: string, entitled?: boolean } | null }>} providers
 * @property {Record<string, { availability: 'available' | 'pending' | 'unavailable' | 'unknown', current: boolean, entitled: boolean }>} states
 * @property {string[]} providerIds Provider ids in the order they were registered.
 */

/**
 * @param {unknown} value Candidate field.
 * @returns {string} The trimmed string, or ''.
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read the builtin release the CLI was told to use and return its provider rules.
 *
 * @param {string} builtinPath Absolute path of `zcode-builtin.json`.
 * @returns {{ revision: unknown, rules: BuiltinProviderRule[] } | undefined}
 */
export function readBuiltinRelease(builtinPath) {
  const file = text(builtinPath)
  if (file === '') return undefined
  /** @type {any} */
  let release
  try {
    release = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  const rules = release?.config?.providerConfigRules?.providerRules
  return {
    revision: release?.revision,
    rules: Array.isArray(rules) ? rules : [],
  }
}

/**
 * Compute the `basedOnZCodeBuiltinRevision` the CLI expects.
 *
 * Mirrors the CLI's own `computeBuiltinRevision`: `zcode-builtin:<revision>:<sha256 of
 * the resolved path>`. The path must be the same one handed to the CLI through
 * `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`, otherwise the snapshot is considered stale and
 * silently ignored.
 *
 * @param {string} builtinPath Absolute path of the builtin release.
 * @param {unknown} revision The `revision` field inside that release.
 * @returns {string} The revision token, or '' when it cannot be computed.
 */
export function builtinRevisionToken(builtinPath, revision) {
  const file = text(builtinPath)
  if (file === '') return ''
  try {
    const hash = createHash('sha256').update(path.resolve(file)).digest('hex')
    return `zcode-builtin:${String(revision)}:${hash}`
  } catch {
    return ''
  }
}

/**
 * Pick the account provider this machine's plan is linked to.
 *
 * The desktop stores the linked account credential under
 * `account-provider:coding-plan:<providerId>:account:<identity>:api-key` in
 * `credentials.json`, so the credential key names the exact provider to activate.
 * Reading it is deliberately best-effort: a missing/unreadable file falls back to the
 * first zhipu-account provider declared by the release.
 *
 * @param {readonly BuiltinProviderRule[]} rules Builtin provider rules.
 * @param {readonly string[]} [credentialKeys] Keys of the decrypted credentials file.
 * @returns {BuiltinProviderRule | undefined} The rule to activate.
 */
/**
 * Plan kinds, in the order the bridge registers them.
 *
 * Ordering matters: `collapseCatalog()` keeps the *first* route it sees for a model id, so
 * the first provider here wins for shared ids. Start Plan goes first because it is the plan
 * the desktop client actually shows quota for on a free/dev-day account (measured: the
 * coding-plan route answered `1309 套餐已到期` while Start Plan served the same GLM-5.3-Flash
 * successfully). A user who wants the coding plan to win can pin the exact route with
 * `cliModels` (`cliModelId: "account:bigmodel-team-coding-plan/GLM-5.3-Flash"`).
 */
const PLAN_RANK = ['start-plan', 'individual-coding-plan', 'team-coding-plan']

/**
 * @param {BuiltinProviderRule} rule Candidate rule.
 * @returns {number} Sort rank (lower wins).
 */
function planRank(rule) {
  const mode = text(rule?.config?.access?.mode)
  const index = PLAN_RANK.indexOf(mode)
  return index === -1 ? PLAN_RANK.length : index
}

/**
 * Pick the account (plan) providers to register with the CLI.
 *
 * The desktop client can hold several plans at once (this machine has a coding plan and a
 * Start Plan on the same account). Registering only the credential-linked one — the earlier
 * behaviour — meant the bridge could spend one pool but not the other. Every non-hidden
 * `zhipu-account` provider declared by the release is therefore registered; the CLI then
 * reports all of their models and the user picks with `enabledModelIds`.
 *
 * Rules carrying `config.visibility === 'hidden'` (off-peak, highspeed cards) are skipped:
 * the desktop UI hides them too, and they are not plans a user chooses between.
 *
 * @param {readonly BuiltinProviderRule[]} rules Builtin provider rules.
 * @param {readonly string[]} [credentialKeys] Keys of the decrypted credentials file.
 * @returns {BuiltinProviderRule[]} Rules to activate, preferred first.
 */
export function pickAccountProviders(rules, credentialKeys = [], activeFamily = '') {
  const accountRules = rules.filter(
    (rule) => text(rule?.providerId).startsWith(ACCOUNT_PROVIDER_PREFIX)
      && text(rule?.config?.access?.type) === ACCOUNT_ACCESS_TYPE
      && text(rule?.config?.visibility) !== 'hidden',
  )
  if (accountRules.length === 0) return []
  // The account belongs to one provider family (z.ai vs bigmodel); routes of the other
  // family have no credentials and only add dead entries to the picker.
  const family = text(activeFamily)
  const familyRules = family === ''
    ? accountRules
    : accountRules.filter((rule) => text(rule?.config?.access?.accountType) === family)
  const candidates = familyRules.length !== 0 ? familyRules : accountRules
  // A credential key names the plan the desktop actually linked; keep that as a tiebreaker
  // inside the same rank (e.g. two coding-plan variants).
  /** @type {Set<string>} */
  const linked = new Set()
  for (const key of credentialKeys) {
    const match = /^account-provider:coding-plan:(account:[^:]+):account:/u.exec(text(key))
    if (match !== null) linked.add(match[1])
  }
  return [...candidates].sort((a, b) => {
    const byRank = planRank(a) - planRank(b)
    if (byRank !== 0) return byRank
    const aLinked = linked.has(a.providerId) ? 0 : 1
    const bLinked = linked.has(b.providerId) ? 0 : 1
    return aLinked - bLinked
  })
}

/**
 * Read the account family the desktop client is signed in to ('' when unknown).
 *
 * @param {object | undefined} credentials Decrypted credentials.
 * @returns {string} `zai`, `bigmodel`, or ''.
 */
export function activeAccountFamily(credentials) {
  if (credentials === null || typeof credentials !== 'object') return ''
  return text(/** @type {Record<string, unknown>} */ (credentials)['oauth:active_provider'])
}

/**
 * Pick the single best account provider (kept for callers that only need one).
 *
 * @param {readonly BuiltinProviderRule[]} rules Builtin provider rules.
 * @param {readonly string[]} [credentialKeys] Keys of the decrypted credentials file.
 * @returns {BuiltinProviderRule | undefined} The preferred rule.
 */
export function pickAccountProvider(rules, credentialKeys = []) {
  return pickAccountProviders(rules, credentialKeys)[0]
}

/**
 * Build the account-config snapshot for one or more providers.
 *
 * The providers map is keyed by provider id, so several plans (Start Plan + coding plan)
 * travel in a single snapshot and a single registry refresh.
 *
 * @param {object} input
 * @param {BuiltinProviderRule | readonly BuiltinProviderRule[]} input.rule One rule, or the
 *   list of rules to activate (order is preserved in the snapshot).
 * @param {string} input.builtinPath Builtin release path (for the revision token).
 * @param {unknown} input.builtinReleaseRevision `revision` inside that release.
 * @param {string} [input.revisionSuffix] Extra id so repeated calls differ (a snapshot
 *   with an unchanged revision is ignored by the CLI).
 * @returns {AccountConfigSnapshot | undefined} The snapshot, or undefined when no rule
 *   can be expressed (missing provider id / revision token).
 */
export function buildAccountConfigSnapshot(input) {
  const rules = Array.isArray(input?.rule) ? input.rule : input?.rule === undefined ? [] : [input.rule]
  const basedOn = builtinRevisionToken(input.builtinPath, input.builtinReleaseRevision)
  if (basedOn === '') return undefined
  /** @type {AccountConfigSnapshot['providers']} */
  const providers = {}
  /** @type {AccountConfigSnapshot['states']} */
  const states = {}
  /** @type {string[]} */
  const providerIds = []
  for (const rule of rules) {
    const providerId = text(rule?.providerId)
    if (providerId === '' || providers[providerId] !== undefined) continue
    const modelIds = Array.isArray(rule?.config?.builtinModelIds)
      ? rule.config.builtinModelIds.filter((/** @type {string} */ id) => text(id) !== '')
      : []
    /** @type {{ builtinModelIds?: string[], access?: { type: string, entitled?: boolean } | null }} */
    const provider = { access: { type: ACCOUNT_ACCESS_TYPE, entitled: true } }
    if (modelIds.length !== 0) provider.builtinModelIds = modelIds
    providers[providerId] = provider
    states[providerId] = { availability: 'available', current: true, entitled: true }
    providerIds.push(providerId)
  }
  if (providerIds.length === 0) return undefined
  const suffix = text(input?.revisionSuffix) || String(Date.now())
  return {
    revision: `dsh-connect-zcode:${providerIds.join('+')}:${suffix}`,
    basedOnZCodeBuiltinRevision: basedOn,
    providers,
    states,
    providerIds,
  }
}

/**
 * Pick the credential that signs a model request for one provider route.
 *
 * Measured auth chain (2026-10-23, desktop bundle + BigModel plan):
 *   - `account:*` (coding-plan) routes are signed with the **account-provider api key**
 *     stored as `account-provider:coding-plan:<providerId>:account:<identity>:api-key`.
 *     Answering `interaction/requestProviderRuntimeHeaders` with `zcodejwttoken` instead
 *     fails at the signing step with "Client signing requires an API Key or Project Access
 *     Token."; answering with the api key reaches the provider and returns its real
 *     business answer (e.g. `1309 套餐已到期`).
 *   - `zai` Start Plan routes are signed with `zcodejwttoken` (the upstream bridge's
 *     measured behaviour), so that stays the fallback when no account key exists.
 *
 * The request carries `providerId`, so the choice is per-route and does not guess from
 * `oauth:active_provider`.
 *
 * @param {object | undefined} credentials Decrypted credentials.
 * @param {string} providerId Provider route id from the request params.
 * @returns {{ apiKey: string, source: 'account-provider' | 'zcodejwt' } | undefined}
 *   The credential to hand the agent, or undefined when neither is present.
 */
export function selectRuntimeAuth(credentials, providerId) {
  const keys = credentialKeys(credentials)
  const wanted = text(providerId)
  if (wanted !== '') {
    // `account-provider:coding-plan:<providerId>:account:<identity>:api-key`
    const prefix = `account-provider:coding-plan:${wanted}:account:`
    for (const key of keys) {
      if (!key.startsWith(prefix) || !key.endsWith(':api-key')) continue
      const value = text(/** @type {Record<string, unknown>} */ (credentials)[key])
      if (value !== '') return { apiKey: value, source: 'account-provider' }
    }
  }
  const jwt = text(/** @type {Record<string, unknown>} */ (credentials)?.zcodejwttoken)
  if (jwt !== '') return { apiKey: jwt, source: 'zcodejwt' }
  return undefined
}

/**
 * Read the decrypted credentials object's keys, tolerating every failure mode.
 *
 * @param {object | undefined} credentials Decrypted credentials (see lib/credentials.js).
 * @returns {string[]} Key names, or [].
 */
export function credentialKeys(credentials) {
  if (credentials === null || typeof credentials !== 'object') return []
  return Object.keys(/** @type {Record<string, unknown>} */ (credentials))
}

/**
 * Build the account-config snapshot for the desktop client, if it has a plan.
 *
 * @param {import('./zcode-runtime.js').ZcodeDesktop | undefined} desktop
 *   Resolved desktop install.
 * @param {string} dataRoot Resolved ZCode data root (`<dataBaseDir>/.zcode/v2`).
 * @param {object | undefined} [credentials] Decrypted credentials, used to pick the
 *   exact linked plan provider. Optional: without it the first plan rule is used.
 * @returns {AccountConfigSnapshot | undefined} Snapshot, or undefined when this
 *   installation declares no account provider (nothing to inject).
 */
export function buildDesktopAccountConfig(desktop, dataRoot, credentials) {
  // The revision token has to name the *same* release the CLI was handed through
  // ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, otherwise the snapshot is silently ignored
  // (`status: received` but the registry keeps the old providers). `desktopCliEnv()` and
  // this function must therefore agree, which is why both go through
  // resolveDesktopBuiltinConfig().
  const resolved = desktop === undefined ? undefined : resolveDesktopBuiltinConfig(desktop, dataRoot)
  const builtinPath = text(resolved?.path) !== '' ? text(resolved?.path) : text(desktop?.builtinProviderConfigPath)
  if (builtinPath === '') return undefined
  const release = readBuiltinRelease(builtinPath)
  if (release === undefined || release.rules.length === 0) return undefined
  // Every non-hidden plan the account holds travels in one snapshot: the desktop client can
  // keep a coding plan and a Start Plan side by side, and registering only one of them
  // meant one quota pool stayed unreachable (see pickAccountProviders()).
  const rules = pickAccountProviders(release.rules, credentialKeys(credentials), activeAccountFamily(credentials))
  if (rules.length === 0) return undefined
  // A stable-ish suffix: the same snapshot content does not need re-sending, but a
  // restarted CLI starts from "empty-account-config-v1", so the revision must differ
  // from that placeholder and stay non-empty.
  return buildAccountConfigSnapshot({
    rule: rules,
    builtinPath,
    builtinReleaseRevision: release.revision,
    revisionSuffix: `${Date.now().toString(36)}`,
  })
}

/**
 * Install the account-provider snapshot and rebuild the CLI registry.
 *
 * Idempotent per process: callers should guard with their own "already synced" flag.
 * Every failure is logged and swallowed -- a missing plan must not stop the bridge from
 * serving the personal providers.
 *
 * @param {RpcRequester} client App-server JSON-RPC client.
 * @param {import('./zcode-runtime.js').ZcodeDesktop | undefined} desktop
 *   Resolved desktop install (only the builtin release path is needed here).
 * @param {string} dataRoot Resolved data root.
 * @param {object | undefined} credentials Decrypted credentials (optional).
 * @param {{ info?: (message: string) => void, warn?: (message: string) => void } | undefined} [logger]
 * @param {number} [timeoutMs] Per-request timeout.
 * @returns {Promise<boolean>} True when the snapshot was accepted and the registry refreshed.
 */
export async function applyDesktopAccountConfig(client, desktop, dataRoot, credentials, logger, timeoutMs = 30000) {
  /** @type {AccountConfigSnapshot | undefined} */
  let snapshot
  try {
    snapshot = buildDesktopAccountConfig(desktop, dataRoot, credentials)
  } catch (/** @type {any} */ error) {
    logger?.warn?.(`zcode: account config snapshot could not be built (${error?.message ?? error})`)
    return false
  }
  if (snapshot === undefined) {
    logger?.info?.('zcode: this desktop install declares no plan (account) provider; serving personal providers only')
    return false
  }
  const providerIds = snapshot.providerIds.join(', ')
  try {
    const applied = await client.request(UPDATE_ACCOUNT_CONFIG, {
      revision: snapshot.revision,
      basedOnZCodeBuiltinRevision: snapshot.basedOnZCodeBuiltinRevision,
      providers: snapshot.providers,
      states: snapshot.states,
    }, timeoutMs)
    logger?.info?.(`zcode: account providers registered: ${providerIds} (${JSON.stringify(applied)})`)
  } catch (/** @type {any} */ error) {
    // Standalone-mode builds answer "Standalone Account 由本进程管理，不接收 Host 覆盖".
    // That is expected on the npm CLI; the personal catalogue still works there.
    logger?.warn?.(`zcode: account providers were refused (${error?.message ?? error})`)
    return false
  }
  try {
    await client.request(REFRESH_REGISTRY, { reason: 'dsh-connect-zcode' }, timeoutMs)
    logger?.info?.(`zcode: provider registry refreshed after registering ${providerIds}`)
    return true
  } catch (/** @type {any} */ error) {
    logger?.warn?.(`zcode: provider/refreshRegistry failed (${error?.message ?? error})`)
    return false
  }
}

