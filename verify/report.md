# dsh-connect-zcode — desktop integration E2E verification

Independent verification of the claims in `docs/desktop-integration-contract.md` §9 and the README v0.5.0 section. Everything below was produced by `verify/desktop-e2e.mjs`, which runs the shipped CLI in a clean environment (all `ZCODE_*` variables stripped from every subprocess) and parses the real output.

- Generated: `2026-10-23T14:58:23.776Z`
- Started: `2026-10-23T14:58:14.871Z` · Finished: `2026-10-23T14:58:23.777Z` (8905 ms)
- Mode: offline (claims 1–4; run with `--turn` for 5–6)
- Repo: `D:\AI\dsh\work\dsh-connect-zcode` @ `f0b0fa7` (main), clean working tree
- Source fingerprint: `sha256:180816941d91fcee95359adba0fe95c52629b5e06f08212bff184be963158a9f` over 21 files (lib/, bin/, test/, docs/, README.md, package.json) — stable for the whole run
- Package version: `0.6.0` · Node: `v26.2.0` (win32/x64)
- Clean env: parent had 0 `ZCODE_*` variable(s); every subprocess env had them removed (stripped names: none present)

## Verdict: **PASS** — 4/6 claims pass, 2 skipped

## Claim verdicts

| # | Claim | Checks | Status |
|---|---|---|---|
| 1 | doctor in a clean env exits 0 and reports desktop root E:\zcode 3.16.3 (registry), data root D:\AI\zcode (setting) -> D:\AI\zcode\.zcode\v2, builtin 3.16.3 (runtime), credentials, 15 models | `doctor` | **PASS** |
| 2 | models in a clean env prints exactly 15 entries across the 6 claimed providers | `models` | **PASS** |
| 3 | node --test -> >= 53 pass, 0 fail; npm run typecheck -> exit 0 | `node-test`, `typecheck` | **PASS** |
| 4 | import('./lib/index.js') loads against the real peer packages and exports Config, apply, name, resolveOptions, ZcodeAppServerAdapter | `plugin-load` | **PASS** |
| 5 | a real streamed turn works on a personal provider (qwen3.8-flash): result success, >=1 delta, response contains OK, inputTokens>0 | `turn-personal` | **SKIPPED** |
| 6 | the plan route is wired: turn --model GLM-5.3 reaches https://open.bigmodel.cn/api/anthropic and returns business error 1309 (套餐已到期) | `turn-plan` | **SKIPPED** |

## Check summary

| Check | Command | Exit (expected) | Result | Key evidence |
|---|---|---|---|---|
| `doctor` | `node bin/dsh-connect-zcode.js doctor` | 0 (0) | **PASS** | root E:\zcode (registry); dataRoot D:\AI\zcode\.zcode\v2; builtin 3.16.3 (runtime); credentials D:\AI\zcode\.zcode\v2\credentials.json; 15 models / 6 providers |
| `models` | `node bin/dsh-connect-zcode.js models` | 0 (0) | **PASS** | 15 models / 6 providers: account:bigmodel-team-coding-plan(2), new-provider-3(3), new-provider-4(3), new-provider-5(4), deepseek(2), new-provider(1) |
| `node-test` | `node --test` | 0 (0) | **PASS** | 62 pass / 0 fail (tests 62) |
| `typecheck` | `npm run typecheck` | 0 (0) | **PASS** | tsc exit 0 |
| `plugin-load` | `node -e "import('./lib/index.js').then(m => { /* inspect exports */ })"` | 0 (0) | **PASS** | exports Config, FALLBACK_CLI_MODELS, ZcodeAppServerAdapter, apply, default, inject, name, pluginDir, resolveOptions; peers @deepseek-ai/cordis@4.0.5, @deepseek-ai/schemastery@3.18.5, @deepseek-ai/dsh-llm@0.2.1-rc.2 |

### `doctor` — PASS

- Command: `node bin/dsh-connect-zcode.js doctor` (cwd `D:\AI\dsh\work\dsh-connect-zcode`)
- Exit code: `0` (expected 0) · duration `3045 ms` · 2026-10-23T14:58:14.877Z → 2026-10-23T14:58:17.922Z

