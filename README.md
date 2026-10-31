# dsh-connect-zcode

把 **ZCode 账号的套餐额度**（Start Plan / Coding Plan）接入 **DeepSeek​ Harness（DSH）** 的本地插件。

**0.7.0 起默认走直连通道**：provider `zcode-plan` 直接 `POST` 计划端点的
`/v1/messages`（Anthropic Messages 兼容），**不启动任何子进程**、不需要 API Key、
不需要自建网关，烧的就是 ZCode 账号的套餐额度。登录可以完全脱离 ZCode 客户端
（插件自带设备码 OAuth）。旧的「托管 ZCode agent」通道保留为 `transport: agent`。

当前版本 **0.7.0**。

本仓库：<https://github.com/shudaozhang/dsh-connect-zcode> ·
上游原版：<https://github.com/kyle123740/dsh-zcode-cli-proxy>（AGPL-3.0）

> **v0.7.0：直连计划额度，删掉 agent 中间层。** 计划端点本身就是 Anthropic Messages
> 兼容接口，凭证就在本机磁盘上，所以「让 ZCode 的 agent 替我们发请求」这一步是多余的。
> 0.6.x README 里「HTTP 直连会被 WAF 拦、只有 agent 的签名请求能过」的结论**已被实测推翻**
> —— 详见下面「推翻了 0.6.x 的三条错误结论」。直连通道不跑子进程，因此也不再存在
> 「agent 以当前用户权限运行、在 DSH 权限边界之外」的问题。详见 [CHANGELOG](CHANGELOG.md)。

## 它能做什么

- **直连套餐额度**（`transport: plan`，默认）：按 `providerId` 选端点与鉴权形态，
  直接调 `.../v1/messages`。真流式（text / reasoning / tool_use 增量）、工具调用、
  图片输入全部支持。
- **一个模型只出现一次，套餐之间自动切换**：`planRouteMode: merged`（默认）下模型选择器
  里就是 `GLM-5.3-Flash`，插件按套餐优先级自己挑路由，额度用尽就换下一份套餐。
  想手动指定烧哪份额度就切 `explicit`。
- **登录授权**：`login` 命令走设备码 OAuth —— 打印一个授权 URL，用户在任意浏览器确认，
  插件轮询拿回 `zcodejwttoken`。**不需要装 ZCode 客户端，不需要本地监听端口。**
- **额度查询**：`quota` 命令读 `billing/current`（免费、不耗额度），展示套餐与 entitlement。
- **路由表可诊断**：`plan-models` 列出全部路由与模型（离线）。10 条 `account:*` 路由 /
  22 条路由-模型对 / **4 个不同模型**。
- **逐模型启用/停用**：插件页卡片里勾选，保存后 DSH 的模型选择器随即增减。
  `merged` 模式下还能按路由停用（只摘掉某份套餐，模型保留）。
- **旧通道保留**：`transport: agent` 仍是原来的托管形态（自动发现客户端、拉起内置 agent、
  推送套餐账号 provider、按路由选签名凭证）。

> 换机器 / 换账号后如果套餐不可用，上游业务错误（例如
> `1309 您的GLM Coding Plan套餐已到期`、`1005 exceed quota limit`）会被 `quota` /
> `plan-turn` 原样报出来，**并且会标明「已到达业务层，通道正常」**，不会伪装成协议故障。



> **与上游 0.3.x 的差异（v0.4.x，基于实机逆向重写通道层）**
>
> 上游假定「DSH 侧注入 Start Plan 账户 + 硬编码模型清单」，实测在 npm 版 CLI
> （`zcode-app-cli`）上这两条都错：
>
> 1. **CLI 处于 standalone 模式，拒绝宿主注入**。`provider/updateAccountConfig` 直接回
>    `Error: Standalone Account 由本进程管理，不接收 Host 覆盖`。账号本来就被 CLI 自己管着，
>    注入既不可能也没必要 —— 已删除。
> 2. **同时设 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 与 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
>    会让 CLI 直接起不来**，stderr 固定为 `Error: Bundled 与 Active ZCode Built-in Release 均不可用`，
>    而且不服务任何请求。桌面客户端写出的 builtin `revision` 一旦超过当前 CLI 能解的 schema，
>    就必然踩中。已彻底不再注入任何 `ZCODE_*` 环境变量。
> 3. **模型清单改为读 CLI 上报**。`session/create` 的 `settings.model.available` 是权威清单；
>    上游硬编码的 `200000 / 64000 / [FALLBACK_MODELS]` 与实机差 5 倍（真实
>    `contextWindow=1000000`、`maxOutputTokens=128000`），provider id 也不同。
> 4. **provider id 不再硬编码**。上游写死 `account:zai-start-plan`，但 standalone 下该 provider
>    不进入 registry；实机是 `account:zai-individual-coding-plan`。
>
> 通道逻辑（回合锁、自愈、事件流、图片物化）沿用上游的逆向结论并补了对应改造，版权归上游作者。

```
DSH Agent ──► provider "zcode-cli" ──► ZcodeAppServerAdapter
                                            │  spawn zcode.cjs app-server --stdio（常驻）
                                            ├─ session/create    拿 settings.model.available（模型清单）
                                            ├─ session/subscribe  desktop-continuous 事件流
                                            ├─ session/setModel   仅在目标模型与当前不同时切换
                                            ├─ session/send      发回合（真流式）
                                            └─ interaction/requestProviderRuntimeHeaders  回 OAuth 鉴权
                                                  └──► zcode.z.ai/api/v1/zcode-plan/anthropic
```

## 安装

**前置条件**：本机已安装并登录 **ZCode 桌面客户端**（有可用额度的账号）。没有客户端时插件不会注册 provider。

### 方式一：直接从 GitHub 安装（当前推荐）

```powershell
dsh plugin --profile desktop add shudaozhang/dsh-connect-zcode
```

`--profile` 换成你的 profile 名（通常是 `desktop` 或 `web`）。等效的 pnpm 写法：

