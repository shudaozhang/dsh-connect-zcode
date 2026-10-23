# 参考插件模式研究 / Reference-plugin patterns

**Context.** `dsh-connect-zcode` 把 ZCode CLI 自带的 agent 以 provider `zcode-cli` 接进 DSH：常驻
`zcode app-server`（stdio JSON-RPC），从 `session/create` 读账号可服务的模型清单，按 DSH sessionId
复用会话，鉴权走 `interaction/requestProviderRuntimeHeaders` 回 `zcodejwttoken`。本文从三个"连接本机
已登录客户端"的已装插件提取可复用模式，并逐条对照本仓库现状。

**Legend**：`[T]`=dsh-connect-trae 4.0.1、`[W]`=dsh-connect-workbuddy 4.12.0、`[C]`=dsh-codearts 1.1.1，
均在 `C:\Users\25293\.dsh\profiles\desktop\node_modules\<pkg>\`；`[Z]`=`D:\AI\dsh\work\dsh-connect-zcode`。
`[T]/[W]/[C]` 的引用是**已发布产物**（`lib/*.js`、`lib/*.mjs`、`cordis.patch.yml`、`package.json`）的
`file:line`，版本固定、行号稳定；`[Z]` 因本仓库在并行开发，改用**符号/字段名**引用（如
`resolveModels`、`Config.cliModels`），避免行号漂移后失效。

形态差异很重要：`[T]`/`[W]` 读桌面客户端的加密登录文件，`[C]` 完全不碰本机文件（在 DSH 内跑
OAuth2 PKCE+DPoP）。本桥属前者，但多一层"客户端自带 CLI 进程"，故少数模式（token 续期、账号池）
**不适用**，下文逐条标注。

---

## 1. 本机安装/应用发现 Local app discovery

- **R1.1 候选路径按平台+版本矩阵枚举，去重后按序探测** — 证据 `[T] lib/index.js:2416-2447`
  （`traeStorageCandidates`：各平台 root × 各 edition 目录名拼成有序候选，再追加 CLI 候选）；目录名
  权威来源是客户端 `product.json` 的 `win32DirName`，同时并列探测小写拼写，理由写明"哪种拼写被写入
  从未在真机确认"（`:2390-2404`）。 — 应用于本桥：`[Z] lib/zcode-runtime.js` 的 `ZCODE_CLI_CANDIDATES` 已有 5 类候选
  （env→LOCALAPPDATA→ProgramFiles→mac→linux→PATH 里的 npm 全局包），但缺"多个安装并存时逐个验证"
  的语义；建议把候选表改成 `{path, source}` 结构，并在探测时记录每条结果。
- **R1.2 全部候选失败时，错误里列出每一条尝试过的路径** — 证据 `[T] lib/index.js:3884-3896`
  （逐个试，`anyPresent` 为假才报 not found，消息用 `candidates.map(...).join(" or ")` 列出全部）；
  `:3871-3873` 用 `code === 'ENOENT'` 区分"不存在"与"存在但解析失败"，后者原样上抛而非吞成"没安装"。
  — 应用于本桥：`[Z] lib/index.js` 的 `apply()` 内 "no ZCode CLI found" warn 只 `logger.warn('no ZCode CLI found, … set zcodeCliPath')`，
  不含路径；改成携带 `tried[]` 的结构化错误，`doctor` 直接复用。
- **R1.3 Windows 用卸载注册表兜底，并回报"是怎么找到的"** — 证据 `[W] lib/host-heartbeat-DEutghDy.js:1194-1216`
  （扫 HKCU/HKLM/WOW6432Node 的 `…\Uninstall`）；`:1226-1233` 解析 `DisplayIcon`、`:1248-1256` 解析
  `InstallLocation`、`:1273-1281` 处理 `"E:\app\App.exe",0` 的引号逗号；`:1440-1467` 返回
  `{executable, source: 'env'|'default-layout'|'registry'|'nested-bundle'}` 供 doctor 解释来源。
  — 应用于本桥：ZCode 装到非默认盘符时现有候选会全 miss；加只读 `reg query` 探测（`windowsHide`、
  超时、失败即跳过），并把 `source` 一路带到 `doctor` 输出。
- **R1.4 CLI-only 降级路径：用 CLI 自己的持久标识，绝不编造** — 证据 `[T] lib/index.js:3976-3983`
  （桌面文件缺失时转 `readTraeCliIdentity`）；`:3923-3947` 从 `argv.json` 的 `crash-reporter-id`、
  `builtin/ide_version.json` 的 `version` 派生稳定身份，注释明确"伪造身份比可见的'未登录'更糟"。
  — 应用于本桥：本桥无需伪造身份，但"降级要有据可依"同样适用于"只有 npm 全局 CLI"的场景；
  `[Z] lib/zcode-runtime.js` 的 `npmGlobalCliCandidates` 已有该候选，应在 doctor 里标出 `source: desktop|npm-global|env`。
- **R1.5 版本探测用于请求头/能力门控，读不到就不发（而不是失败）** — 证据 `[T] lib/index.js:3842,3859`
  从 `product.json` 读 `appVersion`；`:3993-3995` 转成 `x-app-version`/`x-ide-version`；`:4304-4309`
  读不到时用常量兜底。 — 应用于本桥：app-server 字段随 CLI 版本变（README:22-23 记录 builtin
  `revision` 超版本即启动失败），建议握手时记录 CLI 上报的版本并写入 `doctor --json`，便于按版本分流。
- **R1.6 缺件 UX：探测位置 + 每条原因 + 来源 + "把你的路径反馈给我们"** — 证据
  `[T] lib/client.js:5757-5764`（`searchedTitle`/`searchedHint` + `reasonMissing`=文件不存在 /
  `reasonUnreadable`=无法读取 / `reasonInvalid`=格式无法识别 + `sourceDesktop`/`sourceCli`）；
  `[T] README.md:262-263` 把路径写进文档。 — 应用于本桥：`doctor` 的失败输出照此组织（每候选一行
  + 结论 + 下一步），而不是只给一句 not found。

## 2. 本机凭证/账号复用 Local credentials

- **R2.1 解密集中在一个模块，格式写进注释，失败用稳定机读码分流** — 证据 `[T] lib/index.js:2213-2245`
  （`sha512` 派生 → AES-128-CBC，两种 salt 变体，64 字节头校验，明文过短即 throw）；`:2248-2253`
  注释完整记录 `[6-byte header][32 random][ciphertext]` 布局，并说明写回必须用同一方案。
  — 应用于本桥：`[Z] lib/credentials.js` 已达标（`enc:v1:` AES-256-GCM +
  `CREDENTIAL_ERROR_CODES` 七个码），**保持现状**。
- **R2.2 插件自持副本 + 墓碑，避免"删了又回来"** — 证据 `[T] lib/index.js:2587-2589`（每区域一个
  `$DSH_HOME/.trae-auth.<region>.json`）、`:2595-2597`（旧单文件留作迁移）、`:2889-2918`（墓碑读取
  **防御式**：缺失/损坏/手改 = 无墓碑，绝不让 store 失败）、`:2935-2964`（`mirrorLocalLogins` 为
  **加性**写入，已有副本不动）。 — 应用于本桥：**副本/墓碑不适用**（CLI 自己管账号，桥只读
  `credentials.json`）；但"本地状态文件损坏不得让插件加载失败"这条防御式读取应照抄。
- **R2.3 续期先看 skew；刷新失败但旧 token 仍有效时继续用** — 证据 `[T] lib/index.js:3535-3564`
  （无 refresh token 且 access token 还有 `>30s` 有效期 → 直接返回；否则抛 "sign in again in Trae"；
  成功则在文件锁内写回 `:3551-3558`；失败时若旧 token 仍有效则降级返回）；`:2575`
  `REFRESH_RETRY_MS = 3e5`（失败记忆 5 分钟，避免每次轮询都打上游）。 — 应用于本桥：**刷新不适用**
  （CLI 负责），但"每轮按需重读 `credentials.json` 而非启动时缓存"与"失败后短期不重试"适用：
  建议 `[Z] lib/app-server.js` 处理 `interaction/requestProviderRuntimeHeaders` 处 处理鉴权回调时按需读取，并对读取失败做短 TTL 记忆。
- **R2.4 设置里只存账号 id，绝不存 token；前端只拿得到"是否有 token"** — 证据
  `[T] lib/index.js:9179-9181`（三个 `z.string().description("… (never a token)")`）；`:7975-7977`
  注释：Host 拥有凭证每个字节，浏览器只收到 uid/nickname/email + `hasToken` 布尔。 — 应用于本桥：
  Config 无 token 字段（`[Z] lib/index.js` 的 `Config`）已符合；将来做卡片时这是硬约束。
- **R2.5 所有对外消息统一过一遍脱敏器** — 证据 `[T] lib/index.js:7265`（JWT 正则 → `[redacted token]`、
  `code=|token=|refresh_token=|access_token=` 值 → `[redacted]`，并 `.slice(0, 500)` 截断）；
  `:8974` `maskUserPath`（用户名换 `<user>`）；`[W] lib/bin.js:38-40` 同思路的 `safeMessage`。
  — 应用于本桥：`[Z] lib/diagnostics.js:184-188` 已做到"只打长度 + 是否 JWT"（很好），但**异常路径**
  未见统一脱敏；建议提取 `redact()`，让 `doctor`、`logger.*`、抛出的 Error message 全部经过它。
- **R2.6 settings namespace 用兼容解析，不硬编码字符串** — 证据 `[C] lib/index.mjs:2008-2010`
  （`settingsCompatNamespace` 先探测再回退）；`[T] lib/index.js:9067-9070`
  （`ctx.fiber.entry?.options.id ?? NS`，理由见 `:9052-9065`：advertise 错 namespace 会让 provider
  被判为"未配置"，配置入口与模型发现双双失效）。 — 应用于本桥：`[Z] lib/index.js` 的 `entryNs` 已用
  `ctx.fiber?.entry?.options?.id ?? name`，**已达标**，无需改动。

## 3. Provider/模型注册 Provider & model registration

- **R3.1 三件套：`registerAdapter` + `registerModelDiscovery` + `registerConfigurableProviders`** — 证据
  `[T] lib/index.js:10235`（adapter）、`:10238-10252`（discovery 返回
  `{id, name, contextWindow, maxTokens, inputModalities}`）、`:10253-10259`（configurable providers：
  `{provider, displayName, settingsNs, settingsPath: [], declared: false}`）；`[C] lib/index.mjs:2215-2222`
  是最小可用版本（单 provider、无 discovery）。 — 应用于本桥：`[Z] lib/index.js` 的 `apply()` 注册段 只注册了
  adapter + configurable providers，**缺 `registerModelDiscovery`** → 模型清单只在加载/改配置时刷新，
  用户在 CLI 里换账号后必须重启 DSH。建议补上，回调复用 `session/create` 的 `settings.model.available`
  （解析已有：`[Z] lib/zcode-runtime.js` 的目录条目归一化），并缓存 app-server 句柄以免每次发现都 spawn。
- **R3.2 `contextWindow` 必须为正整数，否则整个 provider 掉线** — 证据 `[T] lib/index.js:695-701`
  （注释：DSH 对没有可用 context 的 adapter 回 `INVALID_MODEL_CONTEXT`，且失败是 **per-provider**，
  "一行坏掉整个区域离线"），故静态兜底表每行都带 `contextWindow`（`:703-724`、`:737-773`）。
  — 应用于本桥：兜底表已带（`[Z] lib/zcode-runtime.js` 的兜底目录表），`min(1)` 也挡住非法值（`[Z] lib/index.js` 的 `catalogModel`）。
  **真正该抄的是"别对上游过度承诺"**：`[Z] lib/index.js` 的 `resolveModels` 在用户钉死 `cliModels` 且未写
  contextWindow 时直接填 1M，而 CLI 可能只报更小窗口——建议"钉死值 > CLI 上报值时以 CLI 为准 + warn"。
- **R3.3【已达标，见下】把上游 reasoning 档位映射成 DSH 的 reasoning 元数据，而不是丢掉** — 证据
  `[T] lib/index.js:911,944`（`Object.fromEntries(model.reasoning.supported.map(...))`，并把
  `low→light`、`xhigh→extra_high` 归一）；`:1272-1284` 转成 pi-ai 的 `thinkingLevelMap` +
  `compat.supportsReasoningEffort`；`:4368` 有 allow-list 过滤上游乱报的档位。 — 应用于本桥：
  **明确缺口**。CLI 已上报 `reasoning:{levels,defaultLevel}`（README:85-87），
  `[Z] lib/zcode-runtime.js` 也把它解析成 `reasoningLevels`/`defaultReasoningLevel`，但
  `[Z] lib/index.js` 的 `catalogModel` 里**没有 `reasoningEfforts`**（全仓库 grep 无该字段）→
  DSH 的思考档位选择器对本 provider 不可用。
  【2026-10-23 复核：该项**已实现**，且实现方式比本建议更正确 —— 适配器在 `reasoningInfo()` 里返回 `{efforts:[{id,name}],defaultEffort}`，由 `resolveModel()` 挂到 `LlmResolvedModelInfo.reasoning`，这正是 dsh-llm 的适配器契约（`reasoningEfforts` 是 pi-ai 风格 provider 配置字段，不是自定义适配器的入口）。所以不需要改。】原文建议保留供参考：加 `reasoningEfforts: Object.fromEntries(levels.map(l => [l, l]))`（先过滤未知档位），
  并在 `session/setModel` 时把 DSH 的 effort 映射回去（`DEFAULT_REASONING_LEVEL` 已有）。
- **R3.4 目录 = "选择 ∩ 上游清单"，空选择=全量，且永不为空** — 证据 `[T] lib/index.js:960-970`
  （`deriveCatalog`：`enabled.size === 0 ? catalog : catalog.filter(...)`）；`:984-985`（空目录直接
  throw "cannot be empty"）；`:9275-9279`（`dropDeadModels` 用"上游确认可调用"的集合过滤掉上游列了
  但实际会 400 的模型）。 — 应用于本桥：`cliModels` 语义（空=跟随 CLI，非空=钉死，README:155）已等价
  于前两句；`dropDeadModels` 的对应物是"同一 model id 多 provider 时优先 `account:` 路由"
  （README:57-59）——建议把该优先级写成**显式函数 + 单测**，而不是散在路由选择里。
- **R3.5 上游 HTTP 200 但业务码非 0 = 失败；保留厂商码不翻译** — 证据 `[T] lib/index.js:6623-6626`
  （"business refusal arrives as HTTP 200 with a non-zero `code`"）、`:5048-5061`（业务码 → `{status,
  kind}`：`1005→402/hard_credit`、`4011→429/soft_rate`）、`:5019-5028`（`describeTraeFailure` 保留
  `Trae code N · plan M · upstream: …`）。 — 应用于本桥：`turn.failed` 同样"帧成功、内容才失败"
  （README:93-95 记录错误码在 `payload.error.attribution.providerErrorCode`）；建议建一张
  `code → {status, kind, hint}` 表并把原码留在消息里（便于搜 issue），并让 `retryPolicy`
  （`[Z] lib/index.js` 的 `retryPolicy`，目前只看超时/传输层）消费 `kind`。

## 4. Config / 设置面 Settings surface

- **R4.1 Config 描述用中文，写"怎么填"而不是"是什么"** — 证据 `[T] lib/index.js:9170`
  （`creditPosition`：`"积分读数显示位置：\"composer\" = 输入框工具栏（默认），\"stats\" = … 装了别的
  插件后读数不显示时改成 stats。"`）、`:9172-9175`（账号池四字段全中文且给默认值语义）、`:9193`
  （`showPointsInMainUi` 写清"仅当选中的模型属于本插件时出现，可点击查看账号与积分明细"）。
  — 应用于本桥：`[Z] lib/index.js` 的 `Config` 全是英文短描述，而 README 是中文；建议改中文并补
  "什么时候需要改"，重点 `cliModels`、`authorizationPolicy`、`childEnvAllow` 三个易误配字段。**S 级、零风险。**
- **R4.2 布尔开关用 opt-out 语义，且 UI 与 Host 共用同一个判定函数** — 证据 `[T] lib/index.js:9098-9115`
  （`regionEnabled`：只有显式 `false` 才关闭，老配置无该字段仍工作；注释说明卡片读同一条规则，
  "两半永不会对同一区域状态各说各话"）。 — 应用于本桥：`[Z] lib/index.js` 的 `resolveOptions`
  （`enabled: config.enabled !== false`）已是 opt-out，**已达标**；若加卡片须复用 `resolveOptions`。
- **R4.3 字段演进：废弃字段保留可读 + 标 `Deprecated:`，绝不静默丢弃** — 证据 `[T] lib/index.js:9192,9196-9200`
  （`accountId`/`lastCatalog`/`enabledModelIds`/`contextBudgets`/`imageModelIds`/`models` 全保留，
  描述前缀 `Deprecated:`，并在 `:9086-9096` 做一次性迁移）。 — 应用于本桥：`cliModels` 的
  `cliModelId` 与 `id` 已并存（`[Z] lib/index.js` 的 `catalogModel`）；将来改字段名照此保留旧字段读取。
- **R4.4 若要写设置（卡片），被写字段必须标 `.volatile()`** — 证据 `[T] lib/index.js:9130-9147`
  （`asVolatile` 探测 `schema.volatile`；注释：没有该标记时 0.1.7 写入闸门回
  `Plugin entry "trae" has no volatile fields`，而 `scope.set()` 仍 resolve，"卡片看起来保存成功，
  然后悄悄回退"）。 — 应用于本桥：**当前不适用**（无卡片）；一旦实现卡片写入必须先加 `.volatile()`。
- **R4.5 客户端 UI 接入形状（若要卡片/读数）** — 证据 `[T] package.json:55-70`（`dsh.bundle.patch` +
  `dsh.client.inject: [dsh-client-ui-renderer, …-settings, …-slots, …-settings-plugins, …-primitives,
  …-locale]` + `platform: "web"`）；`[C] package.json:70-83` 另有 `external`；`[T] lib/client.js:6074`
  客户端侧 `inject = ["slots", "locale"]`；`:6168-6184` 注册到 `plugins.bundle.config` 与
  `plugins.row.config`；`:6178-6181` **整段 try/catch**，失败只 `console.error("card slot … failed to
  register (host provider unaffected)")`——UI 坏了不能拖垮 provider。 — 应用于本桥：目前无 UI
  （`[Z] package.json` 无 `dsh.client`）；若要做"账号/模型/诊断"卡片，按上述形状且必须保留隔离。
  工作量 **L**，风险中等（slot API 跨版本变，`[T] lib/client.js:6205` 记录了 `id`/`order`→`key`/`priority`）。
- **R4.6 用量/积分卡的前提本桥没有** — 证据 `[T] README.md:84`、`[W]` 的 credits/checkin 都建立在
  "插件直接 HTTP 调厂商只读计费接口"上，而本桥拿不到（见"不适用清单"）。可替代信号只有 app-server
  回合事件自带的 usage：建议先把每回合 usage 落进诊断日志，再考虑展示，**不要**为卡片去反代计费接口。

## 5. 诊断/健康检查 Diagnostics & error conventions

- **R5.1 独立诊断 CLI：子命令 + `--json` + `schemaVersion` + 脱敏** — 证据 `[W] lib/bin.js:41-51`
  （`doctor`/`status`/`logout` + `--json` 帮助）、`:29,103`（`JSON_SCHEMA_VERSION = 4` 写进报告，
  注释说明版本号让消费方区分"老构建"与"字段缺失"）、`:38-40`（`safeMessage`）、`package.json:23-25`（bin）。
  — 应用于本桥：`[Z] bin/dsh-connect-zcode.js` + `[Z] lib/diagnostics.js` 已有五子命令与 `--json`
  （`diagnostics.js:883`）。**缺口**：JSON 无 `schemaVersion`/`package`/`version`，建议补齐（S 级），
  让 issue 里贴的 JSON 可长期解析。
- **R5.2 诊断要回答"探测了什么、怎么找到的、缺什么"** — 证据 `[W] lib/bin.js:118-123`
  （`desktopAuthFile: {path, dir, candidates, present}`——把候选表本身放进输出）、`:130-140`
  （`atRestDecryption: {appExecutable, appExecutableSource, available}`，注释：没有该字段时旧报告
  无法解释路径来源，只能让每个用户去设环境变量）。 — 应用于本桥：`doctor --json` 加
  `cli: {path, source, tried[], exists}` 与 `credentials: {path, exists, keys[], tokenLength, isJwt}`
  （后者已有 `[Z] lib/diagnostics.js:184-188` 的判定，挪成结构化字段即可）。
- **R5.3 诊断脚本必须跑**真实产物**，且输出可直接贴公开 issue** — 证据 `[T] scripts/verify-windows.mjs:1-20`
  （"直接跑本插件的构建产物，不是重写一份逻辑"；只输出脱敏路径/形态/判定；脱敏助手来自 `src/redact.ts`
  而非脚本里再写一版，理由是"隐私逻辑最怕两处各写一版"）、`:38-60`（找不到构建产物时给操作指引
  而不是 `ERR_MODULE_NOT_FOUND` 栈）。 — 应用于本桥：`doctor` 已复用 `lib/*.js`（符合）；建议把脱敏
  集中一处并被 `doctor` 与异常处理共用，且 `bin/` 对"插件加载失败"给指引（README:123 已宣称该能力，
  需在 `[Z] bin/dsh-connect-zcode.js` 落实并加测试）。
- **R5.4 面向用户的错误 = 现状 + 下一步动作** — 证据 `[T] lib/client.js:5755-5756`（`signedOut`"未登录"
  + `signedOutHint`"在 Trae 桌面 App 里登录一次即可，插件会自动跟随当前登录的账号"）、`:5767-5768`
  （refresh token 将过期/已过期各给"还剩 N 天 / 请重新登录"）。 — 应用于本桥：`[Z] lib/index.js` 的 `apply()` 内 "no ZCode CLI found" warn
  的 warn 只有"没找到 + 设选项"；建议补全为"缺什么 → 为什么 → 用户该做什么 → 可跑哪条诊断命令"。
- **R5.5 失败分类只做"能决定行为的"映射，不翻译厂商码** — 证据 `[T] lib/index.js:5048-5061` 与
  `:5029-5047` 注释（把 `4011` 从 `400/client` 改判 `429/soft_rate`，因为 pi-ai 按文本分类
  `RATE_LIMIT` 且可重试，"三处必须一致"）。 — 应用于本桥：见 R3.5，`retryPolicy` 应消费业务 `kind`。

## 6. 打包/安装 Packaging

- **R6.1 bundle patch 只做一件事：insert 一行，不动 profile 默认模型** — 证据 `[T] cordis.patch.yml:1-4`
  （"Register the Trae provider without changing the profile's default model"）、`[W] cordis.patch.yml:1-7`
  （多一句 "reuses the desktop app's sign-in; no separate OAuth flow"）、`[C] cordis.patch.yml:1-6`；
  三者 `- insert: [{id, name}]` 的 `name` 都是包名。 — 应用于本桥：`[Z] cordis.patch.yml:11-13` 已一致
  （注释更详细），**无需改动**；注意 `id` 同时是设置页分组键，改名等于换设置命名空间。
- **R6.2 profile 侧是两处：`dependencies` + `dsh.profile.bundles`** — 证据
  `C:\Users\25293\.dsh\profiles\desktop\package.json:4-24`（依赖）与 `:31-52`（bundles 数组，三个参考
  插件都在其中，顺序即加载顺序）。 — 应用于本桥：README:46 只说"装进 DSH profile"；建议补
  "需同时出现在 `dependencies` 与 `dsh.profile.bundles`"，给出 `dsh plugin --profile desktop add
  dsh-connect-zcode`（`[T] README.md:151-163` 的写法）与"改完 bundle 需重启 DSH 进程"（同处 `:163`）。
- **R6.3 `exports` 要显式导出 `./cordis.patch.yml` 与 `./package.json`** — 证据 `[T] package.json:24-32`、
  `[W] package.json:27-35`、`[C] package.json:36-47` 三者 exports 都含这两条，客户端入口另导 `"./client"`。
  — 应用于本桥：`[Z] package.json:36-41` 只有 `"."` 与 `"./package.json"`，**缺 `"./cordis.patch.yml"`**；
  当前 loader 走 `dsh.bundle.patch` 能工作，但补齐可与参考插件对齐、避免将来 loader 改 subpath import
  时被 exports 挡掉（S 级）。
- **R6.4 `files` 白名单只发运行时需要的** — 证据 `[T] package.json:33-45`（`lib`、`icons`、单张卡片截图、
  `scripts/verify-windows.mjs`、`cordis.patch.yml`、README/CHANGELOG/THIRD_PARTY_NOTICES/LICENSE）；
  `[C] package.json:48-58`（另含 INSTALL/DEV 文档）。 — 应用于本桥：`[Z] package.json:69-75` 是
  `lib/bin/cordis.patch.yml/README/LICENSE`，**缺 `docs/`**——若 `docs/desktop-integration-contract.md`
  想随包分发需加入；`bin` 已包含，诊断可用。
- **R6.5 `engines` 收窄 + peer 给宽区间** — 证据 `[T] package.json:18-20`（`node: ^22.19.0 || >=24.0.0`）；
  `:79-92` peer 全是 `>=x <y` 区间而非固定版本（`@earendil-works/pi-ai: >=0.85.1 <2.0.0` 跨两代）。
  — 应用于本桥：`[Z] package.json:66-68` 是 `node >=22`（比参考插件宽松）；peer 已用区间（`:48-52`），
  符合；建议 engines 对齐到 `^22.19.0 || >=24`。
- **R6.6 提供一键安装/自检文档，且绝不脚本化改 profile manifest** — 证据 `[C] INSTALL.md:9-22`
  （三步：包放 `node_modules` → `dependencies` 声明 → 登记；`scripts/deploy.mjs` 自动化并留
  `*.bak-codearts-*` 备份）、`:43-47`（装后自检清单）、`:94-96`（**警告**：绝不能用 Windows
  PowerShell 5.1 的 `Set-Content`/`Out-File` 写 profile manifest）。 — 应用于本桥：README 只写
  "装 CLI + 装插件"，没有"装错了怎么查"；建议加 `## 安装与自检` 一节，直接复用 `doctor` 输出当清单。

---

## 不适用清单 / What does **not** transfer

| 模式 | 出处 | 为什么本桥不适用 |
|---|---|---|
| 账号池 / 自动换号 | `[T] lib/index.js:9172-9175`、`[W] lib/index.js:6155-6168` | CLI standalone 模式由本进程管账号（README:17-19），宿主无法注入或切换；桥只能**报告**当前账号，不能轮换。 |
| Token 自动续期 | `[T] lib/index.js:3535-3564` | 桥不持有 refresh 流程；只应"按需重读 + 失败短期记忆"。 |
| 插件自持凭证副本/墓碑 | `[T] lib/index.js:2587-2589,2889-2918` | 无副本即无删除语义；但"防御式读取本地状态"仍应照抄。 |
| 积分/签到卡片 | `[T] README.md:84`、`[W]` credits 路径 | 需厂商计费 HTTP API；本桥直连会被无痕验证拦（README:100-101）。 |
| 客户端 UI 卡片 | `[T] package.json:55-70`、`lib/client.js:6074-6184` | 可选，但成本 L 且 slot API 跨版本会变；`doctor` 已覆盖信息需求。 |

---

## Top 10 优先建议 / Prioritized recommendations

| # | 建议 | 依据 | 工作量 | 风险 |
|---|---|---|---|---|
| 1 | ~~目录模型补 reasoningEfforts~~ **已达标**：`reasoningInfo()` 已返回 efforts/defaultEffort | R3.3 | — | — |
| 2 | 补 `registerModelDiscovery`，让模型清单可热刷新 | R3.1 | **M** | 中：需复用/缓存 app-server 句柄，避免每次发现 spawn |
| 3 | `doctor --json` 加 `schemaVersion` + `cli{path,source,tried,exists}` + 结构化 credentials | R5.1, R5.2 | **S** | 低：纯增量字段，只加不改 |
| 4 | Config 描述改中文并写清"何时需要改" | R4.1 | **S** | 低：纯文案 |
| 5 | 统一 `redact()`，覆盖异常/日志/诊断全部出口 | R2.5 | **S** | 低：注意别过度脱敏掉排障所需路径 |
| 6 | CLI 定位失败时输出"尝试过的路径 + 每条原因 + 下一步" | R1.2, R1.6 | **S** | 低：错误结构变化，需同步 doctor 与测试 |
| 7 | win32 注册表兜底探测 + `source` 字段 | R1.3 | **M** | 中：`reg query` 子进程需 `windowsHide`/超时/失败即跳过，不可作唯一依据 |
| 8 | 业务码 → `{retryable, kind}` 映射，`retryPolicy` 消费 | R3.5, R5.5 | **M** | 中：错判可重试会把额度浪费在必然失败的请求上 |
| 9 | `exports` 补 `./cordis.patch.yml`；`files` 补 `docs/`；`engines` 对齐 `^22.19 \|\| >=24` | R6.3, R6.4, R6.5 | **S** | 低：打包元数据；`files` 影响发布体积 |
| 10 | （可选）账号/诊断卡片：`dsh.client.inject` + slot 注册 + "UI 失败不影响 provider"隔离 | R4.5 | **L** | 高：slot API 跨版本变动；建议前 9 项稳定后再做 |

**落地顺序**：1 → 3 → 5 → 6（都不动通道层，风险最低）→ 2 → 8 → 7 → 9 → 4 → 10。
其中 #1 是唯一"用户立刻能感知到功能缺失"的项（思考档位选择器当前不可用），建议最先做。