| Assertion | Expected | Actual | Result |
|---|---|---|---|
| `exit-code` | 0 | 0 | PASS |
| `desktop-root` | E:\zcode | E:\zcode | PASS |
| `desktop-discovery-source` | registry | registry | PASS |
| `desktop-version` | 3.16.3 | 3.16.3 | PASS |
| `dataBaseDir` | D:\AI\zcode | D:\AI\zcode | PASS |
| `data-root-source` | setting | setting | PASS |
| `dataRoot` | D:\AI\zcode\.zcode\v2 | D:\AI\zcode\.zcode\v2 | PASS |
| `builtin-release` | 3.16.3 (runtime) | 3.16.3 (runtime) | PASS |
| `credentials-file` | D:\AI\zcode\.zcode\v2\credentials.json | D:\AI\zcode\.zcode\v2\credentials.json | PASS |
| `model-count` | 15 | 15 | PASS |
| `all-preconditions-satisfied` | true | true | PASS |

Extracted values:

```json
{
  "root": "E:\\zcode",
  "discoverySource": "registry",
  "version": "3.16.3",
  "dataBaseDir": "D:\\AI\\zcode",
  "dataBaseSource": "setting",
  "dataRoot": "D:\\AI\\zcode\\.zcode\\v2",
  "builtinRelease": "3.16.3 (runtime)",
  "builtinFile": "D:\\AI\\zcode\\.zcode\\v2\\runtime\\provider\\windows-x86_64\\3.16.3\\endpoint-78d7c3bef4024722642626fe3669a799\\zcode-builtin.json",
  "credentialsFile": "D:\\AI\\zcode\\.zcode\\v2\\credentials.json",
  "tokenLength": 204,
  "catalog": [
    {
      "providerId": "account:bigmodel-team-coding-plan",
      "modelId": "GLM-5.3",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000
    },
    {
      "providerId": "account:bigmodel-team-coding-plan",
      "modelId": "GLM-5.3-Flash",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000
    },
    {
      "providerId": "new-provider-3",
      "modelId": "qwen3.8-max-0902",
      "contextWindow": 1000000,
      "maxOutputTokens": 131072
    },
    {
      "providerId": "new-provider-3",
      "modelId": "qwen3.8-flash",
      "contextWindow": 1000000,
      "maxOutputTokens": 131072
    },
    {
      "providerId": "new-provider-3",
      "modelId": "deepseek-v4.1-flash-1017",
      "contextWindow": 1000000,
      "maxOutputTokens": 384000
    },
    {
      "providerId": "new-provider-4",
      "modelId": "gpt-6-astra",
      "contextWindow": 1050000,
      "maxOutputTokens": 128000
    },
    {
      "providerId": "new-provider-4",
      "modelId": "gpt-6.1-sol",
      "contextWindow": 1050000,
      "maxOutputTokens": 128000
    },
    {
      "providerId": "new-provider-4",
      "modelId": "gpt-6-luna",
      "contextWindow": 1050000,
      "maxOutputTokens": 128000
    },
    {
      "providerId": "new-provider-5",
      "modelId": "claude-fable-5-1",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000
    },
    {
      "providerId": "new-provider-5",
      "modelId": "claude-opus-5-5",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000
    },
    {
      "providerId": "new-provider-5",
      "modelId": "claude-sonnet-5-5",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000
    },
    {
      "providerId": "new-provider-5",
      "modelId": "claude-haiku-5-5",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000
    },
    {
      "providerId": "deepseek",
      "modelId": "deepseek-flash",
      "contextWindow": 1000000,
      "maxOutputTokens": 384000
    },
    {
      "providerId": "deepseek",
      "modelId": "deepseek-v4-pro",
      "contextWindow": 1000000,
      "maxOutputTokens": 384000
    },
    {
      "providerId": "new-provider",
      "modelId": "LongCat-2.5-Preview",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000
    }
  ],
  "modelCount": 15,
  "providerCount": 6,
  "allPreconditionsSatisfied": true
}
```

### `models` — PASS

- Command: `node bin/dsh-connect-zcode.js models` (cwd `D:\AI\dsh\work\dsh-connect-zcode`)
- Exit code: `0` (expected 0) · duration `3194 ms` · 2026-10-23T14:58:17.924Z → 2026-10-23T14:58:21.118Z