```powershell
pnpm add github:shudaozhang/dsh-connect-zcode
```

> 本仓库暂未发布到 npm，所以**不要**用 `add dsh-connect-zcode`（会 404）。
> GitHub 安装已实测通过：`+ dsh-connect-zcode 0.6.1`。

### 方式二：DSH 插件市场（上架后可用）

DSH → 插件 → 发现 → 搜索 `dsh-connect-zcode` → 安装 → 重启 DSH。

### 方式三：本地目录装配（开发用）

见下方「开发」章节里 `cordis.patch.yml` 的 `file://` 写法。

### 安装后

DSH 设置 → 模型（Models）→ 提供方 **zcode** → 选模型。
也可以到 **插件 → dsh-connect-zcode** 页面里勾选要启用哪些模型（见「选择启用哪些模型」）。

## 用法

1. 装一份 ZCode CLI（`npm i -g zcode-app-cli`，或桌面客户端自带的 `zcode.cjs`），并登录有额度的账号。
2. 把本插件装进 DSH profile，重启 DSH。
3. DSH 设置 → 模型（Models）→ 提供方 **zcode** → 选模型。

可用模型**不是插件写死的**，而是 CLI 当前账号能服务的那批，随账号套餐与客户端版本变化。
下例取自本机（2026-10-24，客户端 3.16.3 / 17 个模型）：

| provider | model | context | max output | image |
|---|---|---|---|---|
| `account:bigmodel-individual-coding-plan` | GLM-5.3 | 1000000 | 128000 | ✓ |
| `account:bigmodel-start-plan` | GLM-5.3-Flash | 1000000 | 128000 | ✓ |
| `account:bigmodel-start-plan` | GLM-5.2 | 1000000 | 128000 | ✓ |
| 个人 provider（`new-provider-*` 等） | qwen3.8-flash / deepseek-v4.1-flash 等 | 1000000 | 384000 | ✓ |

想看清本机能出哪些模型、各自的 provider 与能力位，跑 `node bin/dsh-connect-zcode.js models`。

同一 model id 出现在多个 provider 上时（如上表 GLM-5.3 同时在 `account:` 与 `zai-api` 上），
插件**优先 `account:` 开头的路由** —— 那条烧计划额度，`zai-api` 那条按 API Key 计费。
想指定确切路由，就在 `cliModels` 里给条目写 `id: "zai-api/GLM-5.3"`（`providerId/modelId` 形式）。

- 真流式（text/reasoning delta 直接转发）、工具调用、图片输入（图片以本地文件随消息附上，agent 用 Read 读图）
- 多轮会话按 DSH 的 sessionId 复用 app-server 会话
- 会话标题这类辅助调用在本地生成，不消耗额度
- 前置条件：本机能跑起 ZCode CLI，且它已登录有额度的账号

## 两条通道：直连额度（默认）与托管 agent（旧）

0.7.0 起本插件有两条互斥的模型通道，由配置项 `transport` 选择：

| `transport` | 是什么 | 是否启动子进程 | 烧哪份额度 |
|---|---|---|---|
| **`plan`（默认）** | 直接 `POST` 计划端点的 `/v1/messages` | **否** | ZCode 套餐额度 |
| `agent` | 托管 `ZCode.exe zcode.cjs app-server --stdio` | 是 | ZCode 套餐额度 |
| `both` | 两条都注册 | 是 | 取决于选哪条 |

### 直连通道（`transport: plan`）

计划端点本身就是 **Anthropic Messages 兼容接口**，凭证就在本机磁盘上：

```
POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
  Authorization: Bearer <zcodejwttoken>
  content-type: application/json
  anthropic-version: 2023-06-01
→ 200 {"code":1005,"msg":"exceed quota limit"}      ← 鉴权与路由均通过，只是本机无额度
→ 429 {"code":3009,"msg":"model concurrency limit exceeded"}
```

```
POST https://open.bigmodel.cn/api/anthropic/v1/messages
  x-api-key: <coding-plan api key>
→ 429 {"type":"error","error":{"code":"1309","message":"…套餐已到期…"}}
```

**`zcode.z.ai` 端点有客户端指纹层（0.11.0 起自动处理）**：只带 `Authorization` 会被判
`405 / 3012 异常活动`。插件会自动补齐 `x-api-key`（同一个 JWT）与 `ZCode/<版本>` 的
`user-agent`，并把 `system` 拼成「官方 preamble + 你的 prompt」的文本块数组。
`api.z.ai` / `open.bigmodel.cn` 的 coding-plan 端点**不需要**这层，插件不会给它们加头。

> 这一条是 0.7.0 写错过的结论：当时本机额度耗尽，业务层的 `1005` 先于指纹校验返回，
> 于是「拿到业务码」被读成了「指纹不存在」。额度到账后 3012 立刻出现。
> 详见 [`docs/official-api-access.md`](docs/official-api-access.md)。

**指纹补对了也可能撞上 3012（0.12.0 起单独归类）**：`/zcode-plan/anthropic/v1/messages`
与 `/highspeed/anthropic/v1/messages` 这两条**精确路径**上有一层上游 WAF 风控，只拦
POST + `authorization` 头。它排在鉴权与额度**之前**，所以：

- 与账号有没有额度**无关**（`quota` 命令同时能读到剩余额度）；
- **ZCode 官方客户端自己也会被拦**（同一条路径，同样的 3012）；
- 同一 token 打 `off-peak` / `ultra` 端点**能正常到达业务层**。

插件把它归到 `BLOCKED`：**不重试**（否则就是截图里那「已重试 5/5、8s」的空转），
**不 failover**（同域另一条被拦路径换过去也只是再吃一次 3012），错误文案直接写明
「不是额度问题，也不是配置错误」。`plan-turn` 会把实测对照逐条打出来。

遇到它只有两条路：等上游解除，或改用 `transport: agent`（走官方 agent 通道）。

鉴权形态按家族区分：`zcode-plan` 端点只收 Bearer JWT，`api.z.ai` / `open.bigmodel.cn`
只收 `x-api-key`；交叉用错一律 `401`。

