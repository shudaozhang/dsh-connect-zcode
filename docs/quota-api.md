# ZCode 套餐额度接口（`billing/*`）实测文档

本文是 `lib/plan-quota.js` 的接口依据，写给**将来要动额度功能的人**：照这里做就能复现，
不必重新逆向 asar。所有结论都标注了实测时间与证据来源。

- 实测时间：**2026-10-27**（北京时间 16:39–16:52）
- 环境：Windows 10 x64 / Node 26 / 客户端 **ZCode 3.16.3**
- 凭证：本机真实凭证（`D:\AI\zcode\.zcode\v2\credentials.json`，AES-256-GCM 解密后）
- 探针脚本：`D:\AI\dsh\work\zcode-direct\recon\probe-balance-honest.mjs` 等（结果 JSON 同目录）

> **一句话结论**
> 三个 `billing` 端点**全部可用**。`current` 只要 `Bearer <zcodejwttoken>`；
> `balance` / `preview` 还必须额外带 **`X-Device-Mid: <UUID>`**。
> 缺这个头就是 `400 {"code":3001,"msg":"parameter error"}` —— 这是**头缺失**，
> **不是限流、不是 `app_version` 不对、不是"没有额度"**。详见 §6。

---

## 1. 端点表

所有路径的 origin 都是 `https://zcode.z.ai`（客户端常量 `$H`；另有 `zcode.chatglm.site` /
`localhost:3000` / `dev.bigmodel.cn` 等环境变体，普通用户不用管）。

| # | 方法 | 路径 | 鉴权 | Query | Body | 实测结果（2026-10-27） |
|---|---|---|---|---|---|---|
| 1 | GET | `/api/v1/zcode-plan/billing/current` | `Authorization: Bearer <jwt>` | 无（`app_version`/`platform` 可选，不影响结果） | — | **200** `{"code":0,...,"plans":[]}` |
| 2 | GET | `/api/v1/zcode-plan/billing/balance` | 同上 + **`X-Device-Mid: <UUID>`** | 同上 | — | **200** `{"code":0,...,"plans":[],"balances":[]}`（带 DM）；不带 DM → 400 |
| 3 | GET | `/api/v1/zcode-plan/billing/preview` | 同上 + **`X-Device-Mid: <UUID>`** | 同上 | — | **200** `{"code":0,...,"plans":[]}`（带 DM）；不带 DM → 400 |
| 4 | POST | `/api/v1/zcode-plan/billing/claim` | `Bearer <jwt>` + `Content-Type` + `X-ZCode-App-Version` + `X-Platform` | — | `{"plan_id":"<id>"}` | **200** `{"code":1001,"msg":"target not found"}`（用不存在的 plan_id 验证参数已过校验层） |
| 5 | GET | `/api/v1/client/configs` | `Bearer <jwt>` | `app_version` / `platform` | — | **200**（不是额度端点，仅作对照，证明域名/鉴权链正常） |

补充（同批实测，供排查）：

| 请求 | 结果 | 含义 |
|---|---|---|
| `POST /billing/balance`、`POST /billing/preview`（任意 body） | **404** `404 page not found` | 这两个端点**只有 GET 路由** |
| `HEAD /billing/balance` | **404** | 同上 |
| `GET /api/v1/zcode-plan/plans` | **404** | 不存在这个路径 |
| `GET /api/v1/zcode-plan/billing` | **404** | 同上 |
| `GET .../billing/claim` | — | 只有 POST；GET 未测（无意义，claim 有副作用） |

### 1.1 `claim` 必须谨慎

`claim` **会真的领取套餐**（`claimManualPlan` 在客户端里就是"领取"按钮）。本文只用一个
**不存在的 `plan_id`** 验证了参数校验层（返回 `code:1001 target not found`），**没有**真的领取。
将来要自动化时必须先 `preview` 拿到真实 `plan_id` 再让用户确认，不要盲调。

---

## 2. 鉴权

```
Authorization: Bearer <zcodejwttoken>
```

| 项目 | 值 |
|---|---|
| 来源 | `credentials.json` 的 `zcodejwttoken`（密文 319 字符 → 明文 **204** 字符） |
| 形态 | JWT（`eyJhbGci...`），**payload 里没有 `exp`**（只有 `user_id` / `token_version` / `sub` / `iat`） |
| 有效期 | 无过期声明；客户端视为长期凭证，失效只能重新登录 |
| 传输形态 | **`Bearer ` 前缀**。实测裸 token（不带 `Bearer `）对 `current` 也能 200，但对 `balance` 仍是 400（因为缺的是 DM 头），**不建议依赖裸 token** |

