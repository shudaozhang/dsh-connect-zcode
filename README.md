# dsh-connect-zcode

把本机 **ZCode 桌面客户端**的模型接入 **DeepSeek​ Harness（DSH）** 的本地插件。

provider `zcode-cli` 背后是一个常驻的 `zcode app-server` 会话（stdio JSON-RPC，真流式）。
插件自动发现客户端的安装位置与数据目录，按客户端自己的方式拉起它自带的 agent，
再把该账号能服务的模型清单转述给 DSH —— **烧的是 ZCode 账号的额度，不需要 API Key，也不需要自建网关。**
模型可以按需勾选启用哪些（见「选择启用哪些模型」）。

当前版本 **0.6.1**。

本仓库：<https://github.com/shudaozhang/dsh-connect-zcode> ·
上游原版：<https://github.com/kyle123740/dsh-zcode-cli-proxy>（AGPL-3.0）

> **v0.6.1 修复**：插件页的「zcode 模型」卡片此前在真实宿主上不可用——显示
> 「插件配置当前不可用」，开关全灰，每次写入都被回滚。根因是 DSH 设置只收录
> **至少有一个 volatile 字段**的插件条目（`volatileForm()` 无 volatile 字段时整个条目被跳过），
> 而模型列表字段原本是普通数组，所以该命名空间从未出现在 `settings.describe()` 里。
> 0.6.1 把两个字段标记为 volatile 并做了解包。同一版本里开关改为**草稿 + 保存**，
> 避免每次勾选都触发一次目录重读而让列表闪灰。详见 [CHANGELOG](CHANGELOG.md)。

## 它能做什么

- **自动接入桌面客户端**：读注册表 `Uninstall` 项发现安装根，读 `~/.zcode/v2/setting.json`
  的 `dataBaseDir` 解析数据根，然后按客户端自己的形态启动内置 agent
  （`ZCode.exe resources/glm/zcode.cjs app-server --stdio --surface desktop`，并注入它需要的
  `ELECTRON_RUN_AS_NODE` / `ZCODE_*` 环境变量）。**无需任何环境变量配置。**
- **注册套餐账号 provider**：桌面版 CLI 接受 `provider/updateAccountConfig`，插件把内置 release
  里声明的 `account:*` 套餐 provider 连同 `{availability, current, entitled}` 状态推给它并刷新
  registry，套餐模型才进入清单。
- **按路由选对签名凭证**：`account:*` 用凭证里的
  `account-provider:coding-plan:<providerId>:account:<id>:api-key`，z.ai Start Plan 才用
  `zcodejwttoken`（用错会卡在 `Client signing requires an API Key`）。
- **真流式**（text/reasoning delta 直接转发）、工具调用、图片输入、多轮会话按 DSH sessionId 复用。
- **逐模型启用/停用**：插件页卡片里勾选，保存后 DSH 的模型选择器随即增减。

> 换机器 / 换账号后如果套餐不可用，上游业务错误（例如
> `1309 您的GLM Coding Plan套餐已到期`）会被 `doctor` / `turn` 原样报出来，不会伪装成协议故障。



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

## 安全须知（装之前必读）

这个「模型提供方」的真身是一个**以你当前用户权限运行、且带全套工具执行能力的 agent**。它不在 DSH 的工具权限边界内运行：DSH 的权限模式和浏览器审批界面只处理 DSH Host 自己发起的工具调用，不能确认 ZCode app-server 发起的授权请求；本插件也没有自己的交互式确认窗口。

- 两种策略都会将会话设为 ZCode 的 `build` 权限模式，确保授权请求经过插件处理；模式设置失败时本轮停止。该策略不构成操作系统沙箱，也不阻止无需额外授权的 agent 操作。
- 默认 `authorizationPolicy: deny`：插件对 `interaction/requestPermission` 回复 `deny`，不会弹确认框；需要授权的工具调用会失败。
- 只有显式设置 `authorizationPolicy: allow-all` 才会自动批准已知的 `interaction/requestPermission` 请求。该设置允许 agent 以当前用户权限执行 Bash、文件读写和联网操作，不要在不可信任务中启用。
- 名称包含 `approval` 或 `permission` 的未知 app-server 请求始终拒绝，即使启用了全自动模式；如果 ZCode 将来改变权限协议，相关调用会失败关闭。
- agent 的输入是 DSH 拍平后的整段对话（包括网页抓取、工具结果等外部内容）。提示注入仍可能诱导全自动模式执行恶意操作；默认拒绝减少了授权面，但不能消除未经过授权请求的副作用。
- 子进程环境变量按白名单透传（系统基础变量、`ZCODE_*`、`NODE_EXTRA_CA_CERTS`），不继承
  DSH 宿主的全部 env；确有需要可用配置项 `childEnvAllow` 追加变量名。