### 套餐额度显示

模型选择器里每个模型的说明会带当前额度（0.12.0 起）：

```
GLM-5.3-Flash  start → coding → idle → fast (10 routes) · quota 4.97 亿/5.00 亿 (99%)
GLM-5.2        start (2 routes) · quota: no plan for GLM-5.2
GLM-5.3        coding → idle → fast (8 routes) · quota: no plan for GLM-5.3
```

额度是**按模型**发的：一份 Start Plan 只给 `GLM-5.3-Flash`，其余模型走 coding-plan，
所以没有对应额度的模型会明确写 `no plan for <model>`，而不是显示 0。

查不到额度时写 `quota unknown (<reason>)` 而不是 `0` —— `0` 会被读成「额度用完了」。
额度查询**永不阻塞列模型**：失败只是让说明里出现 `unknown`，模型照常可选。

想看完整数字用 `quota` 命令（含剩余 / 已用 / 到期时间）。

直连通道的模型清单有两种投影方式，由 `planRouteMode` 选择（默认 `merged`）：

| `planRouteMode` | DSH 模型 id | 模型数 | 路由由谁决定 | 自动切换 |
|---|---|---|---|---|
| **`merged`（默认）** | `GLM-5.3-Flash` | **4** | 插件按套餐优先级挑 | **有** |
| `explicit` | `account:zai-start-plan#GLM-5.3-Flash` | 22 | 用户显式指定 | 无 |

`merged` 模式下每个模型背后是一条**候选路由链**（start-plan → individual/team coding-plan
→ offpeak → highspeed）。请求时依次尝试，前一条额度用尽 / 凭证缺失 / 上游 5xx 就换下一条：

```
GLM-5.3-Flash
  start → coding → idle → fast (10 routes)
```

这条链会先去重：「拼出来的请求逐字节相同」的路由只留优先级最高的一条。
`account:zai-start-plan` 与 `account:bigmodel-start-plan` 实测指向**同一个 baseUrl** 且共用
同一个 `zcodejwttoken`，换过去只会白跑一趟 —— 本机实测把 `GLM-5.3-Flash` 的链从 10 条压到 2 条。

`explicit` 模式保留 0.7.0 的展开视图，用于「我就要烧 start-plan 这份额度，失败了别给我换」。
两种模式的配置写法互相兼容，切换模式不会让已有配置静默失效。

### 登录授权（脱离 ZCode 客户端）

插件可以自己完成登录，不需要装 ZCode 客户端：

```
POST {origin}/api/v1/oauth/cli/init        Authorization: Bearer <64c hex pollToken>
  {"provider":"zai"}                        → {flow_id, authorize_url, poll_interval_sec, expires_at}
→ 用户在浏览器打开 authorize_url 并确认
GET  {origin}/api/v1/oauth/cli/poll/{flow_id}
  → {"status":"ready", "token":"<zcodejwttoken>", "user":{...}, "zai":{access_token, refresh_token?}}
```

`zcodejwttoken` 是 **`ready` 响应直接给的**，不是换来的。凭证写进**插件自己的**文件
（`<dataBaseDir>/.zcode/dsh-plan-credentials.json`），**绝不写回** ZCode 客户端的
`credentials.json`（那个文件是客户端进程内锁的整文件读改写，外部写必丢）。

命令：`node bin/dsh-connect-zcode.js login [--family zai|bigmodel]`。

### 没装客户端也能用

路由表优先读客户端磁盘上的 builtin release；读不到时降级到内置快照（10 条路由）。
凭证优先用插件自己 `login` 写下的，客户端 `credentials.json` 只作补充。
所以「干净机器 + 插件自己登录」是完整可用的部署形态。

## 推翻了 0.6.x 的三条错误结论（以及 0.7.0 自己的一条）

0.6.x 的 README 与 `docs/official-api-access.md` 曾断言直连不可能。**那是错的**，
根因是当时把「签名链路存在」误当成「签名是必需的」：

| 0.6.x 的说法 | 实测（2026-10-27，客户端 3.16.3） |
|---|---|
| 直连套餐端点被 WAF 拦，`405 3012 异常活动` | ❌ 错的。带 `Authorization: Bearer <zcodejwttoken>` 能到业务层 |
| 只有 agent 二进制自己发的签名请求能过 | ❌ 错的。**模型请求主链路不需要 `X-Client-*` 签名** |
| 要烧套餐额度必须让 ZCode 的 agent 跑 | ❌ 错的。直连通道就是烧套餐额度，且不跑 agent |

但 0.7.0 顺手写下的第四句话 —— 「**不需要伪造客户端指纹**」 —— 在 2026-10-31 被推翻了：

| 0.7.0 的说法 | 实测（2026-10-31，额度到账后） |
|---|---|
| 逐字节复制 agent 的 header 仍被 405 3012，所以「根本不需要复制 header」 | ❌ 错的。**三项指纹头必须复制**，`system` 也要按官方形状拼成 2–3 个文本块 |
| 主链路不要签名（推论：指纹也不需要） | ⚠️ 一半对：`X-Client-*` 签名确实不需要，但**客户端指纹需要** |

原因是额度耗尽时业务层的 `1005` 先于指纹校验返回，把这一层完全遮住了。
**「某个机制没触发，不等于它不存在」** —— 这是比上一条更贵的教训。

签名链路（`lib/client-signing.js`，OAuth token → signing JWT → HKDF/HMAC 握手 → AES-GCM
解包 Ed25519 → 签业务请求）**确实存在也确实能用**，但它服务于另一条路径（project api-key
走 AI 网关），不是模型推理。该模块保留，默认不参与直连通道。

客户端指纹层由 `lib/plan-preamble.js` 处理（官方 preamble + 三项头），与上面那套签名
是**两套独立机制**，不要混为一谈。

> **`X-Device-Mid` 那个坑**：`billing/balance` / `billing/preview` 会回
> `400 code:3001 parameter error`，缺的是 `X-Device-Mid: <UUID>` 这个头（值只校验 UUID 形状）。
> `billing/current` 不需要。详见 [`docs/quota-api.md`](docs/quota-api.md)。