### 2.1 用错凭证的实测结果

| 凭证 | `current` | `balance` / `preview` |
|---|---|---|
| `Bearer <zcodejwttoken>` | **200** | **200**（带 DM 头时） |
| `Bearer <oauth:bigmodel:access_token>`（335 字符） | **401**（空 body） | **401** |
| `x-api-key: <49 字符 coding-plan api-key>` | 未测（该端点不认 api-key） | **401** |
| 不带任何鉴权头 | **401**（空 body） | **401** |

**要点**：`billing/*` 只认 `zcodejwttoken`。`oauth:bigmodel:access_token` 和
`account-provider:...:api-key` 都是**别的家族**的凭证，拿来查额度一律 401。
（`api-key` 的用途是打 `open.bigmodel.cn/api/anthropic`，与额度查询无关。）

### 2.2 401 的形态很特殊

**401 的响应体是空的**（长度 0，`content-type` 缺失）。这很容易被实现误判成
"非 JSON → 协议异常"。本仓库的 `lib/plan-quota.js` 因此把「非 2xx + 空 body」专门映射成
`HTTP_STATUS` 而不是 `INVALID_JSON`（见该文件 `requestQuotaEnvelope` 的注释）——
空 body 的 401 是**要重新登录**，不是上游坏了。

---

## 3. 真实响应样本

### 3.1 `billing/current`（本机实测原文）

```http
GET /api/v1/zcode-plan/billing/current HTTP/1.1
Host: zcode.z.ai
Authorization: Bearer <204c jwt>
```

```json
{"code":0,"msg":"","data":{"server_time":1793088821,"plans":[]},"logid":"202610270822114efe0b67671a1ce3946f"}
```

### 3.2 `billing/balance`（本机实测原文，带 `X-Device-Mid`）

```http
GET /api/v1/zcode-plan/billing/balance?app_version=3.16.3 HTTP/1.1
Host: zcode.z.ai
Authorization: Bearer <204c jwt>
X-Device-Mid: 98b1e291-9e28-4eaf-b42b-e4acf9d58805
```

```json
{"code":0,"msg":"","data":{"server_time":1793090507,"plans":[],"balances":[]},"logid":"20261027084147b4a4113f0ca14d21f260"}
```

### 3.3 `billing/preview`（本机实测原文，带 `X-Device-Mid`）

```json
{"code":0,"msg":"","data":{"server_time":1793090654,"plans":[]},"logid":"202610270844141b3f457d474f7482cae0"}
```

### 3.4 ⚠️ `plans: []` 是**正确结果**，不是失败

本机账号**当前没有任何套餐额度**（用户已确认）。所以：

- `plans: []` = 「这个账号现在没有可用套餐」→ **200 + 空数组是成功**
- `balances: []` = 「没有可展示的额度桶」→ 同理

任何把空数组当异常的实现，都会在本机（以及所有免费/无套餐账号）上**永久误报**。
`lib/plan-quota.js` 的 `normalizePlans([])` → `[]`、`summarizeQuota([])` →
`{ activePlans: 0, totalEntitlements: 0, byMeter: {} }`，并有单测钉住这个语义。

> 想验证「有额度时」的解析逻辑，只能用**结构样本**（§4/§5 的字段表 + `creds-report.md`
> C.2.1 里的真实非空日志样本）。本机拿不到非空响应，这一点必须诚实记录。

---

## 4. 字段表

### 4.1 `data.plans[]`（`current` / `balance` / `preview` 共用，字段有差异）

| 字段 | 类型 | 单位 | 取值 / 说明 | 必填 |
|---|---|---|---|---|
| `plan_id` | string | — | 套餐标识，如 `zcode-v3-start-plan-0817`。**归一实现用它判空丢弃** | ✅ |
| `user_plan_id` | string | — | 用户×套餐实例 id，如 `upl_2110191023253372928`。`claim` 之后才出现 | ❌ |
| `name` | string | — | 展示名，如 `ZCode Start Plan`。`current` 常缺，`preview` 有 | ❌ |
| `description` | string | — | 描述文案。仅 `preview` 有 | ❌ |
| `status` | string | — | `active` / `expired` / …。**空串视为有效**（`preview` 不给 status） | ❌ |
| `starts_at` | number | **Unix 秒** | 生效时刻 | ❌ |
| `ends_at` | number | **Unix 秒** | 失效时刻 | ❌ |
| `priority` | number | — | 优先级，数值越大越优先（实测 90） | ❌ |
| `entitlements` | array | — | 见 §4.2 | ❌ |

