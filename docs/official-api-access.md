# 官方 API 渠道，与「直连计划额度」的对照

> **本文 2026-10-27 大改，2026-10-31 二次修正。**
> 原文的核心结论「烧套餐额度只能让 ZCode 的 agent 跑」是**错的**，已由实测推翻：
> 0.7.0 的直连通道就是烧套餐额度，且不跑 agent。
>
> 但 0.7.0 顺手写下的另一条结论 ——「**不需要伪造客户端指纹**」—— **在额度到账后被推翻了**。
> 详见下面的「客户端指纹层」一节。留本文是因为「`/api/paas/v4` 走账号余额按量计费」
> 这条信息仍然有效，而且两条路的区别值得写清楚。

## 两条完全不同的计费路

| | `/api/paas/v4` 标准接口 | 计划端点（`zcode-plan` / `anthropic`） |
|---|---|---|
| 计费 | **账号余额，按 token** | **套餐额度**（Start Plan / Coding Plan） |
| 鉴权 | `Authorization: Bearer <api key>` | `Bearer <zcodejwttoken>` 或 `x-api-key: <coding-plan key>` |
| 本机实测 | ✅ `200` 真实生成 | ✅ **`200` 真实生成**（2026-10-30 额度到账后） |
| 需要客户端指纹 | 否 | **`zcode.z.ai` 端点需要**；`api.z.ai` / `open.bigmodel.cn` 不需要 |
| 需要 agent 进程 | 否 | **否**（0.7.0 起） |
| 谁在用 | 任何智谱 API Key 用户 | ZCode 订阅用户 |

**关键结论**：两条都不需要 agent 进程，区别只在**烧哪份钱**。
`zcode.z.ai` 的套餐端点额外有一层「像不像官方客户端」的校验，但那是**请求形态**问题，
不是 WAF 绕过问题 —— 补齐三项头和一段官方 preamble 即可（见下节）。

## 客户端指纹层（2026-10-31 修正，务必先读）

`zcode.z.ai` 的套餐端点前面有一层校验，它排在**鉴权和额度之前**：

| 情况 | 上游回答 |
|---|---|
| 指纹不通过 | `405 {"code":3012,"msg":"request has been blocked due to unusual activity."}` |
| 指纹通过、额度不足 | 业务层的 `1005 exceed quota limit` / `1309 套餐已到期` |
| 指纹通过、有额度 | **`200` 真实内容流** |

**为什么 0.7.0 没发现这层**：当时本机额度已耗尽，业务层的 `1005` 先于指纹校验返回，
把这层完全遮住了。0.7.0 因此把「拿到了业务码」误读成「不需要指纹」。额度到账之后，
同样的请求立刻开始统一回 3012 —— 这层校验一直都在。

### 实测出的最小合规条件

用真实 ZCode agent 抓包（`NODE_OPTIONS=--require` 钩子拦 `globalThis.fetch`），再逐项消融：

**请求头**（缺任一即失败）：

| 头 | 值 | 缺了会怎样 |
|---|---|---|
| `authorization` | `Bearer <zcodejwttoken>` | 401 |
| `x-api-key` | **同一个** `zcodejwttoken`（不是 coding-plan key） | 401 |
| `user-agent` | 必须含 `ZCode/<版本>` | 405 / 3012 |

**请求体**：`system` 必须是**文本块数组**，不能是单个字符串。

- 块数必须是 **2 或 3**（1 块 405、4 块 405）；
- 第 1 块固定 `You are ZCode, an interactive agent`；
- 第 2 块必须是官方 preamble 的前缀，实测边界 **1228 字符失败 / 1232 通过**；
- 真正的 system prompt 放最后一块。

