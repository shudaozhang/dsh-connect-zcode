# Changelog

本项目的所有重要变更记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.8.0] - 2026-10-27

**一个模型只出现一次，套餐之间自动切换。**

0.7.0 的直连通道能烧额度了，但模型清单是「一条路由 × 一个模型」展开的 22 条 ——
`GLM-5.3-Flash` 在 start-plan / coding-plan / offpeak / highspeed 上各出现一次。这样做的
理由是「同一模型走不同套餐烧的是不同额度池」，用户必须自己选。但实际用起来这是错的体验：
用户想要的是**一个模型**，至于烧哪份套餐，那是插件该操心的事。

0.8.0 把这件事交回给插件。

### 新增

- **`planRouteMode` 配置项**（`merged` | `explicit`，默认 `merged`）。
  - `merged`：一个模型一条，DSH 模型 id 就是 `GLM-5.3-Flash`。模型背后是一条**候选路由链**
    （按套餐优先级：start-plan → coding-plan → offpeak → highspeed），请求时依次尝试，
    前一条额度用尽 / 凭证缺失 / 上游 5xx 就自动换下一条。**22 → 4 个模型。**
  - `explicit`：0.7.0 的行为，22 条 `account:zai-start-plan#GLM-5.3-Flash`，绝不自动切换。
- **`streamMessagesAcrossRoutes()`**（`lib/plan-client.js`）—— 按候选链依次尝试的生成器。
  关键设计是**先缓冲再放行**：内容一旦发给 DSH 就不能换路由了（否则用户会看到两段互相
  矛盾的回复），所以每条路由先缓冲事件，确认真的产出了内容才转直通。
- **`dedupeRoutes()`** —— 去掉「拼出来的请求逐字节相同」的路由。实测 `account:zai-start-plan`
  与 `account:bigmodel-start-plan` 指向**同一个 baseUrl** 且共用同一个 `zcodejwttoken`，
  换过去只会白跑一趟。本机实测把 `GLM-5.3-Flash` 的链从 10 条压到 2 条。
- **路由级精细控制**（仅 `merged` 模式）：
  - `planEnabledModelIds` 里写 `account:zai-start-plan#GLM-5.3-Flash` → 该路由提到链首
    （「优先烧这份套餐」），但**仍然**保留自动切换；
  - `planDisabledModelIds` 里写同一个 → 只把那条路由从链上摘掉，模型还在。
    写裸 `GLM-5.3-Flash` 才是整个模型消失。
- **`parsePlanModelRef()`** —— 区分「用户显式钉了路由」与「用户只要这个模型」。这是
  merged 模式能做对的前提：前者是单条路由，后者是一整条候选链。
- `plan-models` 命令新增 `--mode merged|explicit|both`，一次看清 4 个模型与 22 条路由的对应关系。
  `plan-turn` 现在会打印每次尝试的路由与结果。

### 变更

- 模型清单的 `description` 从 200 多字符的 providerId 串改成套餐种类摘要
  （`start → coding → idle → fast (10 routes)`），否则在模型选择器里根本读不完。
- 模型清单条目内部统一成 `{ id, modelId, routes: PlanProvider[] }`，两种模式共用一条
  代码路径：`explicit` 的链长恒为 1，等价于不做切换。

### 实测（本机，2026-10-27）

```
planRouteMode=merged   -> 4 个模型
planRouteMode=explicit -> 22 个模型

plan-turn "say OK" --model GLM-5.3-Flash
  chain    account:bigmodel-start-plan → account:bigmodel-team-coding-plan  (auto-failover)
  deduped 1 route(s) whose request would be identical
  route    account:bigmodel-start-plan unavailable (QUOTA) → next: 1005 exceed quota limit
  route    account:bigmodel-team-coding-plan unavailable (QUOTA): 1309 套餐已到期
```

自动切换在真实端点上跑通了：第一条回 `1005`，自动换到第二条，拿到 `1309`。
本机账号没有任何可用套餐，所以「切换后成功拿到内容」这一步仍然无法验证 —— 与 0.7.0
的验证边界相同，切换逻辑本身由 27 个离线单测覆盖（含「已提交后不得重试」「全部失败时
带出完整尝试链」）。

### 验证边界（如实说明）

本机账号没有可用套餐额度，所以「切到某条路由后真的拿到正常回复」这一步**没有**被验证。
已验证的是：路由链构造、去重、逐条尝试、失败分类与切换判定、链耗尽后的错误聚合、
真实端点上的两次业务层响应（1005 → 1309）。

