# 发布清单（GitHub + DSH 插件市场）

本文件是**待办清单**，不是已经完成的记录。等你手动验收通过后再执行。
当前版本：`dsh-connect-zcode@0.6.0`。

## 0. 前置：手动验收

重启 DSH → 设置 → 模型 → 选提供方 `zcode` → 应看到 15 个模型
（若配置了 `enabledModelIds` 则是勾选后的子集）→ 选一个发一句话，确认能流式出字。

验收点：

- [ ] 提供方出现在模型列表里
- [ ] 模型数量符合预期（默认 15；勾选后为子集）
- [ ] 发消息能正常流式返回，且 `doctor`/日志里能看到 `launch=desktop`
- [ ] 停用一个模型后，选择器里确实消失

## 1. 发布前必须改的元数据

| 位置 | 当前值 | 要改成 |
|---|---|---|
| `package.json` → `repository.url` | 上游 `tangyixiao/dsh-connect-zcode`（占位） | 你自己的仓库地址 |
| `package.json` → `homepage` / `bugs.url` | 同上 | 你自己的仓库地址 |
| `package.json` → `author` / `contributors` | 继承上游作者 | 加上你自己（保留上游署名，AGPL 要求） |
| `README.md` → 「本仓库」链接 | 上游地址 | 你自己的仓库地址 |

> 许可证是 **AGPL-3.0**（上游要求）。发布时必须保留 `LICENSE` 与 README 里的
> 「上游原版 / 衍生自 kyle123740/dsh-zcode-cli-proxy」署名，不能改成 MIT。

## 2. 建议补的文件（插件市场通常需要）

- [ ] `CHANGELOG.md`（参考 `dsh-connect-trae` 的格式；至少写 0.6.0 的首个条目）
- [ ] 图标：`icon` 字段 + `icons/dsh-connect-zcode-128.png`（参考 trae/workbuddy 的 `package.json`）
- [ ] `screenshots.json`（参考 trae 的格式，指向 README 里的截图）
- [ ] README 顶部加一张实际界面截图（模型选择器里出现 zcode 模型）
- [ ] `THIRD_PARTY_NOTICES.md`（若打包第三方代码；本仓库目前无第三方运行时依赖，可省）

## 3. 本地打包自检

```powershell
cd D:\AI\dsh\work\dsh-connect-zcode
npm test                 # 62 用例应全过
npm run typecheck        # 0 错误
npm pack --dry-run       # 确认 files 列表只含 lib/bin/cordis.patch.yml/README/LICENSE
node bin/dsh-connect-zcode.js doctor
```

`files` 字段目前是 `["lib", "bin", "cordis.patch.yml", "README.md", "LICENSE"]` ——
`docs/`、`test/`、`verify/` 不会进包，这是有意的（诊断命令只在仓库里用）。

## 4. 推 GitHub

```powershell
cd D:\AI\dsh\work\dsh-connect-zcode
git remote -v                       # 确认当前 remote（现在是上游）
# 建议：新建你自己的空仓库后
git remote rename origin upstream
git remote add origin https://github.com/<你的账号>/dsh-connect-zcode.git
git push -u origin main
```

注意：仓库里已有两个提交历史来自上游（`Release 0.4.2` 等），保留它即是衍生关系的最好证明。

## 5. 上架插件市场

按你本机 `dshmarket`（v1.66.45）的流程：DSH 设置 → 插件市场 → 提交/发布入口，
通常需要 npm 包或 GitHub 仓库地址 + 名称/描述/关键词/图标。

发布前确认 `package.json` 的 `dsh.bundle.patch` 指向 `./cordis.patch.yml`（已有），
并且 `cordis.patch.yml` 里的行 `name` 是包名 `dsh-connect-zcode`（已有）。

## 6. 已知限制（写进 README / 市场描述，避免误导）

- 需要本机已安装并登录 **ZCode 桌面客户端**；没有客户端时插件不会注册 provider。
- 套餐（`account:*`）路由需要账号有**有效**的 Coding Plan；本机当前套餐已到期，
  所以 GLM-5.3 会返回上游业务错误 `1309`（插件与通道正常）。
- 只支持 Windows/macOS/Linux 中客户端实际存在的平台；Windows 走注册表发现安装根。
- 这是「把本机已登录客户端的额度转给 DSH 用」的桥，不是官方 API 客户端。