用 lorem 凑到同样长度**不行** —— 校验的是内容，不只是长度。
实现见 `lib/plan-preamble.js`，边界由 `test/plan-preamble.test.mjs` 锁定。


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
# Start Plan / zcode-plan 路由（0.11.0 起自动补齐客户端指纹）
POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
Authorization: Bearer <zcodejwttoken>
x-api-key: <同一个 zcodejwttoken>
user-agent: ZCode/3.17.1 …
{"model":"GLM-5.3-Flash","max_tokens":64,
 "system":[{"type":"text","text":"You are ZCode, an interactive agent"},
           {"type":"text","text":"<官方 preamble>"},
           {"type":"text","text":"<你的 system prompt>"}],
 "messages":[{"role":"user","content":"hi"}]}
→ 200 真实内容流

# BigModel Coding Plan 路由（不需要指纹层）
POST https://open.bigmodel.cn/api/anthropic/v1/messages
x-api-key: <account-provider:coding-plan:...:api-key>
→ 429 {"type":"error","error":{"code":"1309","message":"…套餐已到期…"}}
```

**这就是 0.7.0 的做法**（0.11.0 补上了指纹层），详见 [`docs/quota-api.md`](quota-api.md)
与 README 的「两条通道」一节。

## 推翻的旧结论（原文在这里，留作记录）

原文（2026-10-24）写过这些，**全部是错的**：

| 旧结论 | 实际情况 |
|---|---|
| `POST zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` → `401 / 405（WAF 会话绑定）` | 带 `Bearer <zcodejwttoken>` 能到业务层（前提是补齐客户端指纹，见上节） |
| 「要烧 Coding Plan 套餐额度，那只能让 ZCode 的 agent 跑」 | 直连通道就是烧套餐额度，不跑 agent |
| 「`/api/coding/paas/v4` 不需要过 WAF，续费后它很可能立刻可用」 | 这条本身没错，但结论误导：`zcode-plan` 端点同样可用 |

**为什么会错**：当时观察到「带签名能到业务层、不带签名 401」，就归因为「需要签名」。
实际上那个 401 是**鉴权头形态用错了** —— `zcode-plan` 端点要 `Authorization: Bearer`，
当时试的是 `x-api-key`。签名链路（`lib/client-signing.js`）确实存在也确实能用，但它服务于
另一条路径（project api-key 走 AI 网关），**不是模型推理的必需条件**。

教训记在这里：把「某个机制存在」当成「这个机制必需」，会直接堵死一条本来能走的路。

## 又推翻了一条（2026-10-31）：指纹是必需的

0.7.0 版本文写过的这一条，**也是错的**：

| 0.7.0 的结论 | 实际情况 |
|---|---|
| 「逐字节复制 agent 的 22 个 header 仍被 WAF 判 405 3012」→「根本不需要复制 header」 | **header 确实要复制**（3 项），**body 里的 system 也要按官方形状拼** |
| 「主链路不要签名」 | 「签名」确实不需要（`X-Client-*` 那套 Ed25519），但**客户端指纹**需要 |

**为什么会错**：这个错误和上一个同源 —— 当时额度耗尽，业务层的 `1005` 在指纹校验之前
就返回了，于是「拿到了业务码」被读成「指纹校验不存在」。额度到账后 3012 立刻出现。

真正的教训不是「某个机制存在不等于必需」，而是它的反面：
**「某个机制没触发，不等于它不存在」**。当上游在多层校验时，最外层通过只能证明它没拦你，
不能证明它不在那儿 —— 尤其是当内层先返回了一个"看起来像成功穿透"的业务码时。

## 签名链路还有用吗

`lib/client-signing.js` 保留，但**默认不参与直连通道**。它记录的是
OAuth token → signing JWT → HKDF/HMAC 握手 → AES-GCM 解包 Ed25519 → 签业务请求 的完整链路。
如果将来出现必须 `X-Client-*` 签名的端点（例如某些 project 级管理接口），它是现成的参考实现。

注意它与 `lib/plan-preamble.js` 是**两套不同的机制**：
- `client-signing.js` = `X-Client-Sig` / `X-Client-Pow` 那套 Ed25519 请求签名（直连通道不用）；
- `plan-preamble.js` = 官方 preamble + 三项指纹头（直连通道**必需**）。