## [0.7.0] - 2026-10-27

**直连计划额度：不再托管 ZCode 的 agent 进程。**

用户的目标一直是「让 DSH 直接烧 ZCode 账号的套餐额度」，而不是「让 DSH 通过 ZCode 的 agent
间接用模型」。0.6.x 走的是后者：spawn `ZCode.exe zcode.cjs app-server --stdio`，用 stdio
JSON-RPC 驱动一个常驻 agent，再由 agent 替我们发模型请求。这条路能跑，但代价是把每次请求都
交给一个 15MB 的二进制中转，还要维护会话生命周期、回合锁、自愈、事件反解。

0.7.0 把中间层删掉了：计划端点本身就是 **Anthropic Messages 兼容接口**，凭证就在本机磁盘上，
请求体我们自己就有。

### 新增

- **`lib/plan-client.js`** — 直连 HTTP 客户端（零依赖，只用全局 `fetch`）。
  `resolvePlanRoute()` 按 providerId 选端点与鉴权形态；`streamMessages()` 把上游 SSE 翻译成
  统一事件；`classifyPlanError()` 把上游业务码映射成可分类的错误。
- **`lib/plan-auth.js`** — **设备码 OAuth 登录**，完全脱离 ZCode 客户端。三步：
  `POST /api/v1/oauth/cli/init` → 用户在浏览器确认 → `GET /api/v1/oauth/cli/poll/{flow_id}`。
  `ready` 响应**直接给出 `zcodejwttoken`**（不是换来的）。另有与客户端同构的 AES-256-GCM
  凭证加解密，以及插件自有的凭证存储（**绝不写回客户端的 `credentials.json`**）。
- **`lib/plan-routes.js`** — 路由表。读客户端磁盘上的 builtin release 得到
  `providerId → baseUrl → 模型清单`；读不到时降级到内置快照（10 条路由），
  所以**没装客户端的机器也能起服务**。
- **`lib/plan-quota.js`** — 额度查询（`billing/current` / `balance` / `preview`），
  归一化 + TTL 缓存 + 失败不污染缓存。
- **`lib/plan-adapter.js`** — `ZcodePlanAdapter extends LlmAdapter`，把上面几块接成 DSH 的
  provider `zcode-plan`。模型 id 形如 `account:zai-start-plan#GLM-5.3-Flash`
  （路由是额度池，必须能显式选）。
- **配置 `transport`**：`plan`（默认，直连）/ `agent`（旧通道）/ `both`。
  旧通道完整保留，两条互不干扰。
- **诊断命令**：`plan-models`（列出直连路由表，离线）、`quota`（读额度，免费）、
  `login`（设备码登录）、`plan-turn`（走直连通道发一回合，耗额度）。

### 修复 / 推翻的旧结论

- **「HTTP 直连计划端点会被无痕验证拦」是错的**（0.6.x README 与
  `docs/official-api-access.md` 都这么写过）。实测：`POST .../zcode-plan/anthropic/v1/messages`
  带 `Authorization: Bearer <zcodejwttoken>` 直接到达业务层（`200 {"code":1005}` /
  `429 {"code":3009}`），**不需要任何 `X-Client-*` 签名**。签名链路
  （`lib/client-signing.js`）对模型请求主链路是不必要的 —— 它服务于另一条 project api-key
  走 AI 网关的路径。该模块保留但默认不参与直连通道。
- **`billing/balance` 的 `400 code:3001 parameter error` 之谜**：不是限流（原
  `creds-report` 的「退避重试后 200」归因有误）。真正变量是 **`X-Device-Mid: <UUID>`** 这个
  请求头 —— 累计 27 次对照零例外：带它 16/16 → 200，不带 11/11 → 400。取值只校验 UUID 形状，
  客户端真值在 `<dataBaseDir>/.zcode/v2/telemetry-state.json` 的 `deviceMid`。
  `billing/current` 不需要它。详见 `docs/quota-api.md`。

### 实测记录（2026-10-27，本机客户端 3.16.3）

| 检查 | 结果 |
|---|---|
| 直连 start-plan 路由（Bearer JWT） | `200 {"code":1005,"exceed quota limit"}` → **鉴权与路由均通过**，本机无额度 |
| 直连 bigmodel coding-plan（`x-api-key`） | `429 {"code":"1309","套餐已到期"}` → **鉴权通过** |
| 交叉用错鉴权头 | `401` → 证明两条路由的鉴权形态确实不同 |
| `billing/current` | `200 {"code":0,"data":{"plans":[]}}` → 无套餐是有效答案 |
| 设备码 OAuth init | `200`，两种家族都返回合法 `authorize_url` |
| 路由表 | 10 条 `account:*` 路由 / 22 个 DSH 模型 id |
| 全仓测试 | 323 pass / 0 fail |
| `tsc -p tsconfig.json` | 0 错误 |

