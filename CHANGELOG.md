# Changelog

本项目的所有重要变更记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