### 与智谱官方 API 的关系

`/api/paas/v4` 是公开文档的 OpenAI 兼容接口，走**账号余额按量计费**，不是套餐额度。
想让 DSH 用上 GLM 而不在乎烧哪份钱，那条路依然是最省事的（DSH 自带 OpenAI 兼容 provider，
不需要本插件）。**想烧套餐额度，用本插件的直连通道。**

完整实测数据见 [`docs/agent-architecture.md`](docs/agent-architecture.md)、
[`docs/quota-api.md`](docs/quota-api.md)。

## 安全须知（装之前必读）

### 直连通道（`transport: plan`，默认）

**不启动任何子进程**，所以 0.6.x 那个「agent 在 DSH 权限边界之外运行」的问题不存在了：
没有 agent，就没有 agent 发起的工具调用需要审批。

- 请求体、system prompt、工具定义全部由 DSH 掌控 —— 模型看到的就是 DSH 给的工具，
  不会以为自己在别的产品里跑。
- `zcodejwttoken` 只在插件进程与上游端点之间传递（HTTPS），不发给任何第三方。
- 凭证落盘在插件自己的文件里（AES-256-GCM）。

### 旧通道（`transport: agent`）仍然有那些风险

这个通道的「模型提供方」真身是一个**以当前用户权限运行、且带全套工具执行能力的 agent**。
它不在 DSH 的工具权限边界内运行：DSH 的权限模式和浏览器审批界面只处理 DSH Host 自己发起的
工具调用，不能确认 ZCode app-server 发起的授权请求。

- 两种策略都会将会话设为 ZCode 的 `build` 权限模式，确保授权请求经过插件处理；模式设置失败时本轮停止。该策略不构成操作系统沙箱，也不阻止无需额外授权的 agent 操作。
- 默认 `authorizationPolicy: deny`：插件对 `interaction/requestPermission` 回复 `deny`，不会弹确认框；需要授权的工具调用会失败。
- 只有显式设置 `authorizationPolicy: allow-all` 才会自动批准已知的 `interaction/requestPermission` 请求。该设置允许 agent 以当前用户权限执行 Bash、文件读写和联网操作，不要在不可信任务中启用。
- 名称包含 `approval` 或 `permission` 的未知 app-server 请求始终拒绝，即使启用了全自动模式；如果 ZCode 将来改变权限协议，相关调用会失败关闭。
- agent 的输入是 DSH 拍平后的整段对话（包括网页抓取、工具结果等外部内容）。提示注入仍可能诱导全自动模式执行恶意操作；默认拒绝减少了授权面，但不能消除未经过授权请求的副作用。
- 子进程环境变量按白名单透传（系统基础变量、`ZCODE_*`、`NODE_EXTRA_CA_CERTS`），不继承
  DSH 宿主的全部 env；确有需要可用配置项 `childEnvAllow` 追加变量名。

### 凭证加密的真实强度（两个通道共用）

AES-256-GCM，密钥 = `SHA-256("zcode-credential-fallback:<platform>:<homedir>:<username>")`
——**纯机器指纹，单轮无 salt**，与 ZCode 客户端完全一致（这样两边能互读同一个文件）。

这意味着：**同一台机器、同一用户下的任何进程都能推出同一把密钥。** 它防的是「文件被单独
拷走」，防不了「同机」。不要把它当成密钥保管方案。这个弱点不是本插件引入的，是 ZCode
客户端自己的设计；要改就得改客户端，否则互读会断。

## 通道原理

### 直连通道（全部实机验证）

1. **端点选择**由 `providerId` 决定（`lib/plan-routes.js` 的 `PLAN_ENDPOINTS`）：
   - `start-plan` → `https://zcode.z.ai/api/v1/zcode-plan/anthropic`
   - `zai` 的 coding-plan → `https://api.z.ai/api/anthropic`
   - `bigmodel` 的 coding-plan → `https://open.bigmodel.cn/api/anthropic`
   - `offpeak-idle-plan` → `https://zcode.z.ai/api/v1/off-peak/anthropic`
   - `highspeed-card` → `https://zcode.z.ai/api/v1/highspeed/anthropic`
2. **鉴权形态按家族区分**（交叉用错一律 401）：
   - `start-plan`：`Authorization: Bearer <zcodejwttoken>`
   - coding-plan：`x-api-key: <account-provider:coding-plan:...:api-key>`
   - offpeak / highspeed：两者都要（highspeed 还要 `X-Highspeed-Card-ID`）
3. **请求体是标准 Anthropic Messages**：`model` / `max_tokens` / `messages` / `system` /
   `tools` / `stream` / `thinking`。头 `content-type: application/json`、
   `anthropic-version: 2023-06-01`。
4. **`200` 也可能是错误**：`zcode-plan` 端点用 `200` 携带 `{code:1005}`。所以适配器
   不只看 `response.ok`，成功后还会再查信封。
5. **开 thinking 时不发 `temperature`**（Anthropic 会 400）。这是硬约束。
6. **工具调用转发 JSON 增量**：DSH 的 `ToolCallBlock.arguments` 本来就是原始 JSON 字符串，
   所以 `input_json_delta` 原样转发，解析失败时原始串让 DSH 如实报参数错。

### 旧通道（全部实机逆向验证）

1. spawn `zcode app-server --surface terminal --no-color` 时**不注入任何 `ZCODE_*`**。
   实测三种环境（零变量 / 只 `ZCODE_SERVICE_AUTHORITY_MODE` / 再加 `ZCODE_BASE_URL`）
   产出的模型清单**完全相同**；而注入 builtin/personal 文件路径会引入启动失败。
2. `session/create` 的返回里 `settings.model.available` 是模型清单，`session.model` 是当前模型。
   条目形状：`{ref:{providerId,modelId}, label, providerLabel, contextWindow, maxOutputTokens,
   reasoning:{levels:[{value}],defaultLevel}, properties:{inputFormat:{supportsImage}}}` ——
   **没有** `inputModalities` 字段，图片能力要看 `properties.inputFormat.supportsImage`。