> **验证范围说明**：本机账号当前没有可用套餐额度，所以「真实出字」这一步无法验证。
> 本次交付把**能验证的都验证了**：鉴权、路由选择、错误分类、SSE 解析、凭证解密与登录流程
> 都是对着真实端点跑通的；唯一未覆盖的是「套餐有效时上游返回 200 + 正常 SSE」这一分支，
> 代码按 Anthropic Messages 标准形态实现，并已用真实错误响应验证了非 200 路径。

### 安全说明（比 0.6.x 更强，因为不再跑 agent）

- 直连通道**不启动任何子进程**，因此不再有「以当前用户权限运行、带全套工具执行能力的
  agent 不在 DSH 权限边界内」这个问题。`authorizationPolicy` 只对旧通道有意义。
- 凭证仍是 AES-256-GCM + **纯机器指纹**密钥（`SHA256("zcode-credential-fallback:...")`）。
  这与 ZCode 客户端完全一致（为了互读），但**同机同用户的任何进程都能推出同一把密钥** ——
  它防的是「文件被单独拷走」，防不了「同机」。不要把它当密钥保管方案。

## [0.6.1] - 2026-10-24

修复插件页「zcode 模型」卡片在真实宿主上不可用的问题，并把型号开关改成草稿 + 保存。

### 修复

- **配置卡片永久报「插件配置当前不可用」、开关全部失效、每次写入都被回滚**。根因在 DSH
  设置的收录门：`SettingsForms.describe()` 只收录**至少有一个 volatile 字段**的插件条目
  （`volatileForm(schema)` 无 volatile 字段时返回 `undefined`，条目被整个跳过），写路径的
  `isVolatilePath()` 同样拒绝非 volatile 路径。`enabledModelIds` / `disabledModelIds` 原本
  是普通数组字段，因此 `include:dsh-connect-zcode` 从未出现在 describe 镜像里，客户端无论
  怎样尝试命名空间都绑不上。
  - 新增 `asVolatile()`：schemastery ≥3.18.3 上标记 `volatile()`，旧版本降级为恒等 no-op
    （手写 `meta.volatile` 会绕过 `validateVolatileSchema`）。
  - 两个模型列表字段标记为 volatile；`resolveOptions()` 解包——volatile 字段解析后是
    live `{ get(): T }` 引用，`Array.isArray` 在它上面为 false。
  - `options()` 缓存新增 `volatileEpoch`：volatile 编辑是**就地**提交（`updateVolatile`），
    config 对象身份不变，只按身份缓存会永久返回旧值；`loader/volatile-update` 负责递增。
  - `inject` 增加 `settings`，并按 `dsh-connect-workbuddy` 的做法注册页面策略。
- **卡片命名空间绑定**：改为读取 `configForms.describe()` 的 served 集合来挑选命名空间，而不是
  逐个 `forms.get()` 试探。后者对**任意** id 都会懒构造一个表单并返回非空，因此第一个候选
  （裸包名）永远"成功"，随后因严格相等匹配失败而终生 `unavailable`；同时补上绑定自愈。
- **开关状态改由配置推导**：宿主上报的目录已按配置过滤，靠"在不在目录里"判断会让刚关掉的
  模型刷新后弹回。现在按 `disabledModelIds` → 非空 `enabledModelIds` → 全开 的规则推导，
  与宿主 `selectEnabledModels` 一致。

### 变更

- 型号开关改为**草稿 + 保存**：勾选只改本地草稿（底部显示「有未保存的修改」），点「保存」才
  写入一次，「放弃修改」丢弃。此前每次切换都写配置并重读目录，而目录按配置过滤，导致
  「写前发起、写后返回」的读取短暂返回上一版结果——列表在勾选瞬间变灰一下。
- 输入控件的可用性改为跟随「是否已绑定表单」，不再看作用域 `writable` 标志（该标志在镜像
  落地前恒为 false，会让所有开关变灰）。
- 「配置不可用」横幅现在会打印宿主实际服务的配置命名空间列表；写入失败横幅会带上宿主的
  具体报错，便于定位。