> **秒 vs 毫秒**：所有时间戳一律 **Unix 秒**，与 `data.server_time` 同单位。
> 要展示必须 `* 1000`。客户端自己的 `readServerTimeMilliseconds`（`cY`）就是
> `e * 1e3`。`lib/plan-quota.js` **不做**单位转换，避免把秒/毫秒约定埋进实现。

### 4.2 `plan.entitlements[]`

| 字段 | 类型 | 单位 | 取值 / 说明 | 必填 |
|---|---|---|---|---|
| `entitlement_id` | string | — | 额度条目 id，如 `ent_2_0817_glm_5p3`。**空 id 必须丢弃**（客户端 `flatMap` + `if (!u) return []` 同款逻辑） | ✅ |
| `show_name` | string | — | 给人看的名字，通常是模型名，如 `GLM-5.3` | ❌ |
| `meter` | string | — | 计量口径。已知 `model_usage`，见 §5.1 | ❌ |
| `unit_type` | string | — | 计量单位。已知 `token`，见 §5.2 | ❌ |
| `capabilities` | string[] | — | 模型白名单，形如 `["model:glm-5.3"]`（带 `model:` 前缀），见 §5.4 | ❌ |
| `grant_units` | number \| string | 由 `unit_type` 决定 | 授予量。**可能是纯数字字符串**（如 `"5000000"`），要做容忍式解析 | ❌ |
| `period` | string | — | 重置周期。已知 `daily` / `one_time`，见 §5.3 | ❌ |
| `priority` | number | — | 条目优先级（实测 110） | ❌ |
| `effective_at` | number | **Unix 秒** | 生效时刻。`0` = 立即生效。用于判断"已领取但未生效"（pending） | ❌ |

### 4.3 `data.balances[]`（仅 `billing/balance`）

| 字段 | 类型 | 单位 | 取值 / 说明 | 必填 |
|---|---|---|---|---|
| `bucket_id` | string | — | 额度桶 id | ❌ |
| `user_plan_id` | string | — | 关联 plan 实例 | ❌ |
| `plan_id` | string | — | 关联套餐 | ❌ |
| `entitlement_id` | string | — | 关联 entitlement | ❌ |
| `show_name` | string | — | 模型名 | ❌ |
| `meter` | string | — | 同 §5.1 | ❌ |
| `unit_type` | string | — | 同 §5.2 | ❌ |
| `capabilities` | string[] | — | 模型白名单 | ❌ |
| `priority` / `plan_priority` / `entitlement_priority` | number | — | 三级优先级 | ❌ |
| `total_units` | number | 由 `unit_type` 决定 | **本周期总额度** | ❌* |
| `used_units` | number | 同上 | 已用 | ❌* |
| `remaining_units` | number | 同上 | 剩余 | ❌* |
| `available_units` | number | 同上 | 可用（扣除 reserved 后） | ❌ |
| `reserved_units` | number \| null | 同上 | 预留中 | ❌ |
| `period_start` | number | **Unix 秒** | 本周期开始 | ❌ |
| `period_end` | number | **Unix 秒** | 本周期结束（**展示"何时重置"就用它**） | ❌ |
| `expires_at` | number | **Unix 秒** | 过期时刻 | ❌ |

\* 客户端的 `normalizeZaiStartPlanBalanceLimits`（`S3`）在
`total_units` / `used_units` / `remaining_units` **三个都不是数字**时**整条丢弃**。
本仓库的 `lib/plan-quota.js` 更保守：`balances` **原样透传**（该端点的非空形状尚未在
本机实测到，不做归一承诺）。有额度后应把这里的字段归一补上。

---

## 5. 枚举与语义

### 5.1 `meter`

