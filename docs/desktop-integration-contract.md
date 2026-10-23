# Desktop-client integration contract (dsh-zcode-plan-bridge)

Status: agreed design for v0.5.0 — "connect to the locally installed ZCode **desktop client**".

Everything below is measured on this machine (2026-10-23), not assumed.

## 1. What the desktop client is

| item | value |
|---|---|
| install root | `E:\zcode` (custom path; **not** `%LOCALAPPDATA%\Programs\ZCode`) |
| desktop version | `3.16.3` (registry `HKCU\...\Uninstall` → `DisplayName: "ZCode 3.16.3"`, `UninstallString: "E:\zcode\Uninstall ZCode.exe" /currentuser`) |
| electron-node launcher | `E:\zcode\ZCode.exe` |
| bundled CLI bundle | `E:\zcode\resources\glm\zcode.cjs` (15 MB, CLI version `0.17.0`) |
| bundled builtin provider config | `E:\zcode\resources\config\provider\zcode-builtin.json` (revision 33) |
| app asar | `E:\zcode\resources\app.asar` |

The desktop main process spawns the CLI exactly like this (read from `Win32_Process.CommandLine`):

```
E:\zcode\ZCode.exe  E:\zcode\resources\glm\zcode.cjs  app-server --stdio --surface desktop
```

and it passes `ZCODE_*` env vars (proved: without them the CLI exits with
`无法定位 CLI ZCode Built-in Provider Config`).

## 2. Why the current bridge cannot connect

`lib/zcode-runtime.js` only looks for the CLI at
`%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`, `%ProgramFiles%\ZCode\...`,
macOS/Linux paths, or an npm-global `zcode-app-cli`. A custom install root such as
`E:\zcode` is invisible, so `locateZcodeCli()` returns `''`.

Even when pointed at `E:\zcode\resources\glm\zcode.cjs`, the desktop bundle **refuses to
start** because it resolves its builtin provider config from the entrypoint:

```js
// decompiled from zcode.cjs (function resolveBundledZCodeBuiltinProviderConfig)
const dir = path.dirname(fs.realpathSync(path.resolve(entrypoint)))
const candidates = [
  path.join(dir, 'provider', 'zcode-builtin.json'),
  path.resolve(dir, '../../../../../config/provider/zcode-builtin.json'),
]
```

For `E:\zcode\resources\glm\zcode.cjs` those are
`E:\zcode\resources\glm\provider\zcode-builtin.json` (absent) and
`E:\config\provider\zcode-builtin.json` (absent) → exit code 1.

The desktop avoids this by exporting env vars. Measured contract (decompiled
`prepareCliProviderRuntimeEnv`):

| env var | meaning |
|---|---|
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | builtin provider release json |
| `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` | personal provider json (default `<dataBaseDir>/.zcode/v2/provider_config.json`) |
| `ZCODE_DATA_BASE_DIR` | data root base (default `os.homedir()`) |
| `ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE` | alternative "bundled" slot (not needed) |

If **both** builtin and personal are set, the CLI returns them verbatim; otherwise it
resolves the builtin file itself and computes the personal path from `dataBaseDir`.

## 3. Data root: it is NOT always `~/.zcode`

`C:\Users\25293\.zcode\v2\setting.json` contains `"dataBaseDir": "D:\\AI\\zcode"`.
So on this machine the live data root is `D:\AI\zcode\.zcode\v2`:

- `credentials.json` — fresh (2026-10-23 21:36), 3962 B, holds `zcodejwttoken`,
  `oauth:bigmodel:access_token`, `account-provider:coding-plan:account:bigmodel-team-coding-plan:...`