| Assertion | Expected | Actual | Result |
|---|---|---|---|
| `exit-code` | 0 | 0 | PASS |
| `entry-count` | 15 | 15 | PASS |
| `provider-count` | 6 | 6 | PASS |
| `provider-ids` | ["account:bigmodel-team-coding-plan","new-provider-3","new-provider-4","new-provider-5","deepseek","new-provider"] | ["account:bigmodel-team-coding-plan","new-provider-3","new-provider-4","new-provider-5","deepseek","new-provider"] | PASS |
| `no-duplicate-model-ids` | [] | [] | PASS |
| `models:account:bigmodel-team-coding-plan` | ["GLM-5.3","GLM-5.3-Flash"] | ["GLM-5.3","GLM-5.3-Flash"] | PASS |
| `models:new-provider-3` | ["qwen3.8-max-0902","qwen3.8-flash","deepseek-v4.1-flash-1017"] | ["qwen3.8-max-0902","qwen3.8-flash","deepseek-v4.1-flash-1017"] | PASS |
| `models:new-provider-4` | ["gpt-6-astra","gpt-6.1-sol","gpt-6-luna"] | ["gpt-6-astra","gpt-6.1-sol","gpt-6-luna"] | PASS |
| `models:new-provider-5` | ["claude-fable-5-1","claude-opus-5-5","claude-sonnet-5-5","claude-haiku-5-5"] | ["claude-fable-5-1","claude-opus-5-5","claude-sonnet-5-5","claude-haiku-5-5"] | PASS |
| `models:deepseek` | ["deepseek-flash","deepseek-v4-pro"] | ["deepseek-flash","deepseek-v4-pro"] | PASS |
| `models:new-provider` | ["LongCat-2.5-Preview"] | ["LongCat-2.5-Preview"] | PASS |

Extracted values:

```json
{
  "entryCount": 15,
  "providerCount": 6,
  "providers": {
    "account:bigmodel-team-coding-plan": [
      "GLM-5.3",
      "GLM-5.3-Flash"
    ],
    "new-provider-3": [
      "qwen3.8-max-0902",
      "qwen3.8-flash",
      "deepseek-v4.1-flash-1017"
    ],
    "new-provider-4": [
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-luna"
    ],
    "new-provider-5": [
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5"
    ],
    "deepseek": [
      "deepseek-flash",
      "deepseek-v4-pro"
    ],
    "new-provider": [
      "LongCat-2.5-Preview"
    ]
  },
  "entries": [
    {
      "providerId": "account:bigmodel-team-coding-plan",
      "modelId": "GLM-5.3",
      "label": "GLM-5.3 (BigModel Team Coding Plan)",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000,
      "image": true
    },
    {
      "providerId": "account:bigmodel-team-coding-plan",
      "modelId": "GLM-5.3-Flash",
      "label": "GLM-5.3-Flash (BigModel Team Coding Plan)",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000,
      "image": true
    },
    {
      "providerId": "new-provider-3",
      "modelId": "qwen3.8-max-0902",
      "label": "qwen3.8-max-0902 (qwen-tt)",
      "contextWindow": 1000000,
      "maxOutputTokens": 131072,
      "image": true
    },
    {
      "providerId": "new-provider-3",
      "modelId": "qwen3.8-flash",
      "label": "qwen3.8-flash (qwen-tt)",
      "contextWindow": 1000000,
      "maxOutputTokens": 131072,
      "image": true
    },
    {
      "providerId": "new-provider-3",
      "modelId": "deepseek-v4.1-flash-1017",
      "label": "deepseek-v4.1-flash-1017 (qwen-tt)",
      "contextWindow": 1000000,
      "maxOutputTokens": 384000,
      "image": true
    },
    {
      "providerId": "new-provider-4",
      "modelId": "gpt-6-astra",
      "label": "gpt-6-astra (sanqian-gpt)",
      "contextWindow": 1050000,
      "maxOutputTokens": 128000,
      "image": true
    },
    {
      "providerId": "new-provider-4",
      "modelId": "gpt-6.1-sol",
      "label": "gpt-6.1-sol (sanqian-gpt)",
      "contextWindow": 1050000,
      "maxOutputTokens": 128000,
      "image": true
    },
    {
      "providerId": "new-provider-4",
      "modelId": "gpt-6-luna",
      "label": "gpt-6-luna (sanqian-gpt)",
      "contextWindow": 1050000,
      "maxOutputTokens": 128000,
      "image": true
    },
    {
      "providerId": "new-provider-5",
      "modelId": "claude-fable-5-1",
      "label": "claude-fable-5-1 (sanqian-cc)",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000,
      "image": true
    },
    {
      "providerId": "new-provider-5",
      "modelId": "claude-opus-5-5",
      "label": "claude-opus-5-5 (sanqian-cc)",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000,
      "image": true
    },
    {
      "providerId": "new-provider-5",
      "modelId": "claude-sonnet-5-5",
      "label": "claude-sonnet-5-5 (sanqian-cc)",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000,
      "image": true
    },
    {
      "providerId": "new-provider-5",
      "modelId": "claude-haiku-5-5",
      "label": "claude-haiku-5-5 (sanqian-cc)",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000,
      "image": true
    },
    {
      "providerId": "deepseek",
      "modelId": "deepseek-flash",
      "label": "deepseek-flash (DeepSeek)",
      "contextWindow": 1000000,
      "maxOutputTokens": 384000,
      "image": true
    },
    {
      "providerId": "deepseek",
      "modelId": "deepseek-v4-pro",
      "label": "deepseek-v4-pro (DeepSeek)",
      "contextWindow": 1000000,
      "maxOutputTokens": 384000,
      "image": false
    },
    {
      "providerId": "new-provider",
      "modelId": "LongCat-2.5-Preview",
      "label": "LongCat-2.5-Preview (longcat)",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000,
      "image": true
    }
  ]
}
```

