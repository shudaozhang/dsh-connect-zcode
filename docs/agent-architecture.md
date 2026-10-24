# 架构真相：这是「双 agent」，不是「模型直连」

本文记录 2026-10-24 的实测结论。写它的原因：这个插件容易被误解成
「把 ZCode 的模型接到 DSH 用」，实际是**把 ZCode 的 agent 整个借给 DSH**。
两者的用户体验差别很大，装之前应该知道。

## 一句话

> 你的 DSH 会话里，**真正干活的是 ZCode 的 agent**。DSH 负责界面和会话管理，
> 模型推理跑在 ZCode 的 agent 循环里，用好坏 ZCode 的工具集。

## 实测证据

### 1. 模型确实有自己的一套工具，并会自主执行

```bash
$ node bin/dsh-connect-zcode.js turn "请用 Bash 执行 echo HELLO_FROM_TOOL 并把输出原样告诉我" \
    --model GLM-5.3-Flash --allow-tools

result success, 15 streaming deltas
  命令执行成功，Bash 工具返回的原始输出是：
HELLO_FROM_TOOL
```

ZCode 的 agent **自己跑了 Bash**，DSH 只收到最终文本。DSH 全程不知道发生过一次工具调用。

### 2. DSH 的工具对模型不可见

模型可用的是 ZCode 原生的：

```
Bash, Edit, Glob, Grep, Read, TodoWrite, Write
```

没有 DSH 的 `pwsh`、`fs-local`、`str-replace-editor`。所以 DSH 系统提示里列出的工具清单
对模型来说全是**幻觉来源**——它会模仿这些工具的调用格式，把 `<antml:invoke>` 当成正文输出
（这正是 `lib/app-server.js` 里 `BRIDGE_NOTE` 存在的原因）。

### 3. 为什么不能改成纯直连（三条路都试过了）

| 路线 | 实测结果 |
|---|---|
| `POST zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`<br>`x-api-key: <account api-key>` | **401** |
| 同上，`x-api-key: <zcodejwt>` | **401** |
| 同上，`Authorization: Bearer <zcodejwt>` | **405** `{"code":3012,"msg":"request has been blocked due to unusual activity."}` |
| `POST open.bigmodel.cn/api/anthropic/v1/messages`<br>`x-api-key: <account api-key>` | **429** `{"code":"1309","message":"您的GLM Coding Plan套餐已到期"}` |
| `POST api.z.ai/api/anthropic/v1/messages` | 同上 429 / 1309 |

解读：

- `zcode.z.ai` 是**套餐额度专用端点**，有 WAF 做请求签名校验。只有 ZCode agent 二进制
  自己算出的签名能过，`Bearer` 直连直接被判定为异常活动。
- `bigmodel.cn` / `api.z.ai` 认证**能过**（429 是业务拒绝，不是 401 认证失败），但那是
  **个人 API Key 计费**路线，不消耗 Coding Plan 额度。

**结论：想烧套餐额度，就必须让 ZCode agent 跑；想纯直连，就只能用自己的 API key。
两者目前无法兼得。**

### 4. 为什么不能把 DSH 的工具注册给 ZCode agent

CLI 二进制里确实存在这套 API：

```
mcp/uiRegisterAppTools     注册工具定义
mcp/uiClaimAppToolCall     认领一次调用
mcp/uiResolveAppToolCall   回填结果
```

我实际发出了 `mcp/uiRegisterAppTools` 调用，CLI 接受了（不是"方法不存在"），返回的
ZodError 逐条列出必填字段：

```
instance.runtimeId     string
instance.generation    number
instance.appIdentity   string   (必须匹配 /^[a-f0-9]{64}$/)
instance.token         string
```

从 CLI 里挖出的生成逻辑：

```js
runtimeId   = randomUUID()
generation  = 0
token       = randomUUID()
appIdentity = sha256(JSON.stringify([workspace, serverName, identity, accountContext]))

this.records.set(a.token, { lease, binding, source, cancel, pins })
```

`token` 是 `McpUiInstances` 类在 **ZCode App 渲染进程内存里**登记的路由键，校验时要在
同一个进程内的 `Map` 里查得到。DSH 作为 stdio 父进程拿不到、也伪造不出一个能命中的 token。

**这套注册 API 是 ZCode App ↔ CLI 的内部通道，不对外开放。**

## 这意味着什么

| 你可能期待的 | 实际情况 |
|---|---|
| 模型的 system prompt 是 DSH 的 | 是 DSH 的，但被 ZCode agent 的系统提示包在中间 |
| 模型用 DSH 的工具 | 用 ZCode 的原生工具，DSH 工具不可见 |
| DSH 的权限模式管住一切 | 只管 DSH 自己的调用；ZCode agent 的工具执行不经过它 |
| 这是个模型 provider | 这是个 agent provider |

DSH 的权限模式、审批界面、工具沙箱，对这个 ZCode agent 内部发起的操作**都不生效**。
`authorizationPolicy: deny`（默认）能让它的权限请求被拒，但那是插件自己回复协议请求实现的，
不是 DSH 的安全边界。

## 已经做的缓解

`lib/app-server.js` 在首轮内容前注入 `BRIDGE_NOTE`，做了两件事：

1. **技术性**：告诉模型只有原生工具可用，别把 DSH 的工具名当真实工具、别把调用标记写进正文
   （否则原始 markup 会漏进聊天窗口，看起来像"工具坏了"）。
2. **身份**：明确「你在为 DSH 的用户服务」「不必提及 ZCode、不要假设用户在用 ZCode」，
   减少模型自称 ZCode 助手的情况。

第 2 点是措辞层面的改善，**不改变第 1 节说的事实**。模型仍然在 ZCode 的 agent 循环里跑。

## 如果你要的是真正的「模型直连」

那不是这个插件能提供的，需要走个人 API Key：

```yaml
# 在 ZCode 客户端里配置个人 provider，或者直接用各家官方 API
# （DeepSeek / 智谱 / Anthropic 等），DSH 侧用对应的 llm 插件
```

代价是不再消耗 Coding Plan 套餐额度，改用按量计费的 API Key。