- 鉴权 token（`zcodejwttoken`）只经本机 stdio JSON-RPC 交给 agent 进程，不发往任何第三方。

## 通道原理（全部实机逆向验证）

1. spawn `zcode app-server --surface terminal --no-color` 时**不注入任何 `ZCODE_*`**。
   实测三种环境（零变量 / 只 `ZCODE_SERVICE_AUTHORITY_MODE` / 再加 `ZCODE_BASE_URL`）
   产出的模型清单**完全相同**；而注入 builtin/personal 文件路径会引入上面说的启动失败。
2. `session/create` 的返回里 `settings.model.available` 是模型清单，`session.model` 是当前模型。
   条目形状：`{ref:{providerId,modelId}, label, providerLabel, contextWindow, maxOutputTokens,
   reasoning:{levels:[{value}],defaultLevel}, properties:{inputFormat:{supportsImage}}}` ——
   **没有** `inputModalities` 字段，图片能力要看 `properties.inputFormat.supportsImage`。
3. `session/subscribe` 用 `{deliveryKind:'desktop-continuous', afterSeq:0, includeSnapshot:true}`。
4. `session/setModel` 要求对象式 `{providerId, modelId, options:{reasoningLevel}}`；
   `reasoningLevel` 取自条目上报的档位（本机是 low/high/max，默认 max）。
5. agent 发模型请求前回调 `interaction/requestProviderRuntimeHeaders` 要鉴权 —— 回共享凭证里的
   **`zcodejwttoken`**（`oauth:zai:access_token` 已过期，回它上游 401）。agent 自己算签名，能过 WAF。
6. `session/event` 的事件类型在 **params.type 顶层**（不是 payload.type），`turn.failed` 也要处理
   （错误码在 `payload.error.attribution.providerErrorCode`），`replayState` 里不能有 `undefined`
   字段（lossless JSON 校验会炸）。
7. 服务端请求必须应答，否则 `session/create` 挂起：`session/requestRuntimePreferences` 回
   `{nativeSearchEnhancementsEnabled:false, memoryEnabled:false,
   askUserQuestionAutoResolutionEnabled:true, modelContextBudgetStrategy:'preflight-v1'}` 就够。

> HTTP 直连计划端点会被无痕验证拦 —— 只有 agent 二进制自己发的签名请求能过，
> 所以「反代」的形态是托管 agent 进程而不是自建 HTTP 网关。

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

```
node bin/dsh-connect-zcode.js              # 列出子命令
node bin/dsh-connect-zcode.js doctor       # 本地前置条件体检（离线，不耗额度）
node bin/dsh-connect-zcode.js models       # 打印 CLI 上报的完整模型清单
node bin/dsh-connect-zcode.js protocol     # 起 app-server 走一遍握手，验证协议没变
node bin/dsh-connect-zcode.js turn "hi"    # 真发一个回合（消耗额度）
node bin/dsh-connect-zcode.js image <file> # 发一张图（消耗额度）
```

通用参数：`--cli-path <zcode.cjs>`、`--data-dir <~/.zcode 的上级>`、`--model <id>`、`--json`、
`--allow-tools`。

`--allow-tools` 默认**关闭**，和插件本身的 `authorizationPolicy: deny` 一致。诊断命令会真的用你的
账号起一个 app-server agent，所以不带这个 flag 时，探针会对 agent 的工具权限请求回 `deny`：
`turn` / `image` 能验证通道和用量，但 agent 跑不了 Bash、写不了文件、上不了网。确实需要让探针
执行工具时再显式加上它。名称含 `approval`/`permission` 的未知请求两种情况下都拒绝。

`doctor` 会检查 node 版本、CLI 定位、builtin release（**只读检查，不喂给 CLI**）、
凭证（只打印长度与是否 JWT，绝不打印 token 本体）、以及 CLI 上报的模型清单。