3. `session/subscribe` 用 `{deliveryKind:'desktop-continuous', afterSeq:0, includeSnapshot:true}`。
4. `session/setModel` 要求对象式 `{providerId, modelId, options:{reasoningLevel}}`；
   `reasoningLevel` 取自条目上报的档位（本机是 low/high/max，默认 max）。
5. agent 发模型请求前回调 `interaction/requestProviderRuntimeHeaders` 要鉴权 —— 回共享凭证里的
   **`zcodejwttoken`**（`oauth:zai:access_token` 已过期，回它上游 401）。
6. `session/event` 的事件类型在 **params.type 顶层**（不是 payload.type），`turn.failed` 也要处理
   （错误码在 `payload.error.attribution.providerErrorCode`），`replayState` 里不能有 `undefined`
   字段（lossless JSON 校验会炸）。
7. 服务端请求必须应答，否则 `session/create` 挂起：`session/requestRuntimePreferences` 回
   `{nativeSearchEnhancementsEnabled:false, memoryEnabled:false,
   askUserQuestionAutoResolutionEnabled:true, modelContextBudgetStrategy:'preflight-v1'}` 就够。

> 0.6.x 在这里写过「HTTP 直连计划端点会被无痕验证拦」。**那条结论已被推翻**：
> 直连通道（上面第一节）实测直接到达业务层，不需要签名。旧的 `lib/client-signing.js`
> 保留但默认不参与模型请求。

## 回合锁与自愈

app-server **一个会话同时只允许一个在途回合**。上一轮被中止 / 超时 / 静默丢弃时它不会自己释放，
下一轮 `session/send` 就被拒成 `A prompt is already running for this session`。通道层做六件事兜底：

1. **补发 `session/stop`**：本轮只要没正常结束（超时 / 被中止 / 发送失败 / `turn.failed`），
   生成器 `finally` 一定补一刀，不把锁留给下一轮；
2. **撞锁自愈**：`send` 被回「already running」→ 补 stop → 等 1.5s → 原会话重试一次；
   被回「session … not found」（会话被回收 / 进程重启）→ 丢弃缓存条目、新建会话，
   `firstTurn` 语义自动重放整段对话，历史不丢；
3. **回合串行化**：同一 DSH 会话的两轮排队跑（最多等 60s，超时放行交给 2 处理）；
4. **进程退出即作废 + 快败**：app-server 子进程退出（含 spawn 失败）时清空会话映射，
   **在途的流会立刻收到一个回合失败收尾**，不用干等回合超时；
5. **会话分叉检测**：每轮 send 都记录当时的消息列表指纹；下一轮续接前先比对前缀，
   DSH 侧编辑 / 回退过历史就重建会话、按首轮语义重放新分支；
6. **模型映射**：DSH 选的模型 id 经 catalogue 解析成 `{providerId, modelId}`；
   同一会话中途换模型时在原会话上重发 `session/setModel`，解析不出来就保留会话默认模型并记 warn。

## 诊断命令

插件带一个不依赖 DSH 宿主的诊断入口（只用 Node 内置模块，**插件因版本不兼容加载失败时也能用**）：

### 直连通道（不启动 agent）

```
node bin/dsh-connect-zcode.js plan-models  # 列出直连路由表与全部模型（离线，免费）
node bin/dsh-connect-zcode.js plan-models --mode both   # merged + explicit 两个视图
node bin/dsh-connect-zcode.js quota        # 读套餐额度（免费，不耗额度）
node bin/dsh-connect-zcode.js login        # 设备码登录，打印授权 URL 后轮询（免费）
node bin/dsh-connect-zcode.js plan-turn "hi"  # 走直连通道发一回合（消耗额度）
node bin/dsh-connect-zcode.js plan-turn "hi" --pinned "account:zai-start-plan#GLM-5.3-Flash"  # 复现 planPinnedRoutes
```

`plan-models` 读客户端磁盘上的 builtin release；读不到就用内置快照，所以**没装客户端也能跑**。
输出里每条路由都标了鉴权形态与端点，可以直接对着排错。默认打 merged 视图（每个模型一行 +
它的路由链），`--mode explicit` 打 22 条路由-模型对，`--mode both` 两个都打 —— 这是看清
「为什么选择器里只有 4 个模型、路由表里却有 22 条」最快的办法。

`quota` 只 `GET billing/current`。**`plans: []` 是有效答案**（账号当前没有套餐），
不是错误 —— 命令会明确这么写，避免把「没额度」误读成「插件坏了」。

`login` 会打印一个 `authorize_url`，在任意浏览器打开并确认即可，插件轮询到 `ready` 后把
凭证写进插件自己的文件。`--family zai|bigmodel` 选家族。

`plan-turn` 默认走该模型的**整条候选链**（自动切换），`--route <providerId>` 则钉死一条。
每次尝试都会打印一行：

```
model    GLM-5.3-Flash
chain    account:bigmodel-start-plan → account:bigmodel-team-coding-plan  (auto-failover)
  deduped 1 route(s) whose request would be identical
  route    account:bigmodel-start-plan unavailable (QUOTA) → next: 计划额度不足（quota 1005）
  route    account:bigmodel-team-coding-plan unavailable (QUOTA): 计划额度不足（quota 1309）
```

`plan-turn` 的关键设计：**上游业务错误被当作成功信号**。本机没有额度时会得到
`1005 exceed quota limit`，命令会打印

```
upstream answered at the business layer (the channel works): QUOTA 计划额度不足（quota 1005）...
```

—— 因为这恰好证明鉴权、路由、端点全都对了，只是没有额度。退出码 0。

### 旧通道（会启动 agent）