### `node-test` — PASS

- Command: `node --test` (cwd `D:\AI\dsh\work\dsh-connect-zcode`)
- Exit code: `0` (expected 0) · duration `1149 ms` · 2026-10-23T14:58:21.120Z → 2026-10-23T14:58:22.269Z

| Assertion | Expected | Actual | Result |
|---|---|---|---|
| `exit-code` | 0 | 0 | PASS |
| `pass-count-at-least-53` | >= 53 | 62 | PASS |
| `fail-count` | 0 | 0 | PASS |

Extracted values:

```json
{
  "tests": 62,
  "pass": 62,
  "fail": 0,
  "cancelled": 0,
  "skipped": 0,
  "todo": 0
}
```

### `typecheck` — PASS

- Command: `npm run typecheck` (cwd `D:\AI\dsh\work\dsh-connect-zcode`)
- Exit code: `0` (expected 0) · duration `1371 ms` · 2026-10-23T14:58:22.269Z → 2026-10-23T14:58:23.641Z

| Assertion | Expected | Actual | Result |
|---|---|---|---|
| `exit-code` | 0 | 0 | PASS |

Extracted values:

```json
{
  "exitCode": 0
}
```

### `plugin-load` — PASS

- Command: `node -e "import('./lib/index.js').then(m => { /* inspect exports */ })"` (cwd `D:\AI\dsh\work\dsh-connect-zcode`)
- Exit code: `0` (expected 0) · duration `131 ms` · 2026-10-23T14:58:23.641Z → 2026-10-23T14:58:23.772Z

| Assertion | Expected | Actual | Result |
|---|---|---|---|
| `exit-code` | 0 | 0 | PASS |
| `export:Config` | function | function | PASS |
| `export:apply` | function | function | PASS |
| `export:name` | string | string | PASS |
| `export:resolveOptions` | function | function | PASS |
| `export:ZcodeAppServerAdapter` | function | function | PASS |
| `export-name-value` | dsh-connect-zcode | dsh-connect-zcode | PASS |

Extracted values:

```json
{
  "exports": [
    "Config",
    "FALLBACK_CLI_MODELS",
    "ZcodeAppServerAdapter",
    "apply",
    "default",
    "inject",
    "name",
    "pluginDir",
    "resolveOptions"
  ],
  "types": {
    "Config": "function",
    "apply": "function",
    "name": "string",
    "resolveOptions": "function",
    "ZcodeAppServerAdapter": "function"
  },
  "name": "dsh-connect-zcode",
  "defaultExport": [
    "Config",
    "apply",
    "inject",
    "name"
  ],
  "peerVersions": {
    "@deepseek-ai/cordis": "4.0.5",
    "@deepseek-ai/schemastery": "3.18.5",
    "@deepseek-ai/dsh-llm": "0.2.1-rc.2"
  }
}
```

## Turn transcripts

Turn checks were skipped. Re-run with `--turn` to execute claims 5–6.
## Notes

- Claims 1–4 are offline checks. Claims 5–6 run one real streamed turn each and are only executed with `--turn`.
- The turn command prints the model response truncated to 600 characters (a CLI diagnostics cap); the assertions only need the first bytes ("OK") and the upstream business error text.
- The account's coding-plan subscription is expired on this machine, so claim 6 is expected to exit non-zero: PASS means the request really reached the plan upstream URL and came back with business error 1309, i.e. the route wiring works.
- docs/desktop-integration-contract.md §4/§9 still records the pre-account-overlay count (13 models / 5 providers); README v0.5.0 and these claims expect the final 15 / 6 (13 personal + account:bigmodel-team-coding-plan GLM-5.3, GLM-5.3-Flash). The measured output is 15 / 6, matching README v0.5.0.
- Report produced by an independent verifier; only verify/ was written, no source files were modified.

---

Raw per-command stdout/stderr, timings, and assertions are in `verify/report.json` (same directory).
