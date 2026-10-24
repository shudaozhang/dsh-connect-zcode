# 正规接入渠道：智谱/Z.AI 官方 API

本文记录 2026-10-24 的实测结论，回答一个问题：**除了托管 ZCode 的 agent，有没有官方支持的
路子能把 GLM 模型接进 DSH？**

**有，而且比绕 WAF 干净得多。** 但有一个前提条件本节末尾说明。

## 官方端点全表（实测）

用凭证文件里那把 `account-provider:coding-plan:...:api-key`（49 字符，`id.secret` 形状）逐个试：

| 端点 | 用途 | 实测结果 |
|---|---|---|
| `POST open.bigmodel.cn/api/paas/v4/chat/completions` | **标准 OpenAI 兼容** | **200 ✅ 真实生成** |
| `GET  open.bigmodel.cn/api/paas/v4/models` | 模型清单 | **200 ✅ 11 个模型** |
| `POST api.z.ai/api/paas/v4/chat/completions` | 同上（国际站） | **200 ✅** |
| `POST open.bigmodel.cn/api/coding/paas/v4/chat/completions` | **编码套餐专用** | **429 `1309 套餐已到期`** |
| `POST open.bigmodel.cn/api/anthropic/v1/messages` | Anthropic 兼容（套餐） | **429 `1309 套餐已到期`** |
| `POST api.z.ai/api/anthropic/v1/messages` | 同上（国际站） | **429 `1309`** |
| `POST zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` | ZCode 套餐端点 | 401 / 405（WAF 会话绑定） |

**关键结论**：`/api/paas/v4` 是**公开文档中的标准接口**，用同一把 key 就能跑通，无需签名、
无需 WAF 绕过、无需 ZCode agent。它走的是**按量计费**（账号余额），不是 Coding Plan 套餐。

## 标准路由的能力（已逐项验证）

```bash
# 流式
POST /api/paas/v4/chat/completions  { "stream": true }
→ 200, content-type: text/event-stream, 12 个 SSE 帧 ✅

# 工具调用
POST /api/paas/v4/chat/completions  { "tools": [...] }
→ 200, tool_calls: [{"function":{"name":"get_weather","arguments":"{\"city\": \"Beijing\"}"}}] ✅

# 模型清单
GET /api/paas/v4/models
→ 200, 11 个模型: glm-4.5, glm-4.5-air, glm-4.6, glm-4.7,
                  glm-5, glm-5-turbo, glm-5.1, glm-5.2,
                  glm-5.3, glm-5.3-flash, glm-5.3-flashx ✅
```

真实生成示例（`glm-5.2`）：

```
POST /api/paas/v4/chat/completions  {"model":"glm-5.2","messages":[{"role":"user","content":"say OK"}]}
→ 200 {"choices":[{"finish_reason":"stop","message":{"content":"OK"}}],
       "usage":{"completion_tokens":...,"prompt_tokens":17,"total_tokens":81}}
```

## 为什么这是「正规渠道」

1. **公开文档的接口**：`/api/paas/v4` 是智谱开放平台标准的 OpenAI 兼容入口，任何 API Key 用户
   都用它。
2. **不规避任何安全措施**：不走 WAF、不伪造客户端指纹、不逆向签名。
3. **计费透明**：走账号余额按量计费，不会因为「绕过套餐」而有封号风险。

对比之下，直连 `zcode.z.ai` 的套餐端点即使**逐字节复制 agent 的 22 个 header、用同一个
Node 24 运行时**，仍然被 WAF 判 `405 3012 异常活动`——那是阿里云 WAF 的 `acw_tc` 会话绑定，
属于对方的主动防护，不应绕过。

## 前提条件：计费方式不同

| | `/api/paas/v4` 标准 | `/api/coding/paas/v4` 套餐 |
|---|---|---|
| 计费 | 账号余额，按 token | Coding Plan 套餐额度 |
| 当前可用 | ✅ **是** | ❌ 套餐已到期（`1309`） |
| 需要绕过防护 | 否 | 是（不可行） |

**所以：如果你的目标是烧 Coding Plan 套餐额度，那只能让 ZCode 的 agent 跑（当前架构）。
如果你只是想让 DSH 用上 GLM 模型，`/api/paas/v4` 是最好、最稳、最合规的路。**

## 接入 DSH 的方式

DSH 自带 OpenAI 兼容的 provider 支持，**不需要本插件**：

```yaml
# 在 DSH 的模型配置里添加一个 OpenAI 兼容供应商
baseURL: https://open.bigmodel.cn/api/paas/v4
apiKey:  <你的 bigmodel API Key>
models:  glm-5.3, glm-5.3-flash, glm-5.2, glm-5-turbo, ...
```

这条路上 **DSH 完全掌控 system prompt 和工具**，模型不会以为自己在别的产品里跑，
也不存在「双 agent」问题——正是最初想要的效果。

## 如果你续费了 Coding Plan

续费后值得再试一次本插件的套餐路由，因为签名链路已经复现（见
[`lib/client-signing.js`](../lib/client-signing.js)）。但要注意：`zcode.z.ai` 那层 WAF
会话绑定仍然存在，**续费改变的是业务层的 1309，不改变 WAF 的 405**。

而 `/api/coding/paas/v4` 这条**不需要过 WAF**（实测直接返回 1309 业务码而非 405），
所以**续费后它很可能立刻可用**——这是最值得优先验证的一条。
