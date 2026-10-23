# dsh-zcode-plan-bridge — desktop integration E2E verification

Independent verification of the claims in `docs/desktop-integration-contract.md` §9 and the README v0.5.0 section. Everything below was produced by `verify/desktop-e2e.mjs`, which runs the shipped CLI in a clean environment (all `ZCODE_*` variables stripped from every subprocess) and parses the real output.

- Generated: `2026-10-23T14:22:23.306Z`
- Started: `2026-10-23T14:21:50.939Z` · Finished: `2026-10-23T14:22:23.306Z` (32366 ms)
- Mode: `--turn` (claims 1–6, two real turns)
- Repo: `D:\AI\dsh\work\zcode-plan-bridge` @ `b29a542` (main), dirty working tree
- Source fingerprint: `sha256:2631193556c82e59f83ac2f348aff094ac116ceab7f772711c07b4360b8ce618` over 18 files (lib/, bin/, test/, docs/, README.md, package.json) — stable for the whole run
- Package version: `0.5.0` · Node: `v26.2.0` (win32/x64)
- Clean env: parent had 0 `ZCODE_*` variable(s); every subprocess env had them removed (stripped names: none present)

## Verdict: **PASS** — 6/6 claims pass

## Claim verdicts

| # | Claim | Checks | Status |
|---|---|---|---|
| 1 | doctor in a clean env exits 0 and reports desktop root E:\zcode 3.16.3 (registry), data root D:\AI\zcode (setting) -> D:\AI\zcode\.zcode\v2, builtin 3.16.3 (runtime), credentials, 15 models | `doctor` | **PASS** |
| 2 | models in a clean env prints exactly 15 entries across the 6 claimed providers | `models` | **PASS** |
| 3 | node --test -> 53 pass, 0 fail; npm run typecheck -> exit 0 | `node-test`, `typecheck` | **PASS** |
| 4 | import('./lib/index.js') loads against the real peer packages and exports Config, apply, name, resolveOptions, ZcodeAppServerAdapter | `plugin-load` | **PASS** |
| 5 | a real streamed turn works on a personal provider (qwen3.8-flash): result success, >=1 delta, response contains OK, inputTokens>0 | `turn-personal` | **PASS** |
| 6 | the plan route is wired: turn --model GLM-5.3 reaches https://open.bigmodel.cn/api/anthropic and returns business error 1309 (套餐已到期) | `turn-plan` | **PASS** |

## Check summary

| Check | Command | Exit (expected) | Result | Key evidence |
|---|---|---|---|---|
| `doctor` | `node bin/dsh-zcode-plan-bridge.js doctor` | 0 (0) | **PASS** | root E:\zcode (registry); dataRoot D:\AI\zcode\.zcode\v2; builtin 3.16.3 (runtime); credentials D:\AI\zcode\.zcode\v2\credentials.json; 15 models / 6 providers |
| `models` | `node bin/dsh-zcode-plan-bridge.js models` | 0 (0) | **PASS** | 15 models / 6 providers: account:bigmodel-team-coding-plan(2), new-provider-3(3), new-provider-4(3), new-provider-5(4), deepseek(2), new-provider(1) |
| `node-test` | `node --test` | 0 (0) | **PASS** | 53 pass / 0 fail (tests 53) |
| `typecheck` | `npm run typecheck` | 0 (0) | **PASS** | tsc exit 0 |
| `plugin-load` | `node -e "import('./lib/index.js').then(m => { /* inspect exports */ })"` | 0 (0) | **PASS** | exports Config, FALLBACK_CLI_MODELS, ZcodeAppServerAdapter, apply, default, inject, name, pluginDir, resolveOptions; peers @deepseek-ai/cordis@4.0.5, @deepseek-ai/schemastery@3.18.5, @deepseek-ai/dsh-llm@0.2.1-rc.2 |
| `turn-personal` | `node bin/dsh-zcode-plan-bridge.js turn "Reply with exactly: OK" --model qwen3.8-flash` | 0 (0) | **PASS** | result success; 4 streaming delta(s); route new-provider-3/qwen3.8-flash; usage inputTokens 20862; response "OK" |
| `turn-plan` | `node bin/dsh-zcode-plan-bridge.js turn "Reply with exactly: OK" --model GLM-5.3` | 1 (1) | **PASS** | result failed (exit 1); route account:bigmodel-team-coding-plan/GLM-5.3; baseURL https://open.bigmodel.cn/api/anthropic; business error 1309; upstream message "[1309][您的GLM Coding Plan套餐已到期，暂无法使用，前往官方续订后即可恢复https://bigmo |

### `doctor` — PASS

