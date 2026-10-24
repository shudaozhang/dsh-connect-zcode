# Changelog

本项目的所有重要变更记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
