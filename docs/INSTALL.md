# 安装到 DSH profile（桌面客户端模式）

本插件已经在本机（`D:\AI\dsh\work\zcode-plan-bridge`）完成端到端验证：
`doctor` 全绿、`models` 列出 15 个模型、`turn --model qwen3.8-flash` 真实出字。
下面把它装进当前 DSH profile，让 **DSH 设置 → 模型** 里出现 provider `zcode-cli`。

profile 目录：`C:\Users\25293\.dsh\profiles\desktop`
（DSH 桌面端实际使用的 profile；`cordis.patch.yml` + `package.json` 决定加载哪些 bundle。）

> 所有步骤都可回滚：先备份 `package.json`，失败时还原并重新 `pnpm install` 即可。

> **本机状态（2026-10-23）**：已按方案 A 装好 —— profile `package.json` 里有
> `"dsh-zcode-plan-bridge": "file:D:/AI/dsh/work/zcode-plan-bridge"`，bundle 已登记，
> `pnpm install` 成功（+1 package，未改动其他依赖）。**重启 DSH 后生效**。

## 方案 A（推荐）：本地目录依赖 + bundle 注册

```powershell
$profile = "C:\Users\25293\.dsh\profiles\desktop"
Copy-Item "$profile\package.json" "$profile\package.json.bak-zcodebridge"

# 1) 把插件目录登记为 file: 依赖，并加进 bundle 列表
node -e @"
const fs = require('node:fs')
const p = String.raw`$profile` + '\\package.json'
const j = JSON.parse(fs.readFileSync(p, 'utf8'))
j.dependencies['dsh-zcode-plan-bridge'] = 'file:D:/AI/dsh/work/zcode-plan-bridge'
const bundles = j.dsh.profile.bundles
if (!bundles.includes('dsh-zcode-plan-bridge')) bundles.push('dsh-zcode-plan-bridge')
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n')
console.log('package.json updated')
"@

# 2) 安装（会创建 node_modules 里的链接；不改动其他依赖版本）
cd $profile
pnpm install --prefer-offline
```

然后重启 DSH（桌面端退出再打开）。启动日志里应出现：

```
[zcode-cli] launching the desktop client E:\zcode\ZCode.exe -> ...\resources\glm\zcode.cjs
[zcode-cli] account provider account:bigmodel-team-coding-plan registered
```

打开 **设置 → 模型 → 提供方 `ZCode CLI（客户端 agent）`**，应能看到 15 个模型
（13 个个人 provider + GLM-5.3 / GLM-5.3-Flash 两条套餐路由）。

## 方案 B：开发期热替换（不写 package.json）

DSH 的 loader 只在**行 name 变化**时重新 import，Node ESM 又以完整 URL 为缓存键，
所以本地开发时用 `file://` URL + `?v=N` 直接改 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-zcode-plan-bridge
      name: 'file:///D:/AI/dsh/work/zcode-plan-bridge/lib/index.js?v=1'
```

改完 `lib/*.js` 后把 `?v=1` 递增，然后在 **插件管理** 里对该 bundle 禁用 → 启用。
（注意：这种形态下插件对 `@deepseek-ai/*` 的 import 需要 profile 能解析到宿主依赖；
正式安装请用方案 A。）

## 卸载

```powershell
$profile = "C:\Users\25293\.dsh\profiles\desktop"
Copy-Item "$profile\package.json.bak-zcodebridge" "$profile\package.json" -Force
cd $profile; pnpm install
# 重启 DSH
```

## 装好后的自检（不依赖 DSH）

```powershell
cd D:\AI\dsh\work\zcode-plan-bridge
node bin/dsh-zcode-plan-bridge.js doctor     # 全绿
node bin/dsh-zcode-plan-bridge.js models     # 15 个模型
node bin/dsh-zcode-plan-bridge.js turn "Reply with exactly: OK" --model qwen3.8-flash
```

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `doctor` 报「not detected」 | 客户端装在非常规路径：设置 `zcodeClientRoot`（如 `E:\zcode`）或环境变量 `ZCODE_CLIENT_ROOT` |
| `doctor` 报 builtin not found | 先启动一次 ZCode 桌面端并登录，让它把 release 下载到 `<dataBaseDir>\.zcode\v2\runtime\provider\...` |
| 模型只有 13 个 | `accountSync` 被关掉，或该安装没有声明套餐 provider；开启 `accountSync` 再看 |
| `turn` 报 `1309 ... 套餐已到期` | **套餐本身过期**（本机即此情况），去 bigmodel 续订；插件与通道均正常 |
| `turn` 报 `Client signing requires an API Key` | 凭证链选错：确认 `accountSync` 开启（插件会按路由选 account api-key，而不是 JWT） |
| 插件加载报 `Cannot find package '@deepseek-ai/...'` | 用了方案 B 但 profile 解析不到宿主依赖；改用方案 A |