```
node bin/dsh-connect-zcode.js doctor       # 本地前置条件体检（离线，不耗额度）
node bin/dsh-connect-zcode.js models       # 打印 CLI 上报的完整模型清单
node bin/dsh-connect-zcode.js protocol     # 起 app-server 走一遍握手，验证协议没变
node bin/dsh-connect-zcode.js turn "hi"    # 真发一个回合（消耗额度）
node bin/dsh-connect-zcode.js image <file> # 发一张图（消耗额度）
```

通用参数：`--cli-path <zcode.cjs>`、`--data-dir <~/.zcode 的上级>`、`--model <id>`、
`--route <providerId>`、`--family <zai|bigmodel>`、`--store <file>`、`--json`、`--allow-tools`。

`--allow-tools` 默认**关闭**，和插件本身的 `authorizationPolicy: deny` 一致。只有 `turn` /
`image` 会真的起 app-server agent，所以不带这个 flag 时，探针会对 agent 的工具权限请求回
`deny`：能验证通道和用量，但 agent 跑不了 Bash、写不了文件、上不了网。**直连通道的
`plan-turn` 不需要这个 flag** —— 它不发请求给 agent，没有工具调用可言。

`doctor` 会检查 node 版本、CLI 定位、builtin release（**只读检查，不喂给 CLI**）、
凭证（只打印长度与是否 JWT，绝不打印 token 本体）、以及 CLI 上报的模型清单。

> 这些子命令取代了上游 `scripts/probe-*.cjs` 那十个一次性脚本。那些脚本各自硬编码了作者
> 本机路径、改一次才能问另一个问题，已删除。

## 选择启用哪些模型

两条通道各有自己的模型开关（互不干扰，因为 id 形式不同）：

```yaml
# 直连通道（默认，planRouteMode: merged）。id 就是裸 modelId
planEnabledModelIds:  [GLM-5.3-Flash]
planDisabledModelIds: [GLM-5.2]   # 优先级更高

# 旧通道。id 是 CLI 上报的裸 modelId
enabledModelIds:  [GLM-5.3]
disabledModelIds: [GLM-5.2]
```

`merged` 模式下还支持**按路由**精细控制 —— 写 `<providerId>#<modelId>`：

```yaml
planEnabledModelIds:
  - account:zai-start-plan#GLM-5.3-Flash   # 优先烧 start-plan，但它不可用时仍会切换
planPinnedRoutes:
  - account:zai-start-plan#GLM-5.3-Flash   # 只烧 start-plan，额度用尽也不切换
planDisabledModelIds:
  - account:bigmodel-team-coding-plan#GLM-5.3-Flash   # 只摘掉这条路由，模型保留
```

| 写法 | 字段 | `merged` 模式下的含义 |
|---|---|---|
| `GLM-5.3-Flash` | enabled | 点名模型：只留它 |
| `GLM-5.3-Flash` | disabled | 整个模型消失 |
| `account:zai-start-plan#GLM-5.3-Flash` | `planEnabledModelIds` | 提到链首，**保留**自动切换（「优先烧」） |
| `account:zai-start-plan#GLM-5.3-Flash` | `planPinnedRoutes` | 链只剩这一条，**不**切换（「只烧」） |
| `account:zai-start-plan#GLM-5.3-Flash` | `planDisabledModelIds` | 只把该路由从链上摘掉，模型还在 |
| `account:zai-start-plan/GLM-5.3-Flash` | 任意 | 同上（斜杠写法等价） |

### 让某个模型只烧特定套餐

「优先烧」和「只烧」是两件不同的事，所以是两个字段：

- `planEnabledModelIds` 里的 `<providerId>#<modelId>` 只调整**顺序** —— 先试它，不行照样
  兜底到别的套餐。适合「尽量用便宜的这份额度」。
- `planPinnedRoutes` 里的同一个写法**截断链** —— 只试它，失败就直接报错。适合「这份额度
  是专用的，绝不能串到另一份去」。

```yaml
# 只让 GLM-5.3-Flash 烧 start-plan；额度用尽就报 1005，不会自动改烧 coding-plan
planPinnedRoutes:
  - account:zai-start-plan#GLM-5.3-Flash

# 同一个模型也可以钉多条（按套餐优先级排队，而非书写顺序）
planPinnedRoutes:
  - account:zai-start-plan#GLM-5.3-Flash
  - account:bigmodel-team-coding-plan#GLM-5.3-Flash
```

模型选择器里会标出来，因为它改变的是**失败语义**而不只是候选范围：

```
GLM-5.3-Flash   start · pinned, no failover
GLM-5.3         coding → idle → fast (8 routes)
```

写错了不会被静默忽略，而是分三类告警并**保持原链不变**（绝不因为一个笔误让模型不可用）：

| 问题 | 日志 |
|---|---|
| 写成裸 modelId | `planPinnedRoutes needs "<providerId>#<modelId>"; these were ignored: …` |
| 模型名打错 | `planPinnedRoutes names models not in the plan catalogue: …` |
| providerId 打错 / 该路由不服务这个模型 | `planPinnedRoutes names routes that do not serve those models: …` |

想先在真实端点上试一下再写进配置，用 `plan-turn --pinned`：

```powershell
node bin/dsh-connect-zcode.js plan-turn "hi" --model GLM-5.3-Flash --pinned "account:zai-start-plan#GLM-5.3-Flash"
# chain    account:bigmodel-start-plan  (pinned, no failover)
#   route    account:bigmodel-start-plan unavailable (QUOTA): …（没有 “→ next”）
```

> 若同一条路由既被钉死又被停用，得到一个空链 → 模型直接隐藏。两个要求互相矛盾时，
> 宁可少一个模型，也不悄悄退回用户明确说过不要用的套餐。

> **不要把旧字段也传给直连通道**：旧字段填裸 `modelId`，直连 `explicit` 模式填 `#` 形式，
> 混用会互相误伤。适配器在 `plan*` 字段存在时**不回退**旧字段（空 = 全开）；只有整个配置
> 对象没有 `plan*` 字段（旧版 `index.js`）时才退回旧字段。