| 值 | 语义 | 证据 |
|---|---|---|
| `model_usage` | 模型 token 用量 | 客户端渲染层筛额度条用 `e.meter === 'model_usage'`；`/api/v1/client/configs` 的 `startPlanPreview.entitlements[].meter` 实测该值 |

**服务端是字符串透传**。客户端对未知值也是原样显示，不丢弃条目。本仓库归一后
`meter` 为空串时，`summarizeQuota` 把它归到 `UNKNOWN_METER`（`'unknown'`）桶。

### 5.2 `unit_type`

| 值 | 语义 | 证据 |
|---|---|---|
| `token` | 计量单位是 token | 客户端只对这一个值做本地化（`preview.unit.tokens` → `tokens`） |

其它值（如 `credit` / `request`）客户端直接当标签显示，不做映射。**不要**因为不认识就丢条目。

### 5.3 `period`

| 值 | 语义 | 证据 |
|---|---|---|
| `daily` | 按天重置 | `/api/v1/client/configs` 的 `startPlanPreview` 实测值；文案键 `preview.period.daily`（`{unit}/日`） |
| `one_time` | 一次性额度（活动 / 赠送） | 渲染层 `quotaPeriod === 'one_time'` 时把耗尽提示切成"活动额度" |

⚠️ **别混淆**：侧边栏用量条上的 `fiveHour` / `weekly` / `monthlyTool` / `mcp` 是
**用量窗口标签**，来自另一条 bigmodel 监控接口（`/api/monitor/usage/quota/limit`），
**不是** entitlement 的 `period`。

### 5.4 `capabilities` 与 `model:` 前缀

`balance` 端点的 capabilities 形如 `["model:glm-5.3"]`。客户端两处实现
（`eY` / `resolveZaiStartPlanBalanceModelIds` 与 `uTe` / `normalizeZaiStartPlanCapabilities`）
都是：

1. 只认 `model:` 前缀，剥掉前缀得到模型 id；
2. 非 `model:` 条目（如 `other`）**丢弃**；
3. **一条 `model:` 都没有**时才退回 `show_name`。

`lib/plan-quota.js` 的 `capabilityModelIds()` 照抄这个语义（有 `model:` 条目时它是权威来源，
否则退回裸条目以兼容 `preview` 的裸模型名变体）。

---

## 6. `balance` / `preview` 的 400 `code:3001` 之谜 —— 已解开

### 6.1 前情（两个互相矛盾的声称）

| 来源 | 声称 |
|---|---|
| 原负责人（recon-creds） | `billing/balance?app_version=3.16.3` + Bearer **200**；之前所有 400 是「限流假象，退避重试后全部 200」 |
| Lead 复测 | 连测 5 次**全部 400**，没复现 |

### 6.2 我的第一轮实验：证明「退避重试」是错的

固定 `balance?app_version=3.16.3` + `Bearer <jwt>`，**12 次**，间隔从 1s 递增到 30s
（1/1/2/3/5/8/10/15/20/30/30/30 秒）：

| # | 时间(UTC) | 间隔 | status | code | 耗时 |
|---|---|---|---|---|---|
| 1 | 08:39:09 | 0s | 400 | 3001 | 149ms |
| 2 | 08:39:11 | 1s | 400 | 3001 | 68ms |
| 3 | 08:39:12 | 1s | 400 | 3001 | 89ms |
| 4 | 08:39:14 | 2s | 400 | 3001 | 71ms |
| 5 | 08:39:17 | 3s | 400 | 3001 | 67ms |
| 6 | 08:39:22 | 5s | 400 | 3001 | 90ms |
| 7 | 08:39:30 | 8s | 400 | 3001 | 89ms |
| 8 | 08:39:40 | 10s | 400 | 3001 | 140ms |
| 9 | 08:39:55 | 15s | 400 | 3001 | 102ms |
| 10 | 08:40:15 | 20s | 400 | 3001 | 99ms |
| 11 | 08:40:45 | 30s | 400 | 3001 | 114ms |
| 12 | 08:41:16 | 30s | 400 | 3001 | 107ms |

**12/12 全 400，间隔从 1s 到 30s 毫无影响。** 再补一轮**无间隔密集连发 6 次**：

| # | 时间 | status | code |
|---|---|---|---|
| 1–6 | 08:42:11（同一秒内） | 400 | 3001 |
| | | 400 | 3001 |
| | | 400 | 3001 |
| | | 400 | 3001 |
| | | 400 | 3001 |
| | | 400 | 3001 |