- Command: `node bin/dsh-zcode-plan-bridge.js doctor` (cwd `D:\AI\dsh\work\zcode-plan-bridge`)
- Exit code: `0` (expected 0) · duration `2880 ms` · 2026-10-23T14:21:50.944Z → 2026-10-23T14:21:53.825Z

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

- Command: `node bin/dsh-zcode-plan-bridge.js models` (cwd `D:\AI\dsh\work\zcode-plan-bridge`)
- Exit code: `0` (expected 0) · duration `2784 ms` · 2026-10-23T14:21:53.826Z → 2026-10-23T14:21:56.610Z

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

- Command: `node --test` (cwd `D:\AI\dsh\work\zcode-plan-bridge`)
- Exit code: `0` (expected 0) · duration `1013 ms` · 2026-10-23T14:21:56.611Z → 2026-10-23T14:21:57.624Z

| Assertion | Expected | Actual | Result |
|---|---|---|---|
| `exit-code` | 0 | 0 | PASS |
| `pass-count` | 53 | 53 | PASS |
| `fail-count` | 0 | 0 | PASS |

Extracted values:

```json
{
  "tests": 53,
  "pass": 53,
  "fail": 0,
  "cancelled": 0,
  "skipped": 0,
  "todo": 0
}
```

### `typecheck` — PASS

- Command: `npm run typecheck` (cwd `D:\AI\dsh\work\zcode-plan-bridge`)
- Exit code: `0` (expected 0) · duration `1274 ms` · 2026-10-23T14:21:57.624Z → 2026-10-23T14:21:58.899Z

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

- Command: `node -e "import('./lib/index.js').then(m => { /* inspect exports */ })"` (cwd `D:\AI\dsh\work\zcode-plan-bridge`)
- Exit code: `0` (expected 0) · duration `148 ms` · 2026-10-23T14:21:58.900Z → 2026-10-23T14:21:59.047Z

| Assertion | Expected | Actual | Result |
|---|---|---|---|
| `exit-code` | 0 | 0 | PASS |
| `export:Config` | function | function | PASS |
| `export:apply` | function | function | PASS |
| `export:name` | string | string | PASS |
| `export:resolveOptions` | function | function | PASS |
| `export:ZcodeAppServerAdapter` | function | function | PASS |
| `export-name-value` | dsh-zcode-plan-bridge | dsh-zcode-plan-bridge | PASS |

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
  "name": "dsh-zcode-plan-bridge",
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

### `turn-personal` — PASS

- Command: `node bin/dsh-zcode-plan-bridge.js turn "Reply with exactly: OK" --model qwen3.8-flash` (cwd `D:\AI\dsh\work\zcode-plan-bridge`)
- Exit code: `0` (expected 0) · duration `13620 ms` · 2026-10-23T14:21:59.050Z → 2026-10-23T14:22:12.669Z

| Assertion | Expected | Actual | Result |
|---|---|---|---|
| `exit-code` | 0 | 0 | PASS |
| `result-success` | success | success | PASS |
| `streaming-deltas>=1` | >= 1 | 4 | PASS |
| `response-contains-OK` | response includes "OK" | OK | PASS |
| `usage-inputTokens>0` | inputTokens > 0 | 20862 | PASS |
| `personal-provider` | non-account provider | new-provider-3 | PASS |
| `model-is-qwen3.8-flash` | qwen3.8-flash | qwen3.8-flash | PASS |

Extracted values:

```json
{
  "resultType": "success",
  "streamingDeltas": 4,
  "providerId": "new-provider-3",
  "route": "new-provider-3/qwen3.8-flash",
  "observedModelId": "qwen3.8-flash",
  "reasoningLevel": "xhigh",
  "baseURL": "https://ws-kv33mm6dt983erxg.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  "usage": {
    "source": "provider",
    "modelRequestCount": 1,
    "inputTokens": 20862,
    "outputTokens": 27,
    "totalTokens": 20889,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "reasoningTokens": 23,
    "webFetchRequests": 0,
    "webSearchRequests": 0
  },
  "usageRaw": "{\"source\":\"provider\",\"modelRequestCount\":1,\"inputTokens\":20862,\"outputTokens\":27,\"totalTokens\":20889,\"cacheReadTokens\":0,\"cacheWriteTokens\":0,\"reasoningTokens\":23,\"webFetchRequests\":0,\"webSearchRequests\":0}",
  "response": "OK"
}
```

### `turn-plan` — PASS

- Command: `node bin/dsh-zcode-plan-bridge.js turn "Reply with exactly: OK" --model GLM-5.3` (cwd `D:\AI\dsh\work\zcode-plan-bridge`)
- Exit code: `1` (expected 1) · duration `10625 ms` · 2026-10-23T14:22:12.672Z → 2026-10-23T14:22:23.297Z