在 **插件 → dsh-connect-zcode** 页面里，型号卡片**按通道分区**：直连额度（`zcode-plan`）
与托管 agent（`zcode-cli`）各一段，每段列出该通道的候选模型、各带一个开关，段首显示
`已启用 N/M` 和「全部启用」。顶部显示总计数与「重新读取」。

每段还带一行诊断：**供应商 id / 目录模型数 / 已启用数**。供应商 id 是卡片看起来不对劲时
最有用的一条信息 —— 例如 `transport: plan` 下 `zcode-cli` 不会注册，那一段会直接写明
「该通道当前未注册」，而不是留一段看不懂的空列表。

> **为什么分区而不是一张总表**：两个通道的模型 id 形态根本不同 —— 直连通道 merged 模式是
> 裸 `modelId`（`GLM-5.3-Flash`），explicit 模式是 `<providerId>#<modelId>`，旧通道是 CLI
> 上报的 id —— 而且写的是不同的配置字段。合成一张表时，卡片只能猜，猜错的后果就是显示
> 另一条通道的模型清单。（0.9.0 及更早正是如此：`transport: plan` 下卡片列的是 15 个
> agent 时代的旧 id，直连通道真正在服务的模型一个开关都没有。）

直连额度那段还会显示当前的**路由模式**（`merged` / `explicit`）和**已钉死的模型数**。
两者都是只读展示：它们决定模型 id 的形态和额度用尽时会不会切换，属于配置文件层面的决定，
不该由这张卡片翻。

改动**先留在本地**：勾选只改草稿，底部出现「有未保存的修改」，点「保存」才写入一次
（不想留就点「放弃修改」）。保存后 DSH 的模型选择器随即按勾选结果增减。

> 为什么不是即时写入：每次切换都写配置的话，宿主会跟着重读一次模型目录，而该目录是按
> 当前配置过滤的——那次「写前发起、写后返回」的读取会短暂拿到上一版结果，整个列表在
> 勾选瞬间灰一下。草稿 + 保存把写入压到一次，这个闪烁就没有了。

**怎么知道该填哪些 id？** 跑对应的诊断命令，它会列出全部 id，并按当前配置标注 `[disabled]`：

```powershell
node bin/dsh-connect-zcode.js plan-models                    # merged 视图：4 个模型 + 各自的路由链
node bin/dsh-connect-zcode.js plan-models --mode explicit    # 22 条路由-模型对
node bin/dsh-connect-zcode.js plan-models --mode both        # 两个视图都打
node bin/dsh-connect-zcode.js models                         # 旧通道的 id
```

填错的 id 不会被静默忽略：命令会打印 `not found in the catalogue: ...`，
插件运行时也会在日志里 warn 一次，方便发现拼写错误。

> 说明：这是**显示层**的筛选 —— 上游那边仍然能服务全部模型，路由表不受影响。
> 因此已停用的模型不会出现在选择器里，但不会因为“停用”而导致历史会话报错。

> **为什么默认是 `merged`**：模型选择器是给人挑模型的，不是给人挑额度池的。
> `explicit` 模式下列 22 条、`GLM-5.3-Flash` 出现四次，用户根本无从判断该选哪个；
> 而「先烧哪份额度」是可以由插件按确定性优先级决定的事。需要绝对控制时再切 `explicit`。

## 配置（设置 → 插件）

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 总开关 |
| `transport` | `plan` | `plan` = 直连额度（不启动 agent，推荐）；`agent` = 托管 agent（旧通道）；`both` = 两条都注册 |
| `planRouteMode` | `merged` | 直连通道模型清单投影：`merged` = 一个模型一条 + 套餐间自动切换（**4 个模型**）；`explicit` = 一条路由一条 + 手动选（**22 个**） |
| `planEnabledModelIds` | `[]` | 直连通道只启用这些。`merged` 写裸 id（`GLM-5.3-Flash`），也可写 `#` 形式表达「优先这条路由」；`explicit` 写 `<providerId>#<modelId>`。留空 = 全部 |
| `planDisabledModelIds` | `[]` | 直连通道额外停用（优先级更高）。`merged` 下裸 id 隐藏整个模型，`#` 形式只摘掉该路由 |
| `planPinnedRoutes` | `[]` | 把模型**严格**钉死到指定套餐路由（写 `<providerId>#<modelId>`）：只烧这一条，额度用尽也不切换。留空 = 允许自动切换。想让路由「优先但保留兜底」请改用 `planEnabledModelIds` |
| `planCredentialStore` | 空 | 插件自有凭证文件；空 = `<dataBaseDir>/.zcode/dsh-plan-credentials.json`。**绝不写回客户端 credentials.json** |
| `zcodeCliPath` | 自动探测 | `zcode.cjs` 路径；空 = 从 `ZCODE_CLI_PATH`、**桌面客户端（注册表发现的安装根）**、常见安装位置、`zcode-app-cli` 全局包依次探测 |
| `zcodeClientRoot` | 空 | ZCode 桌面客户端安装根（如 `E:\zcode`）；空 = 自动探测（注册表 → 标准安装目录） |
| `zcodeLaunchMode` | `auto` | `auto` = 找到桌面客户端就用它的启动形态，否则用 node；`desktop` / `node` 强制二选一 |
| `accountSync` | `true` | 是否把套餐账号 provider（`account:*`）推给桌面版 CLI 并刷新 registry；关掉只剩个人 provider |
| `zcodeCliNode` | `node` | 运行 zcode.cjs 的 node 可执行文件（仅 node 模式使用；桌面模式用客户端自带的 `ZCode.exe`） |
| `cliModels` | `[]` | **留空 = 跟随 CLI 上报的清单**（推荐）。填了就等于把清单钉死成这份，只用 `cliModelId` 决定 CLI 侧路由 |
| `enabledModelIds` | `[]` | **只启用这些模型**（写 CLI 上报的 modelId，如 `GLM-5.3`）。留空 = 全部启用 |
| `disabledModelIds` | `[]` | 额外停用某些 modelId；优先级高于 `enabledModelIds`，适合“全部启用但关掉个别” |
| `authorizationPolicy` | `deny` | `deny` 会拒绝 ZCode 的权限请求且不提供交互确认；只有你明确接受无人值守工具执行时才设为 `allow-all`。未知 permission/approval 方法始终拒绝 |
| `cliCwd` | 空 | app-server 会话的工作目录；空 = 用户主目录 |
| `zcodeDataBaseDir` | 空 | ZCode 数据根目录；空 = 读 `~/.zcode/v2/setting.json` 的 `dataBaseDir`，再兜底用户主目录 |
| `childEnvAllow` | `[]` | 额外透传给子进程的环境变量名 |
| `appServerTimeoutMs` | `120000` | 单次 JSON-RPC 请求超时（毫秒） |
| `zcodeCliTimeoutMs` | `900000` | 单回合超时（毫秒） |
| `maxTokens` | `128000` | 仅作兜底：CLI 未上报 `maxOutputTokens` 时使用 |
| `defaultContextWindow` | `1000000` | 仅作兜底：CLI 未上报 `contextWindow` 时使用 |