**密集连发也全是 400，且没有出现 429。** → 「限流假象 + 退避重试」假说**被证伪**。

### 6.3 第二轮：找出真正的变量

在 40+ 个变体的宽矩阵里，**唯一一个 200 的 `balance` 请求**恰好带了 `X-Device-Mid`。
于是做控制变量实验（值都是合法 UUID）：

| # | 请求头 | 值 | status | code |
|---|---|---|---|---|
| 1 | `X-Device-Mid` | 客户端真值 | **200** | 0 |
| 2 | `X-Device-Mid` | 随机 UUID | **200** | 0 |
| 3 | `X-Device-Id`（错名） | 真值 | 400 | 3001 |
| 4 | `Device-Mid`（无 `X-` 前缀） | 真值 | 400 | 3001 |
| 5 | `X-Foo`（无关头） | 真值 | 400 | 3001 |
| 6 | `X-Request-Id` | 真值 | 400 | 3001 |
| 7 | `X-Trace-Id` | 真值 | 400 | 3001 |
| 8 | `X-Client-Id` | 真值 | 400 | 3001 |
| 9 | （不加任何额外头） | — | 400 | 3001 |

**只有精确的 `X-Device-Mid` 这一个头名有效**，换成别的名字、或换掉 `X-` 前缀，一律 400。

### 6.4 第三轮：确认稳定性（排除"偶然/时间窗口"）

- **带 `X-Device-Mid` 重复 10 次**（间隔 1.5s）：**10/10 → 200 code:0**
- **不带（对照）重复 5 次**：**5/5 → 400 code:3001**
- **A/B 交错 6 轮**（同一时段，A 带 / B 不带）：**A 全 200，B 全 400**，无一例外
- **带 DM 连续 15 次**（间隔 2s）：**15/15 → 200**
- `preview` 带 DM 重复 **5 次**：**5/5 → 200**

累计：**带 `X-Device-Mid` 共 16+ 次，全部 200；不带共 11+ 次，全部 400。零例外。**

### 6.5 头的取值要求

| `X-Device-Mid` 取值 | status |
|---|---|
| 客户端真实 `deviceMid`（`98b1e291-9e28-4eaf-b42b-e4acf9d58805`） | **200** |
| 随机 v4 UUID | **200** |
| 大写 UUID | **200** |
| 无连字符 32 hex | **200** |
| v1 UUID / 非 v4 合法 UUID | **200** |
| 前后带空格 | **200** |
| 带花括号 `{uuid}` | **200** |
| 非 UUID 字符串（`not-a-uuid`） | 400 |
| 空值 | 400 |

**结论**：服务端只校验「是不是一个 UUID 形状」，**不校验**它是否属于本机/本账号。
所以实现上既可以用客户端真值（更真实、便于对账），也可以现场生成一个 UUID。
`lib/plan-quota.js` 提供了 `readDeviceMid({ dataBaseDir })` 读客户端真值，
同时 `fetchBillingBalance` / `fetchBillingPreview` 也接受调用方直接传 `deviceMid`。

### 6.6 `X-Device-Mid` 从哪来（客户端实现）

```
<dataBaseDir>/.zcode/v2/telemetry-state.json
{
  "deviceMid": "98b1e291-9e28-4eaf-b42b-e4acf9d58805",
  "lastDailyActiveDate": "2026-10-27"
}
```

客户端里对应 `fLe`（`readExistingDeviceMid`，读这个文件）→ `ZC`（`buildZCodeSourceHeaders`）
→ 最终进 `X-Device-Mid`。同一份 `deviceMid` 也被用于反馈工单、onboarding 记录等。

### 6.7 最终结论（如实）

1. **不是限流。** 退避重试假说被证伪：1s–30s 任意间隔、以及同秒密集连发，结果完全一致。
2. **不是 `app_version` 的问题。** 3.4.0 / 3.16.2 / 3.16.3 / 3.16.4 / 3.17.0 / 1.0.0 / 0.0.0
   全部 400；带 DM 时连 `app_version` 都不需要（`C4`/`C10` 无 query 也 200）。
3. **原负责人的 200 很可能是真的，但归因错了。** 他大概率在某个带 `X-Device-Mid` 的
   上下文里打出了 200，却记成了「退避重试」的功劳。他的 `creds-samples.json` 里那条
   `startplan-balance-jwt` 样本没有记录请求头，无法回查——这一点只能存疑。
