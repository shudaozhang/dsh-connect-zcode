# Real-adapter turn evidence (production code path)

Command (run from the repo root so `@deepseek-ai/*` peers resolve):

```
node adapter-turn.local.mjs qwen3.8-flash
```

This instantiates `ZcodeAppServerAdapter` from `lib/index.js` with `resolveOptions(...)` and
drives `adapter.stream({provider:'zcode-cli', model:'qwen3.8-flash', reasoningEffort, sessionId, messages})`
— i.e. exactly what DSH's LLM layer does, not the diagnostics probe.

## Output (2026-10-23 22:28 local)

```
mode: auto | desktop: E:\zcode | dataRoot: D:\AI\zcode\.zcode\v2
[info] zcode: launching the desktop client E:\zcode\ZCode.exe -> E:\zcode\resources\glm\zcode.cjs
       (injected: ELECTRON_RUN_AS_NODE, ZCODE_DATA_BASE_DIR,
                  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE)
[info] zcode: builtin runtime 3.16.3 available (revision 33, active:
       D:\AI\zcode\.zcode\v2\runtime\provider\windows-x86_64\3.16.3\endpoint-78d7c3bef4024722642626fe3669a799\zcode-builtin.json)
[info] zcode: app-server started (pid 28548)
[info] zcode: app-server runtime ready
[info] zcode: account provider account:bigmodel-team-coding-plan registered
       ({"receivedRevision":"dsh-zcode-plan-bridge:account:bigmodel-team-coding-plan:mvl27cu8","providerCount":1,"status":"received"})
[info] zcode: provider registry refreshed after registering account:bigmodel-team-coding-plan
[info] zcode: server request session/requestRuntimePreferences {"sessionId":"sess_4fec3dc2-...","scope":"runtime-materialization"}
[info] zcode: session permission mode set to build
[info] zcode: server request session/requestRuntimePreferences {"sessionId":"sess_3a9a1eda-...","scope":"runtime-materialization"}
[info] zcode: session model switched to new-provider-3/qwen3.8-flash
[info] zcode: new app-server session sess_4fec3dc2-df89-453e-83ed-5e1c2716543e
[info] zcode: server request session/requestRuntimePreferences {"sessionId":"sess_4fec3dc2-...","scope":"user-execution"}
[info] zcode: session/send -> {"accepted":true,"sessionId":"sess_4fec3dc2-...","stateRevision":3}
OK
[info] zcode: this turn ran on providerId=new-provider-3 model=qwen3.8-flash
       baseURL=https://ws-kv33mm6dt983erxg.cn-beijing.maas.aliyuncs.com/compatible-mode/v1

chunk kinds: {"reasoning-delta":5,"block-start":1,"text-delta":1,"block-end":1,"usage":1,"finish":1}
usage: {"inputTokens":21185,"outputTokens":58,"cacheReadTokens":20480}
finish: {"kind":"stop"}
elapsed ms: 12995
```

## What this proves

| layer | evidence |
|---|---|
| desktop discovery + launcher | `mode: auto`, `desktop: E:\zcode`, launcher `ZCode.exe` |
| data-root resolution | `dataRoot: D:\AI\zcode\.zcode\v2` (from `setting.json`, not home) |
| env injection | all four `ZCODE_*` + `ELECTRON_RUN_AS_NODE` injected |
| builtin release choice | runtime release `3.16.3`, revision 33 (matches what the CLI is handed) |
| account/plan route registration | `account:bigmodel-team-coding-plan` accepted + registry refreshed |
| session lifecycle | create → permission mode `build` → setModel → send accepted |
| streaming | `reasoning-delta` ×5, `text-delta`, `block-end`, `usage`, `finish{stop}` |
| usage accounting | input 21185 / output 58 / cacheRead 20480 |
| content | model answered exactly `OK` |

The plan (`account:*`) route was separately verified to reach
`https://open.bigmodel.cn/api/anthropic` and return upstream business error
`1309 您的GLM Coding Plan套餐已到期` — i.e. the route is wired correctly and this account's
subscription is expired.