### 测试

- 新增 `test/config-volatile.test.mjs`（8 个用例）：复刻宿主 `volatileForm()` 投影，断言
  volatile 标记、投影结果、live reference 读取路径与就地更新。去掉标记后其中 4 项失败。
- 新增 `test/client-binding.test.mjs`（8 个用例）：用假 `configForms` 复刻宿主的惰性 `get()`
  与严格相等匹配陷阱，驱动真实 bundle 校验绑定；并锁定「三次点击零写入零刷新、一次保存
  各一次」「放弃修改不碰宿主」。
- 套件 100/100 通过，typecheck 0 错误。

## [0.6.0] - 2026-10-23

首个以 `dsh-connect-zcode` 名字发布的版本（前身 `dsh-zcode-plan-bridge` 0.5.0）。

### 新增

- **按需启用模型**：新增配置项 `enabledModelIds`（留空 = 全部启用）与
  `disabledModelIds`（额外停用，优先级更高）。筛选只作用于**上报给 DSH 的列表**，
  不影响 CLI 侧路由，已停用的模型不会让历史会话报错。
- 诊断命令 `models` 会按当前配置给每个模型标注 `[disabled]`，并统计
  `Enabled for DSH: N/M`；新增 `--enable-model` / `--disable-model` 预览参数，
  填错的 id 会明确报 `enabledModelIds not found in the catalogue: ...`。
- `test/model-selection.test.mjs`（9 个用例，纯函数）。
- `docs/PUBLISHING.md`：发布到 GitHub / 插件市场的待办清单。
- `docs/desktop-integration-contract.md` §11：模型筛选的设计与实测数据。

### 变更

- **插件更名为 `dsh-connect-zcode`**（包名、`bin` 命令、cordis 行 id、README、
  诊断输出全部同步）；仓库目录同步改名为 `dsh-connect-zcode`。
- 版本号 0.5.0 → 0.6.0；描述改为「把本机 ZCode 桌面客户端的模型接入 DSH」。
- `verify/desktop-e2e.mjs` 的用例数断言从「恰好 53」改为「≥ 53 且 0 失败」，
  以便测试套件随功能增长。

### 修复

- 无（0.5.0 的桌面接入能力见下）。

## [0.5.0] - 2026-10-23

直接接入本机 ZCode **桌面客户端**（此前只支持 npm 版 `zcode-app-cli` 和标准安装位）。

### 新增

- **自动发现客户端**：读注册表 `Uninstall` 项的 `DisplayName ^ZCode`，从
  `InstallLocation` / `UninstallString` / `DisplayIcon` 解析安装根（本机 `E:\zcode`，
  版本 3.16.3），并兜底 `%LOCALAPPDATA%\Programs\ZCode`、`%ProgramFiles%\ZCode`。
- **解析真实数据根**：读 `~/.zcode/v2/setting.json` 的 `dataBaseDir`（本机
  `D:\AI\zcode`），凭证 / 个人 provider / 内置 release 都从 `<dataBaseDir>\.zcode\v2` 取。
- **按客户端自己的方式启动 CLI**：
  `ZCode.exe <cli> app-server --stdio --surface desktop`，并注入
  `ELECTRON_RUN_AS_NODE=1`、`ZCODE_DATA_BASE_DIR`、`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`、
  `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`（缺任一项 CLI 会直接退出）。
- **注册编码套餐账号路由**：`provider/updateAccountConfig` + `provider/refreshRegistry`，
  模型清单 13 → 15（新增 `account:bigmodel-team-coding-plan` 的 GLM-5.3 / GLM-5.3-Flash）。
- **按路由选择签名凭证**：`account:*` 用凭证里的 account-provider api-key，
  z.ai Start Plan 才用 `zcodejwttoken`（用错会卡在 `Client signing requires an API Key`）。
- 新配置：`zcodeClientRoot`、`zcodeLaunchMode`、`accountSync`。
- `lib/account-sync.js`、`test/desktop-runtime.test.mjs`（26 用例）、
  `verify/`（独立 E2E，6/6 断言通过）、`docs/`（设计契约、安装/回滚、参考插件研究）。

### 修复

- 桌面版 CLI 启动失败（`无法定位 CLI ZCode Built-in Provider Config`）。
- 账号快照被静默忽略（`basedOnZCodeBuiltinRevision` 必须指向实际喂给 CLI 的那份 release）。

## [0.4.2] - 上游基线

见 git 历史（`Release 0.4.2`）。