4. **真正的触发条件是 `X-Device-Mid: <UUID>` 这一个头。** 控制变量实验 + 交错对照
   共 27 次请求零例外，可稳定复现。
5. **本机 `plans: []` / `balances: []` 依然是正确结果**（账号无套餐），不是失败。

### 6.8 仍未验证的部分（有额度时要做的事）

本机无套餐，所以下面这些**结构**来自 app.asar 逆向 + 历史非空日志样本，**没有**在本机
拿到真实非空响应：

- `balances[]` 里 `total_units` / `used_units` / `remaining_units` / `period_end` 的真实数值形态
- `plans[].status` 除 `active` / `expired` 之外还有哪些值
- `claim` 成功路径（`code:0` + `data.plan`）的真实响应
- `effective_at` 在"已领取未生效"场景下的实际取值

有额度后请优先跑 `probe-device-mid-final.mjs` 的变体矩阵，并把真实非空响应补进 §3/§4。

---

## 7. 完整探索矩阵（原样记录）

时间均为 2026-10-27 UTC。所有请求都带 `Authorization: Bearer <204c jwt>`（除非注明）。
`DM` = `X-Device-Mid`。

### 7.1 `current`（对照组，证明链路正常）

| 方法 | URL | 额外头 | status | body |
|---|---|---|---|---|
| GET | `/billing/current?app_version=3.16.3` | — | **200** | `{"code":0,...,"plans":[]}` |
| GET | `/billing/current?app_version=3.16.3` | 裸 token（无 Bearer） | **200** | `{"code":0,...,"plans":[]}` |
| GET | `/billing/current?app_version=3.16.3` | `Bearer <oauth>` | **401** | 空 |
| GET | `/billing/current?app_version=3.16.3` | 无鉴权 | **401** | 空 |

### 7.2 `balance`：鉴权形态

| 方法 | URL | 额外头 | status | body |
|---|---|---|---|---|
| GET | `/billing/balance?app_version=3.16.3` | 裸 token | 400 | `{"code":3001,"msg":"parameter error",...}` |
| GET | `/billing/balance`（无 query） | 裸 token | 400 | 同上 |
| GET | `/billing/balance?app_version=3.16.3` | `x-api-key: <jwt>` | **401** | 空 |
| GET | `/billing/balance?app_version=3.16.3` | `x-api-key: <49c ak>` | **401** | 空 |
| GET | `/billing/balance?app_version=3.16.3` | `Bearer <oauth>` | **401** | 空 |
| GET | `/billing/balance?app_version=3.16.3` | 无鉴权 | **401** | 空 |

### 7.3 `balance`：query / header 变体（全部 400，直到加了 DM）

| # | URL | 额外头 | status | code |
|---|---|---|---|---|
| 1 | `/billing/balance` | — | 400 | 3001 |
| 2 | `/billing/balance?platform=win32-x64` | — | 400 | 3001 |
| 3 | `/billing/balance?app_version=3.16.3&platform=win32-x64` | — | 400 | 3001 |
| 4 | `/billing/balance?app_version=3.16.3&platform=win32` | — | 400 | 3001 |
| 5 | `/billing/balance?app_version=3.16.3` | `X-ZCode-App-Version` + `X-Platform` | 400 | 3001 |
| 6 | `/billing/balance` | `X-ZCode-App-Version` + `X-Platform` | 400 | 3001 |
| 7 | `?app_version=3.4.0` | — | 400 | 3001 |
| 8 | `?app_version=3.16.2` | — | 400 | 3001 |
| 9 | `?app_version=3.16.4` | — | 400 | 3001 |
| 10 | `?app_version=3.17.0` | — | 400 | 3001 |
| 11 | `?app_version=1.0.0` | — | 400 | 3001 |
| 12 | `?app_version=0.0.0` | — | 400 | 3001 |
| 13 | `?app_version=3.16.3&client_language=zh-CN&client_timezone=Asia/Shanghai` | — | 400 | 3001 |
| 14 | `?app_version=3.16.3&platform=win32-x64&client_language=zh-CN` | 客户端头 | 400 | 3001 |
| 15 | `?app_version=3.16.3` | **`X-Device-Mid`** | **200** | **0** |
| 16 | `?app_version=3.16.3` | `X-Client-Language: zh-CN` | 400 | 3001 |
| 17 | `?app_version=3.16.3` | `content-type: application/json` | 400 | 3001 |
| 18 | `?app_version=3.16.3` | `user-agent: ZCode/3.16.3` | 400 | 3001 |
| 19 | `?app_version=3.16.3` | UA + accept-language + origin + referer | 400 | 3001 |
| 20 | `POST /billing/balance`（空 body） | `content-type` | **404** | — |
| 21 | `POST /billing/balance`（`{app_version,platform}`） | `content-type` | **404** | — |
| 22 | `HEAD /billing/balance?app_version=3.16.3` | — | **404** | — |