## 开发

```bash
npm test           # 纯函数单测（不 spawn CLI、不耗额度）
npm run typecheck  # tsc --checkJs 全量类型校验（零构建，装进 profile 免编译）
npm run diagnose   # 诊断命令入口
```

**改了代码怎么生效**：DSH 的 loader 只在**行 name 变化**时重新 import 插件模块，
而 Node ESM 以完整 URL（含查询串）为缓存键。仓库里的 `cordis.patch.yml` 写的是包名
（npm / link: 装配的正确形态）；本地目录式开发装配时把它换成 file:// URL 加 `?v=N`：

```yaml
- insert:
    - id: dsh-connect-zcode
      name: 'file:///D:/path/to/dsh-connect-zcode/lib/index.js?v=N'
```

改完 `lib/*.js` 后把 `?v=N` 递增，然后在插件管理里对 bundle **禁用 → 启用**（或重启 DSH）。

## 目录结构

```
# ── 直连额度通道（0.7.0 新增，默认） ──────────────────────────────────────────
lib/plan-client.js   直连 HTTP 客户端：路由解析 → 请求构造 → SSE 解析 → 错误分类；
                     外加 streamMessagesAcrossRoutes()（按候选链自动切换）与
                     dedupeRoutes()（去掉请求逐字节相同的路由）
                     （零依赖，只用全局 fetch；不启动任何子进程）
lib/plan-preamble.js 客户端指纹层：官方 system preamble（逐字节固化）+ 三项指纹头
                     （authorization / x-api-key / user-agent）。zcode.z.ai 端点必需，
                     缺了就是 405 3012；api.z.ai / open.bigmodel.cn 不需要
lib/plan-auth.js     设备码 OAuth 登录 + AES-256-GCM 凭证加解密 + 插件自有凭证存储
lib/plan-routes.js   路由表：读客户端 builtin release → providerId/baseUrl/模型清单；
                     读不到降级到内置快照（10 条路由），所以没装客户端也能用。
                     另有 mergePlanModels()（模型→路由链）与 routesForModel()
lib/plan-quota.js    额度查询（billing/current | balance | preview）+ 归一化 + TTL 缓存
lib/plan-quota-snapshot.js
                     额度运行时快照：挂在 listModels() 里给模型描述挂额度；
                     TTL 缓存 + 失败退避 + 并发合并，**永不抛出**（查不到只是 unknown）
lib/plan-adapter.js  ZcodePlanAdapter extends LlmAdapter：把上面几块接成 provider zcode-plan；
                     planRouteMode=merged|explicit 两种模型清单投影共用一条代码路径

# ── 旧通道（托管 agent，transport: agent） ─────────────────────────────────────
lib/app-server.js    app-server 通道：JSON-RPC 客户端 + LlmAdapter（事件流/回合锁/鉴权）
                     + resolveSpawnPlan()：桌面 / node 两种启动形态的唯一决策点
lib/client-signing.js 客户端请求签名链路（保留；模型请求主链路不需要它）
lib/zcode-runtime.js 桌面客户端发现、数据根解析、内置 release 选择、CLI 启动环境
                     （只用 Node 内置模块，doctor 在插件加载失败时仍可用）
lib/account-sync.js  套餐账号 provider 注册（updateAccountConfig + refreshRegistry）
                     与按路由选择签名凭证（account api-key / zcodejwt）
lib/authorization.js app-server 权限请求策略（默认 deny）
lib/messages.js      消息工具：图片物化、对话拍平、泄漏工具调用清洗
lib/credentials.js   解密客户端 credentials.json（数据根优先、~/.zcode/v2 兜底）

# ── 共用 ──────────────────────────────────────────────────────────────────────
lib/index.js         插件装配：Config schema（模型列表字段标记 volatile）、
                     transport 决策、provider 注册、模型清单来源
lib/client.js        浏览器半边：插件页的「zcode 模型」卡片（草稿 + 保存）
lib/diagnostics.js   九个诊断子命令（plan-models/quota/login/plan-turn + doctor/models/
                     protocol/turn/image），共用一套启动计划
bin/                 可执行入口
test/                单测（node --test，323 个用例）：路由归一、凭证加解密、OAuth 状态机、
                     SSE 分块、错误分类、事件映射、模型筛选、volatile 门、客户端绑定
docs/                设计契约、安装/回滚、参考插件研究、额度接口文档、发布清单
CHANGELOG.md         版本变更记录
verify/              E2E 验证脚本与证据（verify/desktop-e2e.mjs）
```

## 许可

AGPL-3.0。本仓库是 [kyle123740/dsh-zcode-cli-proxy](https://github.com/kyle123740/dsh-zcode-cli-proxy)
的衍生版：app-server 通道的逆向结论（回合锁、事件流、鉴权回调）源自上游，
v0.4.x 依实机重新验证并改写了账号/模型层。历史来源致谢
[liu5269/zcode2api](https://github.com/liu5269/zcode2api)，其代码已不再随本仓库分发。