- `provider_config.json` — the personal provider rules (the desktop's "personal providers")
- `config.json` — opencode-style provider map (includes `builtin:bigmodel-coding-plan`, enabled)
- `coding-plan-cache.json` — `builtin:bigmodel-coding-plan: available`
- `runtime/provider/windows-x86_64/<version>/endpoint-*/zcode-builtin.json` — downloaded releases

`~/.zcode/v2` still exists but is stale (June 2026) and has **no** `provider_config.json`.

Consequence: the bridge must resolve `dataBaseDir` from `~/.zcode/v2/setting.json`
(configurable override wins), then read credentials / personal config / runtime releases
from `<dataBaseDir>/.zcode/v2`, falling back to `~/.zcode/v2` when a file is absent.

## 4. What the CLI actually serves (measured)

With the correct env (`ZCODE_DATA_BASE_DIR=D:\AI\zcode`,
`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=<runtime release for 3.16.3>`,
`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=D:\AI\zcode\.zcode\v2\provider_config.json`),
`session/create` returns **13 models / 5 providers** — these are the *personal* providers
only. The account overlay in §10 adds `account:bigmodel-team-coding-plan` with GLM-5.3 /
GLM-5.3-Flash, bringing the final catalogue to **15 models / 6 providers**:

| providerId | providerName | models |
|---|---|---|
| `new-provider-3` | qwen-tt | qwen3.8-max-0902, qwen3.8-flash, deepseek-v4.1-flash-1017 |
| `new-provider-4` | sanqian-gpt | gpt-6-astra, gpt-6.1-sol, gpt-6-luna |
| `new-provider-5` | sanqian-cc | claude-fable-5-1, claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5 |
| `deepseek` | DeepSeek | deepseek-flash, deepseek-v4-pro |
| `new-provider` | longcat | LongCat-2.5-Preview |

The CLI runs in **standalone** mode, so:
- `provider/updateAccountConfig` is refused
  (`Standalone Account 由本进程管理，不接收 Host 覆盖`) — the bridge must not try to inject.
- `session/setModel` on a `builtin:*`/`account:*` route fails with
  `Provider Registry 中不存在 Model`, i.e. the coding-plan routes in `config.json`
  are **not** in the CLI registry. Advertise only what `session/create` reports.
- `provider/refreshRegistry` works but does not add account routes.

So the honest target for v0.5.0: expose exactly the desktop client's configured
providers/models through DSH, launched exactly the way the desktop launches the CLI.

## 5. Required module API (owner: lib/zcode-runtime.js)

All functions pure/offline (no spawn) unless stated, Node built-ins only, JSDoc typed
(`npm run typecheck` must pass), no new dependencies.

```js
/** @typedef {object} ZcodeDesktop
 * @property {string} root                 install root, e.g. 'E:\zcode'
 * @property {string} launcherPath         '<root>\ZCode.exe'
 * @property {string} cliPath              '<root>\resources\glm\zcode.cjs'
 * @property {string} version              desktop version, e.g. '3.16.3'
 * @property {string} resourcesPath        '<root>\resources'
 * @property {string | undefined} builtinProviderConfigPath  builtin release json
 * @property {'config' | 'registry' | 'runtime'} discoverySource
 */

/** @returns {ZcodeDesktop | undefined} */
export function locateZcodeDesktop(configuredRoot)

/** @typedef {object} ZcodeDataRoot
 * @property {string} dataBaseDir   e.g. 'D:\AI\zcode'
 * @property {string} dataRoot      '<dataBaseDir>\.zcode\v2'
 * @property {string} settingPath   '~/.zcode/v2/setting.json'
 * @property {'configured' | 'setting' | 'home'} source
 */

/** @returns {ZcodeDataRoot} */
export function resolveZcodeDataRoot(configuredDataBaseDir)

/** Env the desktop CLI needs; only the keys that apply. */
/** @returns {Record<string,string>} */
export function desktopCliEnv(desktop, dataRoot)

/** Pick the builtin release: prefer the downloaded runtime release matching the
 *  desktop version, else the bundled resources copy, else undefined. */
export function resolveDesktopBuiltinConfig(desktop, dataRoot)
```

`locateZcodeCli()` keeps working for the npm CLI, but must gain the desktop
candidates (`<root>/resources/glm/zcode.cjs` from `locateZcodeDesktop`).

## 6. Spawn contract (owner: lib/app-server.js)

```
desktop mode:  spawn(launcherPath, [cliPath, 'app-server', '--stdio', '--surface', 'desktop', '--no-color'],
                     { env: whitelist ∪ desktopCliEnv(...), cwd: cliCwd || homedir })
npm-CLI mode:  spawn(zcodeCliNode, [cliPath, 'app-server', '--surface', 'terminal', '--no-color'],
                     { env: whitelist, ... })     // unchanged; no ZCODE_* injection
```

Config additions (`lib/index.js`):

| field | default | meaning |
|---|---|---|
| `zcodeClientRoot` | `''` | desktop install root override ('' = auto-detect) |
| `zcodeLaunchMode` | `'auto'` | `auto` → desktop launcher when a desktop install is found, else plain node; `desktop` / `node` force one |

Keep `zcodeCliPath`, `zcodeCliNode`, `zcodeDataBaseDir`, `childEnvAllow` semantics.

## 7. Credentials (owner: lib/credentials.js)

Resolve `credentials.json` from `resolveZcodeDataRoot(...).dataRoot` first, then
`~/.zcode/v2/credentials.json`. Decryption is unchanged (`enc:v1:` AES-256-GCM,
`ZCODE_CREDENTIAL_SECRET` or the documented fallback).

## 8. Diagnostics (owner: lib/diagnostics.js)

`doctor` must report, without any env pre-set by the caller:
1. desktop client found/not found + root + version + discovery source,
2. resolved data root + which file each artifact came from,
3. builtin release used and why,
4. the env that will be passed to the CLI,
5. the model catalogue (13 entries on this machine).
`models` / `protocol` / `turn` must work with no manual env.

## 9. Acceptance

1. `node bin/dsh-zcode-plan-bridge.js doctor` (clean env) → all preconditions pass,
   desktop client detected at `E:\zcode`, data root `D:\AI\zcode`.
2. `node bin/dsh-zcode-plan-bridge.js models` → 15 models, 6 providers.
3. `node bin/dsh-zcode-plan-bridge.js turn "reply OK"` → real streamed turn succeeds
   (costs quota; run once, record evidence).
4. `npm test` and `npm run typecheck` pass.
5. Plugin loads in DSH profile and lists the models under provider `zcode-cli`.

## 10. Measured results (2026-10-23, this machine)

| check | result |
|---|---|
| `doctor` (clean env) | PASS — desktop `E:\zcode` 3.16.3 (registry), data root `D:\AI\zcode` (setting), builtin `3.16.3 (runtime)`, credentials `D:\AI\zcode\.zcode\v2\credentials.json` (204-char JWT) |
| `models` | PASS — 15 entries / 6 providers |
| `turn --model qwen3.8-flash` | PASS — `result success`, 3 streaming deltas, `inputTokens 20862 / outputTokens 16`, reply `OK` |
| `turn --model GLM-5.3` (plan route) | Route wiring PASS, upstream business error `1309 您的GLM Coding Plan套餐已到期` — **the account's plan is expired; not a bridge defect** |
| `npm test` | PASS — 53/53 |
| `npm run typecheck` | PASS — 0 errors |
| plugin module import with real peers | PASS — exports `Config, apply, name, resolveOptions, ZcodeAppServerAdapter` |

### Two findings that the contract did not anticipate

1. **`ELECTRON_RUN_AS_NODE=1` is mandatory for the launcher.** `ZCode.exe` is the Electron
   binary; without the flag it boots the GUI path (single-instance forwarding) and exits 0,
   so the app-server never starts. `desktopCliEnv()` now returns it and both spawn sites set
   it explicitly (the DSH host happens to carry it, which can mask the bug — never rely on
   inheritance).
2. **The signing credential is per route.** `account:*` plan routes must be signed with
   `account-provider:coding-plan:<providerId>:account:<id>:api-key` from `credentials.json`;
   answering with `zcodejwttoken` fails at `Client signing requires an API Key or Project
   Access Token`. z.ai Start Plan routes still use `zcodejwttoken`. The request carries
   `providerId`, so `selectRuntimeAuth(credentials, providerId)` decides per call.

Also confirmed: the desktop CLI is **not** in standalone mode, so
`provider/updateAccountConfig` is accepted (contradicting the upstream npm-CLI finding), and
the account snapshot is silently ignored unless `basedOnZCodeBuiltinRevision` names the
*same* release file that was handed to the CLI through
`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` — both paths therefore go through
`resolveDesktopBuiltinConfig()`.