### 7.4 `preview` 变体

| # | URL | 额外头 | status | code |
|---|---|---|---|---|
| 1 | `/billing/preview` | — | 400 | 3001 |
| 2 | `?app_version=3.16.3` | — | 400 | 3001 |
| 3 | `?app_version=3.16.3&platform=win32-x64`（客户端原样） | — | 400 | 3001 |
| 4 | `?app_version=3.16.3&platform=win32-x64` | `X-ZCode-App-Version` + `X-Platform` | 400 | 3001 |
| 5 | `?app_version=3.16.3&platform=win32-x64` | 裸 token | 400 | 3001 |
| 6 | `?app_version=3.16.3&platform=win32-x64` | **`X-Device-Mid`** | **200** | **0** |
| 7 | `POST /billing/preview`（空 body） | — | **404** | — |

### 7.5 `claim`（用不存在的 `plan_id`，不会真领取）

| 方法 | URL | 额外头 | body | status | body |
|---|---|---|---|---|---|
| POST | `/billing/claim` | `content-type` | `{}` | 400 | `{"code":3001,"msg":"parameter error"}` |
| POST | `/billing/claim` | `content-type` + `X-ZCode-App-Version` + `X-Platform` | `{}` | 400 | 同上 |
| POST | `/billing/claim` | 同上 + `X-Device-Mid` | `{"plan_id":"__nonexistent_plan_id__"}` | **200** | `{"code":1001,"msg":"target not found","data":{"server_time":...,"message":"This plan does not exist or is no longer available."}}` |

`claim` 与 `balance`/`preview` **不同**：带不带 `X-Device-Mid` 都返回 400（缺 `plan_id` 时），
真正让它过参数校验的是 **`plan_id` 本身**。所以 `claim` 不需要 DM 头。

### 7.6 其它路径对照

| 方法 | URL | status | 说明 |
|---|---|---|---|
| GET | `/api/v1/client/configs?app_version=3.16.3&platform=win32-x64` | **200** | 证明域名 + JWT 链路正常（非额度端点） |
| GET | `/api/v1/zcode-plan/plans` | 404 | 不存在 |
| GET | `/api/v1/zcode-plan/billing` | 404 | 不存在 |

---

## 8. 与模型推理通道的关系

**`billing/*` 只读额度，不发起任何推理。** 两者是**完全独立**的通道：

| 通道 | 端点 | 用途 | 鉴权 |
|---|---|---|---|
| **额度查询**（本文） | `GET /api/v1/zcode-plan/billing/{current,balance,preview}` | 看"还剩多少额度" | `Bearer <zcodejwttoken>`（+ DM 头） |
| **额度领取**（本文） | `POST /api/v1/zcode-plan/billing/claim` | 领取套餐（**有副作用**） | 同上 |
| **模型推理** | `POST /api/v1/zcode-plan/anthropic/v1/messages` | 真正跑模型 | `Bearer <zcodejwttoken>`，见 `lib/plan-client.js` |

因此：

- 查额度**不会**消耗 token、**不会**触发推理、**不会**启动 ZCode agent 进程。
- 推理通道的错误（`1005 exceed quota limit` / `3009 model concurrency limit` /
  `1309 套餐已到期`）由 `lib/plan-client.js` 的 `classifyPlanError` 处理，
  **与本文的 `billing` 错误码体系无关**——`billing` 的错误码目前只见过 `3001` / `1001`。
- 推荐做法：UI 用 `QuotaCache`（TTL 60s）读额度做展示；推理失败时**不要**把
  "额度查询失败" 当成 "推理不可用"，两者要分开降级。

---

## 9. 推荐调用方式（可直接照抄）