> 这五个子命令取代了上游 `scripts/probe-*.cjs` 那十个一次性脚本。那些脚本各自硬编码了作者
> 本机路径、改一次才能问另一个问题，已删除。

## 选择启用哪些模型

在 **插件 → dsh-connect-zcode** 页面里，型号卡片会列出全部候选模型，每个模型一个开关；
顶部显示 `已启用 N/M`，右侧有「全部启用」和「重新读取」。

改动**先留在本地**：勾选只改草稿，底部出现「有未保存的修改」，点「保存」才写入一次
（不想留就点「放弃修改」）。保存后 DSH 的模型选择器随即按勾选结果增减。

> 为什么不是即时写入：每次切换都写配置的话，宿主会跟着重读一次模型目录，而该目录是按
> 当前配置过滤的——那次「写前发起、写后返回」的读取会短暂拿到上一版结果，整个列表在
> 勾选瞬间灰一下。草稿 + 保存把写入压到一次，这个闪烁就没有了。

（入口就在插件页面内，不会额外占用左侧栏的位置。）

插件默认把客户端能服务的**全部**模型都报给 DSH（本机实测 17 个，随账号与客户端版本变化）。
只想用其中几个时，用两个配置项挑：

```yaml
enabledModelIds:  [GLM-5.3, GLM-5.3-Flash]   # 只启用这两个（留空 = 全部）
disabledModelIds: [deepseek-flash]           # 额外停用（优先级更高）
```

改完保存即可（插件会重新解析配置，无需重装）；DSH 的模型选择器里就只剩勾选的那些。

**怎么知道该填哪些 id？** 跑一次诊断命令，它会列出全部 id，并按你当前的配置标注 `[disabled]`：

```powershell
node bin/dsh-connect-zcode.js models
node bin/dsh-connect-zcode.js models --enable-model "GLM-5.3,qwen3.8-flash"   # 预览勾选效果
```

填错的 id 不会被静默忽略：`models` 会打印 `enabledModelIds not found in the catalogue: ...`，
插件运行时也会在日志里 warn 一次，方便发现拼写错误。

> 说明：这是**显示层**的筛选 —— CLI 那边仍然能服务全部模型，路由表不受影响。
> 因此已停用的模型不会出现在选择器里，但不会因为“停用”而导致历史会话报错。
## 配置（设置 → 插件）

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 总开关 |
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
lib/index.js        插件装配：Config schema（模型列表字段标记 volatile）、provider 注册、模型清单来源决策
lib/app-server.js   app-server 通道：JSON-RPC 客户端 + LlmAdapter（事件流/回合锁/鉴权）
                    + resolveSpawnPlan()：桌面 / node 两种启动形态的唯一决策点
lib/client.js       浏览器半边：插件页的「zcode 模型」卡片（草稿 + 保存）
lib/zcode-runtime.js 桌面客户端发现、数据根解析、内置 release 选择、CLI 启动环境
                    （只用 Node 内置模块，doctor 在插件加载失败时仍可用）
lib/account-sync.js 套餐账号 provider 注册（updateAccountConfig + refreshRegistry）
                    与按路由选择签名凭证（account api-key / zcodejwt）
lib/messages.js     消息工具：图片物化、对话拍平、泄漏工具调用清洗
lib/credentials.js  解密 credentials.json（数据根优先、~/.zcode/v2 兜底）
lib/authorization.js app-server 权限请求策略（默认 deny）
lib/diagnostics.js  五个诊断子命令（doctor/models/protocol/turn/image），走同一套启动计划
bin/                可执行入口
test/               单测（node --test，100 个用例）：桌面发现、模型筛选、配置 volatile 门、
                    客户端命名空间绑定与草稿语义、账号套餐、鉴权、诊断
docs/               设计契约、安装/回滚、参考插件研究、发布清单
CHANGELOG.md        版本变更记录
verify/             E2E 验证脚本与证据（verify/desktop-e2e.mjs）
```

## 许可

AGPL-3.0。本仓库是 [kyle123740/dsh-zcode-cli-proxy](https://github.com/kyle123740/dsh-zcode-cli-proxy)
的衍生版：app-server 通道的逆向结论（回合锁、事件流、鉴权回调）源自上游，
v0.4.x 依实机重新验证并改写了账号/模型层。历史来源致谢
[liu5269/zcode2api](https://github.com/liu5269/zcode2api)，其代码已不再随本仓库分发。


