# 官方 API 渠道，与「直连计划额度」的对照

> **本文 2026-10-27 大改。** 原文的核心结论「烧套餐额度只能让 ZCode 的 agent 跑」是**错的**，
> 已由实测推翻。0.7.0 的直连通道就是烧套餐额度，且不跑 agent。保留本文是因为它记录的
> 「`/api/paas/v4` 走账号余额按量计费」这条信息仍然有效，而且两条路的区别值得写清楚。

## 两条完全不同的计费路

| | `/api/paas/v4` 标准接口 | 计划端点（`zcode-plan` / `anthropic`） |
|---|---|---|
| 计费 | **账号余额，按 token** | **套餐额度**（Start Plan / Coding Plan） |
| 鉴权 | `Authorization: Bearer <api key>` | `Bearer <zcodejwttoken>` 或 `x-api-key: <coding-plan key>` |
| 本机实测 | ✅ `200` 真实生成 | ✅ 到达业务层（`1005` / `1309`，因本机无额度） |
| 需要签名 | 否 | **否** |
| 需要 agent 进程 | 否 | **否**（0.7.0 起） |
| 谁在用 | 任何智谱 API Key 用户 | ZCode 订阅用户 |

**关键结论**：两条都不需要 WAF 绕过、不需要伪造客户端指纹、不需要 agent 进程。
区别只在**烧哪份钱**。

## `/api/paas/v4`：标准 OpenAI 兼容（走账号余额）

```bash
POST https://open.bigmodel.cn/api/paas/v4/chat/completions
Authorization: Bearer <api key>
{"model":"glm-5.2","messages":[{"role":"user","content":"say OK"}]}
→ 200 {"choices":[{"finish_reason":"stop","message":{"content":"OK"}}],
       "usage":{"prompt_tokens":17,"completion_tokens":...,"total_tokens":81}}
```

实测能力（2026-10-24，用凭证文件里那把 49 字符 `account-provider:coding-plan:...:api-key`）：

| 端点 | 结果 |
|---|---|
| `POST open.bigmodel.cn/api/paas/v4/chat/completions` | **200 ✅ 真实生成** |
| `POST api.z.ai/api/paas/v4/chat/completions` | **200 ✅** |
| `GET  open.bigmodel.cn/api/paas/v4/models` | **200 ✅ 11 个模型** |
| `POST .../chat/completions` + `stream:true` | **200 ✅ SSE 12 帧** |
| `POST .../chat/completions` + `tools` | **200 ✅ tool_calls 正常** |

模型清单：`glm-4.5`、`glm-4.5-air`、`glm-4.6`、`glm-4.7`、`glm-5`、`glm-5-turbo`、
`glm-5.1`、`glm-5.2`、`glm-5.3`、`glm-5.3-flash`、`glm-5.3-flashx`。

**接入 DSH 不需要本插件**：DSH 自带 OpenAI 兼容 provider，填 baseURL + apiKey 即可。
这条路 DSH 完全掌控 system prompt 与工具。

## 计划端点：烧套餐额度（0.7.0 的直连通道）

```bash
# Start Plan / zcode-plan 路由
POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
Authorization: Bearer <zcodejwttoken>
{"model":"GLM-5.3-Flash","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}
→ 200 {"code":1005,"msg":"exceed quota limit"}          ← 鉴权与路由均通过，本机无额度
→ 429 {"code":3009,"msg":"model concurrency limit exceeded"}

# BigModel Coding Plan 路由
POST https://open.bigmodel.cn/api/anthropic/v1/messages
x-api-key: <account-provider:coding-plan:...:api-key>
→ 429 {"type":"error","error":{"code":"1309","message":"…套餐已到期…"}}
```

**这就是 0.7.0 的做法**，详见 [`docs/quota-api.md`](quota-api.md) 与 README 的
「两条通道」一节。

## 推翻的旧结论（原文在这里，留作记录）

原文（2026-10-24）写过这些，**全部是错的**：

| 旧结论 | 实际情况 |
|---|---|
| `POST zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` → `401 / 405（WAF 会话绑定）` | 带 `Bearer <zcodejwttoken>` 直接 `200`/`429` 到业务层 |
| 逐字节复制 agent 的 22 个 header 仍被 WAF 判 `405 3012 异常活动` | 根本不需要复制 header —— 主链路不要签名 |
| 「要烧 Coding Plan 套餐额度，那只能让 ZCode 的 agent 跑」 | 直连通道就是烧套餐额度，不跑 agent |
| 「`/api/coding/paas/v4` 不需要过 WAF，续费后它很可能立刻可用」 | 这条本身没错，但结论误导：`zcode-plan` 端点同样不需要过 WAF |

**为什么会错**：当时观察到「带签名能到业务层、不带签名 401」，就归因为「需要签名」。
实际上那个 401 是**鉴权头形态用错了** —— `zcode-plan` 端点要 `Authorization: Bearer`，
当时试的是 `x-api-key`。签名链路（`lib/client-signing.js`）确实存在也确实能用，但它服务于
另一条路径（project api-key 走 AI 网关），**不是模型推理的必需条件**。

教训记在这里：把「某个机制存在」当成「这个机制必需」，会直接堵死一条本来能走的路。

## 签名链路还有用吗

`lib/client-signing.js` 保留，但**默认不参与直连通道**。它记录的是
OAuth token → signing JWT → HKDF/HMAC 握手 → AES-GCM 解包 Ed25519 → 签业务请求 的完整链路。
如果将来出现必须签名的端点（例如某些 project 级管理接口），它是现成的参考实现。