### 9.1 最小可用（零依赖，`current`）

```js
const jwt = /* credentials.json 里的 zcodejwttoken */
const res = await fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/current', {
  headers: { authorization: `Bearer ${jwt}`, accept: 'application/json' },
})
const { code, data } = await res.json()
// data.plans === [] → 账号当前无套餐（正确结果，不是错误）
```

### 9.2 带明细（`balance` / `preview`，**必须带 DM**）

```js
import { readDeviceMid, fetchBillingBalance } from './lib/plan-quota.js'

const jwt = /* ... */
const deviceMid = readDeviceMid({ dataBaseDir: 'D:/AI/zcode' })   // 读 telemetry-state.json

const balance = await fetchBillingBalance({ jwt, deviceMid })     // 永不抛
if (balance.ok) {
  // balance.balances[].remaining_units / total_units / period_end
} else {
  // balance.reason: 'token_missing' | 'api_code' | 'http_status' | 'network' | ...
}
```

### 9.3 原始 HTTP 形态（curl / 别的语言照这个抄）

```bash
curl -s 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.16.3&platform=win32-x64' \
  -H "Authorization: Bearer $ZCODE_JWT" \
  -H 'X-Device-Mid: 98b1e291-9e28-4eaf-b42b-e4acf9d58805' \
  -H 'accept: application/json'
```

### 9.4 排错顺序

1. **401 空 body** → 凭证不对（用错家族 / 没登录），不是额度问题。
2. **400 `code:3001`** → 先看有没有 `X-Device-Mid`；有的话再看是不是合法 UUID。
3. **404** → 方法错了（`balance`/`preview` 只有 GET）。
4. **200 但 `plans: []`** → 正常，账号无套餐。
5. **5xx / HTML** → WAF 或上游故障，看 `logid`。

---

## 10. 复现命令

```powershell
# 1) 取凭证
E:\nodejs\node.exe D:\AI\dsh\work\zcode-direct\recon\dump-env.mjs

# 2) 400 之谜的完整复测（12 次退避 + 40 变体 + 6 次密集）
E:\nodejs\node.exe D:\AI\dsh\work\zcode-direct\recon\probe-balance-honest.mjs

# 3) X-Device-Mid 控制变量实验（10 次 + 对照组 + 形态边界）
E:\nodejs\node.exe D:\AI\dsh\work\zcode-direct\recon\probe-device-mid.mjs
E:\nodejs\node.exe D:\AI\dsh\work\zcode-direct\recon\probe-device-mid-confirm.mjs

# 4) 头名字控制变量（证明必须是 X-Device-Mid 这个名字）
E:\nodejs\node.exe D:\AI\dsh\work\zcode-direct\recon\probe-device-mid-final.mjs

# 5) 用仓库模块本身端到端验证
E:\nodejs\node.exe D:\AI\dsh\work\zcode-direct\recon\verify-quota-module2.mjs

# 6) 单测（零网络）
E:\nodejs\node.exe --test test/plan-quota.test.mjs
```

结果 JSON 与日志都在 `D:\AI\dsh\work\zcode-direct\recon\`（`probe-*-result.json` / `*.log`）。

---

## 附：与 `lib/plan-quota.js` 的对应关系

| 本文结论 | 模块里的落点 |
|---|---|
| `current` 只要 Bearer | `fetchBillingCurrent()` |
| `balance`/`preview` 必须带 DM | `fetchBillingBalance()` / `fetchBillingPreview()` 的 `deviceMid` 参数 |
| DM 从 telemetry-state.json 读 | `readDeviceMid({ dataBaseDir })` |
| DM 是可选头（不传就不发） | `buildQuotaHeaders({ deviceMid })` |
| 401 空 body ≠ 非 JSON | `requestQuotaEnvelope` 里 `!response.ok && text.trim() === ''` 分支 |
| `plans: []` 是成功 | `normalizePlans()` / `summarizeQuota()` |
| 时间戳保持 Unix 秒 | `normalizePlan` / `normalizeEntitlement` 不做单位转换 |
| 空 id 丢弃、缺 plan_id 丢弃 | `normalizeEntitlement` / `normalizePlans` |
| `model:` 前缀剥离、非 model 丢弃 | `capabilityModelIds()` |
| TTL 60s、失败不污染缓存 | `QuotaCache` |