| Assertion | Expected | Actual | Result |
|---|---|---|---|
| `exit-code` | 1 | 1 | PASS |
| `result-not-success` | not success | failed | PASS |
| `account-plan-route` | account:* provider | account:bigmodel-team-coding-plan | PASS |
| `model-is-GLM-5.3` | GLM-5.3 | GLM-5.3 | PASS |
| `reaches-upstream-url` | https://open.bigmodel.cn/api/anthropic | https://open.bigmodel.cn/api/anthropic | PASS |
| `business-code-1309` | 1309 | 1309 | PASS |
| `expired-plan-message` | 套餐已到期 | [1309][您的GLM Coding Plan套餐已到期，暂无法使用，前往官方续订后即可恢复https://bigmodel.cn/claude-code。][20261023222222d4ef01fa25e343e3] | PASS |

Extracted values:

```json
{
  "resultType": "failed",
  "providerId": "account:bigmodel-team-coding-plan",
  "route": "account:bigmodel-team-coding-plan/GLM-5.3",
  "baseURL": "https://open.bigmodel.cn/api/anthropic",
  "usage": null,
  "response": "[1309][您的GLM Coding Plan套餐已到期，暂无法使用，前往官方续订后即可恢复https://bigmodel.cn/claude-code。][20261023222222d4ef01fa25e343e3]",
  "upstreamMessageLines": [
    "  [1309][您的GLM Coding Plan套餐已到期，暂无法使用，前往官方续订后即可恢复https://bigmodel.cn/claude-code。][20261023222222d4ef01fa25e343e3]"
  ],
  "businessCode": "1309",
  "reachedUpstream": true
}
```

> A non-zero exit here is the expected outcome: the route works but the account plan is expired upstream.

## Turn transcripts

### `turn-personal`

- Command: `node bin/dsh-zcode-plan-bridge.js turn "Reply with exactly: OK" --model qwen3.8-flash`
- Exit code: `0` · result: `success` · streaming deltas: `4`
- Route: `new-provider-3/qwen3.8-flash` (reasoning `xhigh`)
- baseURL: `https://ws-kv33mm6dt983erxg.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`
- Usage: `{"source":"provider","modelRequestCount":1,"inputTokens":20862,"outputTokens":27,"totalTokens":20889,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":23,"webFetchRequests":0,"webSearchRequests":0}`
- Response (as printed by the CLI, capped at 600 chars):

```text
OK
```

### `turn-plan`

- Command: `node bin/dsh-zcode-plan-bridge.js turn "Reply with exactly: OK" --model GLM-5.3`
- Exit code: `1` · result: `failed` · streaming deltas: `n/a`
- Route: `account:bigmodel-team-coding-plan/GLM-5.3`
- baseURL: `https://open.bigmodel.cn/api/anthropic`
- Business error code: `1309`
- Interpretation: **route wiring works**. The request reached the coding-plan upstream and came back with a real upstream business error; the account's GLM Coding Plan subscription is expired upstream, so the model cannot answer. This is **not** a bridge/plugin failure.
- Response (as printed by the CLI, capped at 600 chars):

```text
[1309][您的GLM Coding Plan套餐已到期，暂无法使用，前往官方续订后即可恢复https://bigmodel.cn/claude-code。][20261023222222d4ef01fa25e343e3]
```
- Exact upstream message line(s):

```text
  [1309][您的GLM Coding Plan套餐已到期，暂无法使用，前往官方续订后即可恢复https://bigmodel.cn/claude-code。][20261023222222d4ef01fa25e343e3]
```

## Notes

- Claims 1–4 are offline checks. Claims 5–6 run one real streamed turn each and are only executed with `--turn`.
- The turn command prints the model response truncated to 600 characters (a CLI diagnostics cap); the assertions only need the first bytes ("OK") and the upstream business error text.
- The account's coding-plan subscription is expired on this machine, so claim 6 is expected to exit non-zero: PASS means the request really reached the plan upstream URL and came back with business error 1309, i.e. the route wiring works.
- docs/desktop-integration-contract.md §4/§9 still records the pre-account-overlay count (13 models / 5 providers); README v0.5.0 and these claims expect the final 15 / 6 (13 personal + account:bigmodel-team-coding-plan GLM-5.3, GLM-5.3-Flash). The measured output is 15 / 6, matching README v0.5.0.
- Report produced by an independent verifier; only verify/ was written, no source files were modified.

---

Raw per-command stdout/stderr, timings, and assertions are in `verify/report.json` (same directory).
