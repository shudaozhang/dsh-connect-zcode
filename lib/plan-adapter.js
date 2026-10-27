/**
 * 计划额度直连通道的 DSH `LlmAdapter`：把 `lib/plan-client.js` 的 HTTP 事件流接进
 * DSH 的 `StreamChunk` 协议。
 *
 * ## 这个模块在整盘里的位置
 *
 * 旧通道（`lib/app-server.js`）托管 ZCode 的 agent 子进程，让 agent 替我们发模型请求；
 * 直连通道（本模块 + `lib/plan-client.js`）直接拿本机凭证打套餐自己的
 * `/v1/messages`，一个子进程都不起。两者对 DSH 是同一个接口：一个 `LlmAdapter`。
 *
 * 分层刻意做成三层，每层都能单独测：
 *
 * ```
 * ZcodePlanAdapter          装配：模型清单、凭证、路由、错误翻译
 *   ├─ 纯函数                请求体翻译 / 事件映射 / 模型清单筛选 / 错误映射
 *   └─ plan-client.js        HTTP + SSE + 上游错误分类（已完成，27 单测）
 * ```
 *
 * ## 模型 id 规则（为什么是 `<providerId>#<modelId>`）
 *
 * 旧通道里 DSH 模型 id 就是 CLI 的 `modelId`（纯 id），因为 agent 自己知道该走哪条路由：
 * `session/setModel` 会带 `{providerId, modelId}`，而 `collapseCatalog`
 * （`lib/zcode-runtime.js:896-908`）保证同一个 `modelId` 在清单里只出现一次。
 *
 * 直连通道没有这个环节 —— 请求是我们自己发的，而 `GLM-5.3-Flash` 同时挂在
 * start-plan / coding-plan / offpeak / highspeed 四条路由上，烧的额度和打的上游都不同。
 * 纯 `modelId` 无法表达「烧 start-plan」，所以 id 必须带路由：
 * `<providerId>#<modelId>`，例如 `account:zai-start-plan#GLM-5.3-Flash`。
 *
 * 这条规则不是本模块自创的：它由 `lib/plan-routes.js` 的 `planModelId` /
 * `parsePlanModelId` 定义（含 `#`、`/`、裸 modelId 三种写法的解析），诊断命令
 * `plan-models` 也按这套输出。本模块只**复用**它，并把裸 modelId 的「按路由优先级选
 * 第一条能服务的路由」语义交给 `parsePlanModelId`（路由表已按
 * start-plan → individual → team → offpeak → highspeed 排序，见
 * `lib/plan-routes.js:62-77` 与 `compareProviders`）。
 *
 * 与旧通道的一致性：`collapseCatalog` 的排序是「先 Start Plan，再 individual/team
 * coding-plan，最后其它 account 路由」（`lib/zcode-runtime.js:921-928`），
 * `PLAN_KIND_ORDER` 与它同序，所以两个通道对「同一模型优先走哪条路由」的答案一致。
 *
 * ## 模型清单从哪来
 *
 * 权威来源是 ZCode 客户端自己写在磁盘上的 builtin release：
 *
 * ```
 * <dataBaseDir>/.zcode/v2/runtime/provider/<platform>/<version>/endpoint-XXXX/zcode-builtin.json
 * ```
 *
 * 其中 `config.providerConfigRules.providerRules` 的 `account:*` 规则给出「哪条路由、
 * 什么 baseUrl、有哪些模型」（`lib/plan-routes.js` 负责读它并归一），
 * `config.modelConfigRules.modelRules` 给出「某模型的上下文/输出上限/是否支持图片/
 * 推理档位」（本模块的 {@link resolveModelTraits} 负责）。
 *
 * 客户端没装也能用：读不到 release 时，`lib/plan-routes.js` 降级到
 * `FALLBACK_PLAN_PROVIDERS`，本模块降级到 {@link FALLBACK_MODEL_TRAITS}（本机
 * 3.16.3 / revision 33 的实测快照）。
 *
 * ## 事件映射（plan-client → DSH `StreamChunk`）
 *
 * | plan-client 事件 | DSH chunk |
 * |---|---|
 * | `{type:'text',delta}` | `block-start{blockType:'text'}` → `text-delta` → 块切换/结束时 `block-end{block:{type:'text',text}}` |
 * | `{type:'reasoning',delta}` | `block-start{blockType:'reasoning'}` → `reasoning-delta` → `block-end{block:{type:'reasoning',text}}` |
 * | `{type:'tool_use_start',id,name}` | `block-start{blockType:'tool-call'}`（登记 id → 块下标） |
 * | `{type:'tool_use_delta',id,partialJson}` | `tool-call-delta{index,id,name,argumentsDelta}`（**JSON 增量原样转发**，由 DSH 的 `BlockAssembler` 拼成完整 arguments 字符串） |
 * | `{type:'usage',inputTokens,outputTokens}` | `usage{usage:{inputTokens,outputTokens}}` |
 * | `{type:'done',stopReason}` | 关闭所有未闭合块 → `finish{reason}` |
 *
 * 工具调用为什么不在这里拼成对象：DSH 的 `ToolCallBlock.arguments` 是**原始 JSON 字符串**
 * （`dsh-llm/lib/types/types.d.ts:84-92`），`BlockAssembler` 会把 `tool-call-delta` 的
 * `argumentsDelta` 直接字符串拼接（`assembler.js` 的 `toolCallArguments += chunk.argumentsDelta`）。
 * 这与 pi-ai 适配器的做法一致（`toolcall_delta` → `tool-call-delta`，`toolcall_end` →
 * `block-end{type:'tool-call',arguments:JSON.stringify(...)}`），所以本模块照抄这个模式，
 * 而不是自己 `JSON.parse` 出对象 —— 解析失败时原始串还能让 DSH 如实报工具参数错误。
 *
 * ## 错误映射
 *
 * `PlanClientError.code` → `LlmError.code`（映射表见 {@link PLAN_ERROR_CODE_MAP}，是唯一
 * 需要改动的地方）。上游原始 `code` / `message` / `logid` / `request_id` / HTTP status
 * **必须原样带进 `LlmError.message` 与 `failure`**：`1005 exceed quota limit` 和
 * `1309 套餐已到期` 是两件完全不同的事，吞掉上游码会让用户无法判断该续费还是重登。
 *
 * @module lib/plan-adapter
 */

import fs from 'node:fs'

import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ReasoningEffortId,
  offloadedImageText,
  textOnlyImageText,
} from '@deepseek-ai/dsh-llm'

import { CredentialError, readCredentials } from './credentials.js'
import { lastUserText } from './messages.js'
import { PluginCredentialStore } from './plan-auth.js'
import { PlanClientError, resolvePlanRoute, streamMessages } from './plan-client.js'
import { expandPlanModels, loadPlanCatalogue, parsePlanModelId } from './plan-routes.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REASONING_LEVEL,
  MODEL_MODALITIES,
  normalizeIdList,
  resolveZcodeDataRoot,
} from './zcode-runtime.js'

/**
 * @typedef {import('@deepseek-ai/dsh-llm').GenerateOptions} GenerateOptions
 * @typedef {import('@deepseek-ai/dsh-llm').StreamChunk} StreamChunk
 * @typedef {import('@deepseek-ai/dsh-llm').LlmModelInfo} LlmModelInfo
 * @typedef {import('@deepseek-ai/dsh-llm').LlmResolvedModelInfo} LlmResolvedModelInfo
 * @typedef {import('@deepseek-ai/dsh-llm').LlmProviderInfo} LlmProviderInfo
 * @typedef {import('@deepseek-ai/dsh-llm').ResolvedRetryPolicy} ResolvedRetryPolicy
 * @typedef {import('@deepseek-ai/dsh-llm').ContentBlock} ContentBlock
 * @typedef {import('@deepseek-ai/dsh-llm').ModelModality} ModelModality
 * @typedef {import('./plan-client.js').AnthropicMessagesRequest} AnthropicMessagesRequest
 * @typedef {import('./plan-client.js').PlanRoute} PlanRoute
 *
 * Anthropic Messages 请求体 + 客户端 release 里出现的 `output_config`（思考档位）。
 * `lib/plan-client.js` 的 typedef 只列了公共字段，`output_config` 是 3.16.3 的
 * `modelApiRules` 实际会发的字段，所以在这里扩展而不是改那个模块。
 *
 * @typedef {AnthropicMessagesRequest & { output_config?: { effort: string } }} PlanMessagesRequest
 * @typedef {import('./plan-client.js').PlanStreamEvent} PlanStreamEvent
 * @typedef {import('./plan-routes.js').PlanProvider} PlanProvider
 * @typedef {import('./index.js').ResolvedOptions} ResolvedOptions
 * @typedef {import('./messages.js').BridgeLogger} BridgeLogger
 * @typedef {import('./messages.js').ImageAttachmentSource} ImageAttachmentSource
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 直连通道在 DSH 里的 provider 路由键（旧通道是 `zcode-cli`）。 */
export const PLAN_PROVIDER_ID = 'zcode-plan'

/** provider 展示名，与旧通道一致（DSH 里显示为 `zcode`）。 */
export const PLAN_PROVIDER_NAME = 'zcode'

/** 本地生成会话标题的长度上限（与 `lib/app-server.js:1375` 一致）。 */
export const SESSION_TITLE_MAX_CHARS = 24

/** 本地生成会话标题的兜底文案（与旧通道一致）。 */
export const SESSION_TITLE_FALLBACK = '新会话'

/**
 * 模型能力（本模块的 `resolveModel` 直接吃它）。
 *
 * @typedef {object} PlanModelTraits
 * @property {number} contextWindow 上下文窗口（token）。
 * @property {number} maxOutputTokens 单次输出上限（token）。
 * @property {boolean} supportsImage 是否接受图片输入。
 * @property {readonly string[]} reasoningLevels 可选推理档位，由弱到强；空数组 = 不暴露档位。
 */

/**
 * 未知模型 / 规则缺失时的能力兜底。
 *
 * @type {PlanModelTraits}
 */
export const DEFAULT_MODEL_TRAITS = Object.freeze({
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxOutputTokens: DEFAULT_MAX_TOKENS,
  supportsImage: false,
  reasoningLevels: /** @type {readonly string[]} */ (Object.freeze([])),
})

/**
 * 客户端 release 读不到时的模型能力快照。
 *
 * 数值来自本机 ZCode 3.16.3 / revision 33 的 `modelConfigRules.modelRules`，按
 * {@link resolveModelTraits} 的「后匹配规则覆盖先匹配规则」语义合并后的结果：
 *
 * | model | context | maxOutput | image | reasoning |
 * |---|---|---|---|---|
 * | GLM-5.3 | 1000000 | 128000 | false | low / high / max |
 * | GLM-5.3-Flash | 1000000 | 128000 | true | low / high / max |
 * | GLM-5.2 | 1000000 | 128000 | false | disabled / high / max |
 * | GLM-5-Turbo | 200000 | 64000 | false | disabled / enabled |
 *
 * @type {readonly (readonly [string, PlanModelTraits])[]}
 */
const FALLBACK_TRAIT_ENTRIES = [
  ['GLM-5.3', { contextWindow: 1000000, maxOutputTokens: 128000, supportsImage: false, reasoningLevels: ['low', 'high', 'max'] }],
  ['GLM-5.3-Flash', { contextWindow: 1000000, maxOutputTokens: 128000, supportsImage: true, reasoningLevels: ['low', 'high', 'max'] }],
  ['GLM-5.2', { contextWindow: 1000000, maxOutputTokens: 128000, supportsImage: false, reasoningLevels: ['disabled', 'high', 'max'] }],
  ['GLM-5-Turbo', { contextWindow: 200000, maxOutputTokens: 64000, supportsImage: false, reasoningLevels: ['disabled', 'enabled'] }],
]

/** @type {ReadonlyMap<string, PlanModelTraits>} */
export const FALLBACK_MODEL_TRAITS = new Map(FALLBACK_TRAIT_ENTRIES)

/**
 * `PlanClientError.code` → DSH `LlmError.code`。
 *
 * **这是唯一需要改映射的地方**：如果哪天要把「套餐额度用尽」从可重试的 `RATE_LIMIT`
 * 改成不可重试的 `QUOTA`（dsh-llm 的规范码，不在默认重试集合里），只改这里一行即可。
 *
 * @type {Record<string, string>}
 */
export const PLAN_ERROR_CODE_MAP = {
  QUOTA: 'RATE_LIMIT',
  CONCURRENCY: 'RATE_LIMIT',
  AUTH: 'AUTH',
  PARAM: 'INVALID_REQUEST',
  UPSTREAM: 'UPSTREAM',
  TRANSPORT: 'TRANSPORT',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  TOKEN_MISSING: 'AUTH',
  API_KEY_MISSING: 'AUTH',
  CARD_ID_MISSING: 'AUTH',
  UNKNOWN_PROVIDER: 'PROVIDER',
  BAD_RESPONSE: 'UPSTREAM',
}

/** 面向用户的中文提示（每条都写清「该做什么」，不只是「失败了」）。 */
const PLAN_ERROR_HINTS = {
  QUOTA: '套餐额度已用尽或未订阅（ZCode 套餐 / Start Plan 额度不足，请到套餐页面续费或切换路由）',
  CONCURRENCY: '上游并发/限流受限，稍后重试通常可恢复',
  AUTH: 'ZCode 账号鉴权失败（凭证过期或缺失，请在 ZCode 客户端重新登录）',
  PARAM: '上游认为请求参数不合法（模型 id / 图片输入 / 思考档位可能不被该路由接受）',
  UPSTREAM: '计划端点返回错误',
  TRANSPORT: '计划端点网络不可达',
  TIMEOUT: '计划端点请求超时',
  ABORTED: '请求已被取消',
  TOKEN_MISSING: '共享凭证里没有 zcodejwttoken（ZCode 客户端未登录 Z.AI？）',
  API_KEY_MISSING: '共享凭证里没有该套餐的 coding-plan API Key（客户端未登录对应账号？）',
  CARD_ID_MISSING: '高速通道需要卡号（cardId），当前没有可用卡号',
  UNKNOWN_PROVIDER: '无法识别的计划路由 providerId',
  BAD_RESPONSE: '计划端点返回了无法解析的响应',
}

/**
 * 一档思考档位映射出的请求字段。
 *
 * @typedef {object} PlanThinkingFields
 * @property {{ type: string }} [thinking] Anthropic 的 `thinking` 字段。
 * @property {{ effort: string }} [output_config] Anthropic 的 `output_config` 字段。
 */

/**
 * 模型清单里的一条（= 一条路由 × 一个模型）。
 *
 * @typedef {object} PlanModelEntry
 * @property {string} id DSH 模型 id（`<providerId>#<modelId>`）。
 * @property {string} providerId 计划路由 id。
 * @property {string} modelId 上游模型 id。
 * @property {string} providerName 路由展示名。
 * @property {string} planKind 套餐种类。
 * @property {string} baseUrl 上游 baseUrl。
 * @property {string} authKind 鉴权形态。
 */

/**
 * 归一后的模型清单来源。
 *
 * @typedef {object} PlanCatalogue
 * @property {PlanProvider[]} providers 路由表。
 * @property {'builtin-release' | 'fallback' | 'injected'} source 来源。
 * @property {string} [releasePath] 读到的 release 路径。
 * @property {string} [reason] 降级原因。
 */

/**
 * 模型能力来源。
 *
 * @typedef {object} PlanModelTraitSource
 * @property {readonly any[]} rules `modelConfigRules.modelRules`（release 里没有时为空）。
 * @property {'builtin-release' | 'fallback'} source 来源。
 * @property {string} [releasePath] 读到的 release 路径。
 * @property {string} [reason] 降级原因。
 */

/**
 * 适配器依赖：全部可注入，单测零网络、零磁盘。
 *
 * @typedef {object} PlanAdapterDeps
 * @property {() => ResolvedOptions} options 解析后的插件配置（热更新后重新读取）。
 * @property {BridgeLogger | undefined} [logger] 结构化日志。
 * @property {() => ImageAttachmentSource | undefined} [resolveAttachments] 图片附件服务。
 * @property {(dataBaseDir: string) => Record<string, string | null>} [readCredentials] 凭证读取（测试注入）。
 * @property {() => Record<string, string>} [readPlanCredentials] 插件自有凭证读取（测试注入；
 *   不注入时按 `options().planCredentialStore` 读磁盘）。
 * @property {typeof fetch} [fetchImpl] fetch 注入（测试用）。
 * @property {() => PlanProvider[]} [providers] 路由表注入（测试用；给了就不读磁盘）。
 */

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value 候选字段。
 * @returns {string} 去空白后的字符串；非字符串一律 ''。
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * @param {unknown} value 候选字段。
 * @returns {number | undefined} 有限正数；否则 undefined。
 */
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * @param {unknown} value 候选字段。
 * @returns {number | undefined} 有限数字（取整）；否则 undefined。
 */
function int(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

/**
 * 归一一个内容块数组（`content` 允许是裸字符串，DSH 的手搓请求会这么传）。
 *
 * @param {unknown} content 消息内容。
 * @returns {any[]} 内容块数组。
 */
function blocksOf(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

/**
 * 把一条消息里的文本块拼起来（`reasoning` 不算可见文本）。
 *
 * @param {readonly any[]} blocks 内容块。
 * @returns {string} 拼接后的文本。
 */
function flattenText(blocks) {
  /** @type {string[]} */
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('')
}

/**
 * 把 `ToolCallBlock.arguments`（原始 JSON 字符串）转成 Anthropic 的 `input` 对象。
 *
 * @param {unknown} rawArguments 原始 JSON 字符串。
 * @param {BridgeLogger | undefined} [logger] 日志。
 * @returns {Record<string, unknown>} 解析出的对象；空串 / 非法 JSON 一律 `{}`。
 */
function toolInputOf(rawArguments, logger) {
  const raw = typeof rawArguments === 'string' ? rawArguments.trim() : ''
  if (raw === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    logger?.warn?.('zcode-plan: a historical tool-call block carries invalid JSON arguments; sending {} instead')
    return {}
  }
}

// ---------------------------------------------------------------------------
// 模型能力：从 builtin release 的 modelRules 推导
// ---------------------------------------------------------------------------

/**
 * 一条 `modelConfigRules.modelRules` 规则的匹配结果：后匹配的规则覆盖先匹配的。
 *
 * 为什么是「后匹配覆盖」：release 里的规则是**由宽到窄**排列的（`.*` → `.*glm-5.*` →
 * `.*glm-5\.3.*` → `.*glm-5\.3-flash.*`），窄规则只写它与宽规则不同的字段
 * （例如 flash 规则只写 `supportsImage: true`）。按顺序逐字段合并，正好得到客户端自己的
 * 结论：`GLM-5.3-Flash` = 1M 上下文 + 128K 输出 + 支持图片。
 *
 * 匹配大小写不敏感：release 里同时存在 `.*glm-5.*` 与 `.*GLM-5\.2.*` 两种写法，
 * 只有忽略大小写才能同时命中 `GLM-5.3` 与 `glm-5.2`。
 *
 * @param {string} modelId 上游模型 id。
 * @param {readonly any[]} rules `modelRules`。
 * @returns {{ traits: PlanModelTraits, matched: boolean }} 合并后的能力与是否命中过规则。
 */
export function resolveModelTraits(modelId, rules) {
  const wanted = text(modelId)
  /** @type {number | undefined} */
  let contextWindow
  /** @type {number | undefined} */
  let maxOutputTokens
  /** @type {boolean | undefined} */
  let supportsImage
  /** @type {string[] | undefined} */
  let reasoningLevels
  let matched = false
  if (wanted === '' || !Array.isArray(rules)) {
    return { traits: DEFAULT_MODEL_TRAITS, matched: false }
  }
  for (const rule of rules) {
    if (rule === null || typeof rule !== 'object') continue
    const pattern = text(rule.modelMatch)
    if (pattern === '') continue
    /** @type {RegExp} */
    let regex
    try {
      regex = new RegExp(pattern, 'i')
    } catch {
      continue // 客户端 release 里出现正则不合法时跳过这条，不影响其它模型
    }
    if (!regex.test(wanted)) continue
    matched = true
    const config = rule.config !== null && typeof rule.config === 'object' ? rule.config : {}
    const properties = config.properties !== null && typeof config.properties === 'object' ? config.properties : {}
    const specs = config.optionSpecs !== null && typeof config.optionSpecs === 'object' ? config.optionSpecs : {}
    const context = positive(properties.contextWindow)
    if (context !== undefined) contextWindow = context
    const inputFormat = properties.inputFormat
    if (inputFormat !== null && typeof inputFormat === 'object' && typeof inputFormat.supportsImage === 'boolean') {
      supportsImage = inputFormat.supportsImage
    }
    const maxOut = specs.maxOutputTokens !== null && typeof specs.maxOutputTokens === 'object'
      ? positive(specs.maxOutputTokens.max)
      : undefined
    if (maxOut !== undefined) maxOutputTokens = maxOut
    const levels = specs.reasoningLevel !== null && typeof specs.reasoningLevel === 'object'
      ? specs.reasoningLevel.values
      : undefined
    if (Array.isArray(levels)) {
      /** @type {string[]} */
      const cleaned = []
      for (const level of levels) {
        const value = text(level)
        if (value !== '' && !cleaned.includes(value)) cleaned.push(value)
      }
      if (cleaned.length !== 0) reasoningLevels = cleaned
    }
  }
  if (!matched) return { traits: DEFAULT_MODEL_TRAITS, matched: false }
  return {
    traits: {
      contextWindow: contextWindow ?? DEFAULT_MODEL_TRAITS.contextWindow,
      maxOutputTokens: maxOutputTokens ?? DEFAULT_MODEL_TRAITS.maxOutputTokens,
      supportsImage: supportsImage ?? DEFAULT_MODEL_TRAITS.supportsImage,
      reasoningLevels: reasoningLevels ?? DEFAULT_MODEL_TRAITS.reasoningLevels,
    },
    matched: true,
  }
}

/**
 * 从已解析的 builtin release 里取出 `modelRules`。
 *
 * @param {unknown} release 已解析的 `zcode-builtin.json`。
 * @returns {any[]} 规则数组；形状不对时 []。
 */
export function normalizeModelRules(release) {
  if (release === null || typeof release !== 'object') return []
  const rules = /** @type {any} */ (release)?.config?.modelConfigRules?.modelRules
  return Array.isArray(rules) ? rules : []
}

/**
 * 读取模型能力来源：优先客户端 release，读不到降级到 {@link FALLBACK_MODEL_TRAITS}。
 *
 * 永不抛异常（与 `loadPlanCatalogue` 同一条纪律：客户端没装也必须能起服务）。
 *
 * @param {object} [options] 参数。
 * @param {string} [options.dataBaseDir] ZCode 数据根。
 * @param {string} [options.cliPath] 显式 CLI 路径。
 * @param {string} [options.releasePath] 已知的 release 路径（适配器已经找到过时直接复用，
 *   免得为了模型能力再把同一棵树遍历一遍）。
 * @param {typeof fs.readFileSync} [options.readFile] 文件读取注入（测试用）。
 * @returns {PlanModelTraitSource} 能力来源。
 */
export function loadModelTraits(options = {}) {
  const readFile = options.readFile ?? fs.readFileSync
  /** @type {string | undefined} */
  let releasePath = (options.releasePath ?? '').trim() || undefined
  /** @type {string | undefined} */
  let missingReason
  if (releasePath === undefined) {
    const catalogue = loadPlanCatalogue({
      dataBaseDir: (options.dataBaseDir ?? '').trim(),
      cliPath: (options.cliPath ?? '').trim(),
    })
    if (catalogue.source !== 'builtin-release' || catalogue.releasePath === undefined) {
      missingReason = catalogue.reason ?? 'no builtin release found on disk'
    } else {
      releasePath = catalogue.releasePath
    }
  }
  if (releasePath === undefined) {
    return { rules: [], source: 'fallback', reason: missingReason ?? 'no builtin release found on disk' }
  }
  /** @type {unknown} */
  let release
  try {
    release = JSON.parse(String(readFile(releasePath, 'utf8')))
  } catch (/** @type {any} */ error) {
    return {
      rules: [],
      source: 'fallback',
      releasePath,
      reason: `cannot parse ${releasePath}: ${error?.message ?? error}`,
    }
  }
  const rules = normalizeModelRules(release)
  if (rules.length === 0) {
    return {
      rules: [],
      source: 'fallback',
      releasePath,
      reason: `${releasePath} declares no model rules`,
    }
  }
  return { rules, source: 'builtin-release', releasePath }
}

/**
 * 解析一个模型的能力：release 规则命中就用规则，没命中就退回静态快照。
 *
 * @param {string} modelId 上游模型 id。
 * @param {PlanModelTraitSource} source {@link loadModelTraits} 的结果。
 * @returns {PlanModelTraits} 模型能力。
 */
export function traitsForModel(modelId, source) {
  const resolved = resolveModelTraits(modelId, source.rules)
  if (resolved.matched) return resolved.traits
  return FALLBACK_MODEL_TRAITS.get(modelId) ?? DEFAULT_MODEL_TRAITS
}

/**
 * 推理档位 → DSH 的默认档位。
 *
 * 客户端自己没在 release 里写默认档，这里按「优先 `max`，否则取最强档」推导：
 * `low/high/max` → `max`；`disabled/high/max` → `max`；`disabled/enabled` → `enabled`。
 *
 * @param {readonly string[]} levels 档位（由弱到强）。
 * @returns {string | undefined} 默认档位；没有档位时 undefined。
 */
export function defaultReasoningLevelOf(levels) {
  if (levels.length === 0) return undefined
  if (levels.includes(DEFAULT_REASONING_LEVEL)) return DEFAULT_REASONING_LEVEL
  return levels[levels.length - 1]
}

// ---------------------------------------------------------------------------
// 模型清单
// ---------------------------------------------------------------------------

/**
 * 把路由表展开成 DSH 模型清单（id 规则见模块文档）。
 *
 * @param {readonly PlanProvider[]} providers 路由表（已按套餐优先级排序）。
 * @returns {PlanModelEntry[]} 一条路由 × 一个模型，保持路由顺序与模型声明顺序。
 */
export function buildPlanModels(providers) {
  return expandPlanModels(providers).map((entry) => ({
    id: entry.id,
    providerId: entry.providerId,
    modelId: entry.modelId,
    providerName: entry.providerName,
    planKind: entry.planKind,
    baseUrl: entry.baseUrl,
    authKind: entry.authKind,
  }))
}

/**
 * 对模型清单应用 `enabledModelIds` / `disabledModelIds`。
 *
 * 语义与 `lib/zcode-runtime.js` 的 `selectEnabledModels` 完全一致：
 * 空 allow list = 全开；allow list 非空 = 只留其中；block list 永远最后生效。
 *
 * 唯一放宽的是 **id 写法**：除了规范的 `<providerId>#<modelId>`，还接受裸 `modelId` 与
 * `<providerId>/<modelId>`（`parsePlanModelId` 本来就兼容这三种写法，配置里手写哪一种
 * 都不该静默失效）。裸 `modelId` 会命中所有声明了它的路由 —— 用户写 `GLM-5.3-Flash`
 * 时的意图是「这个模型别藏起来」，而不是「只留第一条路由」。
 *
 * @param {readonly PlanModelEntry[]} entries 模型清单。
 * @param {readonly string[] | undefined} [enabledModelIds] 允许列表（空 = 全开）。
 * @param {readonly string[] | undefined} [disabledModelIds] 停用列表（最后生效）。
 * @returns {{ models: PlanModelEntry[], unknownEnabledIds: string[], unknownDisabledIds: string[] }}
 *   过滤结果 + 未命中任何模型的配置项（供日志告警）。
 */
export function selectPlanModels(entries, enabledModelIds = [], disabledModelIds = []) {
  const enabled = normalizeIdList(enabledModelIds)
  const disabled = normalizeIdList(disabledModelIds)
  /**
   * @param {PlanModelEntry} entry 模型。
   * @param {string} id 配置里的 id。
   * @returns {boolean} 是否命中。
   */
  const matches = (entry, id) => id === entry.id || id === entry.modelId || id === `${entry.providerId}/${entry.modelId}`
  /**
   * @param {string} id 配置里的 id。
   * @returns {boolean} 是否命中任意模型。
   */
  const known = (id) => entries.some((entry) => matches(entry, id))
  const unknownEnabledIds = enabled.filter((id) => !known(id))
  const unknownDisabledIds = disabled.filter((id) => !known(id))
  const allowed = enabled.length === 0 ? [...entries] : entries.filter((entry) => enabled.some((id) => matches(entry, id)))
  const models = disabled.length === 0 ? allowed : allowed.filter((entry) => !disabled.some((id) => matches(entry, id)))
  return { models, unknownEnabledIds, unknownDisabledIds }
}

// ---------------------------------------------------------------------------
// DSH 请求 → Anthropic Messages 请求
// ---------------------------------------------------------------------------

/**
 * 推理档位 → Anthropic 的 `thinking` / `output_config`。
 *
 * 映射照抄客户端自己的 `modelApiRules`（release 3.16.3）：
 *
 * ```
 * glm-5.3      : {"thinking":{"type":"enabled"},"output_config":{"effort":<level>}}
 * GLM-5.2      : level == "disabled" ? {"thinking":{"type":"disabled"}}
 *                                    : {"thinking":{"type":"enabled"},"output_config":{"effort":<level>}}
 * GLM-5-Turbo  : {"thinking":{"type":"enabled"|"disabled"}}
 * ```
 *
 * 合并成一条规则：`disabled` / `none` → 关；`enabled` → 只开；其它已声明档位 → 开 + effort。
 * 未在档位表里声明、也不是 disabled/enabled 的档位一律忽略（不猜上游认不认）。
 *
 * @param {unknown} effort DSH 的 `reasoningEffort`（品牌化字符串，运行时就是 string）。
 * @param {readonly string[]} levels 该模型的档位表。
 * @returns {PlanThinkingFields} 要合并进请求体的字段。
 */
export function thinkingFieldsFor(effort, levels) {
  const level = text(effort)
  if (level === '') return {}
  const declared = levels.includes(level)
  const isOff = level === 'disabled' || level === 'none'
  const isOn = level === 'enabled'
  if (!declared && !isOff && !isOn) return {}
  if (isOff) return { thinking: { type: 'disabled' } }
  if (isOn) return { thinking: { type: 'enabled' } }
  return { thinking: { type: 'enabled' }, output_config: { effort: level } }
}

/**
 * 把一个内容块投影成 Anthropic 的 content block。
 *
 * 图片：模型支持图片时按 base64 原生发送（计划端点就是 Anthropic 兼容层）；
 * 不支持时退化成 `textOnlyImageText` 占位文本（与 dsh-llm 给文本模型的标准占位一致）。
 * `offloaded` 的图片用 `offloadedImageText`，绝不偷偷把字节再塞回去。
 *
 * @param {any} block DSH 内容块。
 * @param {object} context 上下文。
 * @param {PlanModelTraits} context.traits 模型能力。
 * @param {((ref: any) => Promise<{ mediaType: string, dataBase64: string } | undefined>) | undefined} context.imageLoader 图片读取器。
 * @returns {Promise<Record<string, unknown> | undefined>} Anthropic content block；应丢弃时 undefined。
 */
async function projectBlock(block, { traits, imageLoader }) {
  if (block === null || typeof block !== 'object') return undefined
  switch (block.type) {
    case 'text': {
      const value = typeof block.text === 'string' ? block.text : ''
      return value === '' ? undefined : { type: 'text', text: value }
    }
    case 'reasoning':
      // Anthropic 只接受带 signature 的 thinking 回放；我们没有签名，直接丢弃。
      return undefined
    case 'image': {
      const ref = block.attachment
      if (traits.supportsImage !== true) return { type: 'text', text: textOnlyImageText(ref) }
      if (block.offloaded === true) return { type: 'text', text: offloadedImageText(ref) }
      const image = imageLoader === undefined ? undefined : await imageLoader(ref)
      if (image === undefined) return { type: 'text', text: textOnlyImageText(ref) }
      return {
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.dataBase64 },
      }
    }
    case 'file': {
      const name = text(block.attachment?.name)
      return { type: 'text', text: `[file ${name === '' ? '(unnamed)' : name} is not representable on this route]` }
    }
    default:
      // tool-addition / tool-removal 属于声明变更，已由 options.tools 表达；未知块一律丢弃。
      return undefined
  }
}

/**
 * 一条 assistant 消息的内容块 → Anthropic 的 assistant content。
 *
 * @param {readonly any[]} blocks DSH 内容块。
 * @returns {any[]} Anthropic content blocks。
 */
function projectAssistantBlocks(blocks) {
  /** @type {any[]} */
  const out = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      out.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool-call') {
      const id = text(block.id)
      if (id === '') continue
      out.push({ type: 'tool_use', id, name: text(block.name), input: toolInputOf(block.arguments, undefined) })
    }
  }
  return out
}

/**
 * 把 DSH 的 `GenerateOptions` 翻译成 Anthropic Messages 请求体。
 *
 * 关键约定（都与 DSH 的请求装配语义对齐）：
 * - `options.system` 与**历史里所有** system / developer 消息的文本合并进顶层 `system`
 *   （Anthropic 只有顶层 system；`developer` 的 tool-addition/removal 已由 `options.tools`
 *   完整声明表达，因此忽略，并把本适配器的 `toolUpdate` 留空 = 「每次声明完整工具列表」）；
 * - 相邻同角色消息合并（Anthropic 要求 user/assistant 交替；tool 结果属于 user 侧）；
 * - 空文本块丢弃（Anthropic 会以 400 拒绝空 text block）；
 * - 开启 thinking 时**不带** `temperature` / `top_p`（Anthropic 要求 thinking 开启时
 *   采样参数保持默认，否则直接报错）。
 *
 * @param {GenerateOptions} options DSH 组装好的请求。
 * @param {object} context 上下文。
 * @param {string} context.modelId 上游模型 id。
 * @param {PlanModelTraits} context.traits 模型能力。
 * @param {number} context.defaultMaxTokens 未指定 `maxTokens` 时的输出上限。
 * @param {((ref: any) => Promise<{ mediaType: string, dataBase64: string } | undefined>) | undefined} [context.imageLoader] 图片读取器。
 * @param {BridgeLogger} [context.logger] 日志。
 * @returns {Promise<PlanMessagesRequest>} Anthropic Messages 请求体（未含 `stream`，由 plan-client 强制加）。
 */
export async function toAnthropicRequest(options, context) {
  const { modelId, traits, defaultMaxTokens, imageLoader, logger } = context
  /** @type {string[]} */
  const systemParts = []
  const requestSystem = text(options.system)
  if (requestSystem !== '') systemParts.push(requestSystem)

  /** @type {{ role: 'user' | 'assistant', content: any[] }[]} */
  const messages = []
  /**
   * @param {'user' | 'assistant'} role 角色。
   * @param {any[]} content 内容块。
   * @returns {void}
   */
  const pushMessage = (role, content) => {
    if (content.length === 0) return
    const last = messages[messages.length - 1]
    if (last !== undefined && last.role === role) {
      last.content.push(...content)
      return
    }
    messages.push({ role, content })
  }

  for (const message of options.messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    const blocks = blocksOf(message.content)
    if (message.role === 'system' || message.role === 'developer') {
      const value = flattenText(blocks)
      if (value !== '') systemParts.push(value)
      continue
    }
    if (message.role === 'user') {
      /** @type {any[]} */
      const content = []
      for (const block of blocks) {
        const projected = await projectBlock(block, { traits, imageLoader })
        if (projected !== undefined) content.push(projected)
      }
      pushMessage('user', content)
      continue
    }
    if (message.role === 'assistant') {
      pushMessage('assistant', projectAssistantBlocks(blocks))
      continue
    }
    if (message.role === 'tool') {
      // 工具结果在 Anthropic 里是 user 消息里的 tool_result 块。
      const callId = text(message.toolCallId)
      if (callId === '') continue
      /** @type {any[]} */
      const content = []
      for (const block of blocks) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          content.push({ type: 'text', text: block.text })
        }
      }
      if (content.length === 0) content.push({ type: 'text', text: '(no output)' })
      pushMessage('user', [{
        type: 'tool_result',
        tool_use_id: callId,
        content,
        ...(message.isError === true ? { is_error: true } : {}),
      }])
      continue
    }
    // 未知角色：不猜，丢弃。
  }

  // Anthropic 要求第一条是 user；历史被截断后可能只剩 assistant，补一条中性 user。
  if (messages.length !== 0 && messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: [{ type: 'text', text: '（继续）' }] })
  }
  if (messages.length === 0) {
    messages.push({ role: 'user', content: [{ type: 'text', text: '（继续）' }] })
  }

  const effort = text(options.reasoningEffort)
  const thinking = thinkingFieldsFor(effort, traits.reasoningLevels)
  const thinkingEnabled = thinking.thinking !== undefined && thinking.thinking.type !== 'disabled'

  /** @type {PlanMessagesRequest} */
  const request = {
    model: modelId,
    max_tokens: positive(options.maxTokens) ?? defaultMaxTokens,
    messages,
  }
  const system = systemParts.join('\n\n')
  if (system !== '') request.system = system

  /** @type {any[]} */
  const tools = []
  for (const tool of options.tools ?? []) {
    if (tool === null || typeof tool !== 'object') continue
    const name = text(tool.name)
    if (name === '') continue
    tools.push({
      name,
      description: typeof tool.description === 'string' ? tool.description : '',
      input_schema: tool.parameters !== null && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
    })
  }
  if (tools.length !== 0) request.tools = tools

  if (thinking.thinking !== undefined) request.thinking = thinking.thinking
  if (thinking.output_config !== undefined) request.output_config = thinking.output_config
  if (!thinkingEnabled) {
    const temperature = typeof options.temperature === 'number' && Number.isFinite(options.temperature)
      ? options.temperature
      : undefined
    if (temperature !== undefined) request.temperature = temperature
  } else if (typeof options.temperature === 'number') {
    logger?.debug?.('zcode-plan: temperature dropped because thinking is enabled')
  }
  if (Array.isArray(options.stop) && options.stop.length !== 0) {
    request.stop_sequences = options.stop.filter((value) => typeof value === 'string' && value !== '')
  }
  return request
}

// ---------------------------------------------------------------------------
// plan-client 事件 → DSH StreamChunk
// ---------------------------------------------------------------------------

/**
 * 把 plan-client 的统一事件翻译成 DSH 的 `StreamChunk` 序列。
 *
 * 状态机职责：
 * - plan-client 对 text / reasoning 只发增量（不发块开始/结束），所以这里**按增量类型
 *   合成** `block-start` / `block-end`：类型切换或结束时闭合当前块；
 * - 工具调用按 `id` 登记块下标，`input_json_delta` 原样作为 `argumentsDelta` 转发
 *   （拼装由 DSH 的 `BlockAssembler` 负责）；
 * - `done` 时闭合所有未闭合块，并产出 `finish`。
 *
 * @example
 * const mapper = new PlanStreamMapper()
 * for (const chunk of mapper.push({ type: 'text', delta: 'hi' })) yield chunk
 */
export class PlanStreamMapper {
  constructor() {
    /** 下一个可用的 DSH 块下标。 @type {number} */
    this.nextIndex = 0
    /** 当前打开的 text / reasoning 块。 @type {{ kind: 'text' | 'reasoning', index: number, text: string } | null} */
    this.current = null
    /** id → 工具块状态。 @type {Map<string, { index: number, name: string, json: string, closed: boolean }>} */
    this.tools = new Map()
    /** 工具块 id 的创建顺序。 @type {string[]} */
    this.toolOrder = []
    /** 是否产出过任何内容块。 @type {boolean} */
    this.sawContent = false
    /** 是否已产出 finish。 @type {boolean} */
    this.finished = false
    /** 是否收到过 usage。 @type {boolean} */
    this.sawUsage = false
  }

  /**
   * 闭合当前 text / reasoning 块。
   *
   * @returns {StreamChunk[]} `block-end` chunk（没有打开块时为空）。
   */
  closeCurrent() {
    const current = this.current
    if (current === null) return []
    this.current = null
    return [{
      type: 'block-end',
      index: current.index,
      block: { type: current.kind, text: current.text },
    }]
  }

  /**
   * 打开一个 text / reasoning 块（同类型已打开时复用）。
   *
   * @param {'text' | 'reasoning'} kind 块类型。
   * @returns {{ chunks: StreamChunk[], index: number }} 需要先产出的 chunk 与块下标。
   */
  openTextBlock(kind) {
    const current = this.current
    if (current !== null && current.kind === kind) return { chunks: [], index: current.index }
    const closed = this.closeCurrent()
    const index = this.nextIndex
    this.nextIndex += 1
    this.current = { kind, index, text: '' }
    this.sawContent = true
    return {
      chunks: [...closed, { type: 'block-start', index, blockType: kind }],
      index,
    }
  }

  /**
   * 按 id 找工具块；id 缺失/未知时退回最后一个未闭合的工具块。
   *
   * @param {string} id 工具调用 id。
   * @returns {{ id: string, state: { index: number, name: string, json: string, closed: boolean } } | undefined} 命中的工具块。
   */
  findTool(id) {
    const wanted = text(id)
    if (wanted !== '') {
      const state = this.tools.get(wanted)
      if (state !== undefined) return { id: wanted, state }
    }
    for (let position = this.toolOrder.length - 1; position >= 0; position -= 1) {
      const candidate = this.toolOrder[position]
      const state = this.tools.get(candidate)
      if (state !== undefined && !state.closed) return { id: candidate, state }
    }
    return undefined
  }

  /**
   * 吃一个 plan-client 事件。
   *
   * @param {PlanStreamEvent} event 统一事件。
   * @returns {StreamChunk[]} 需要向下游产出的 chunk。
   */
  push(event) {
    /** @type {StreamChunk[]} */
    const out = []
    if (this.finished) return out
    switch (event.type) {
      case 'text': {
        const opened = this.openTextBlock('text')
        out.push(...opened.chunks)
        const current = this.current
        if (current !== null && event.delta !== '') {
          current.text += event.delta
          out.push({ type: 'text-delta', index: opened.index, text: event.delta })
        }
        break
      }
      case 'reasoning': {
        const opened = this.openTextBlock('reasoning')
        out.push(...opened.chunks)
        const current = this.current
        if (current !== null && event.delta !== '') {
          current.text += event.delta
          out.push({ type: 'reasoning-delta', index: opened.index, text: event.delta })
        }
        break
      }
      case 'tool_use_start': {
        out.push(...this.closeCurrent())
        const id = text(event.id)
        const index = this.nextIndex
        this.nextIndex += 1
        const name = text(event.name)
        this.tools.set(id === '' ? `tool-${index}` : id, { index, name, json: '', closed: false })
        this.toolOrder.push(id === '' ? `tool-${index}` : id)
        this.sawContent = true
        out.push({ type: 'block-start', index, blockType: 'tool-call' })
        break
      }
      case 'tool_use_delta': {
        const found = this.findTool(event.id)
        if (found === undefined) break
        const { id, state } = found
        if (state.closed) break
        if (event.partialJson !== '') {
          state.json += event.partialJson
          out.push({
            type: 'tool-call-delta',
            index: state.index,
            id: /** @type {import('@deepseek-ai/dsh-llm').ToolCallId} */ (/** @type {unknown} */ (id)),
            ...(state.name === '' ? {} : { name: state.name }),
            argumentsDelta: event.partialJson,
          })
        }
        break
      }
      case 'usage': {
        this.sawUsage = true
        out.push({
          type: 'usage',
          usage: {
            inputTokens: int(event.inputTokens) ?? 0,
            outputTokens: int(event.outputTokens) ?? 0,
          },
        })
        break
      }
      case 'done': {
        out.push(...this.closeCurrent())
        for (const id of this.toolOrder) {
          const state = this.tools.get(id)
          if (state === undefined || state.closed) continue
          state.closed = true
          out.push({
            type: 'block-end',
            index: state.index,
            block: {
              type: 'tool-call',
              id: /** @type {import('@deepseek-ai/dsh-llm').ToolCallId} */ (/** @type {unknown} */ (id)),
              name: state.name,
              arguments: state.json.trim() === '' ? '{}' : state.json,
            },
          })
        }
        this.finished = true
        out.push({ type: 'finish', reason: finishReasonFor(event.stopReason, this.toolOrder.length !== 0) })
        break
      }
      default:
        break
    }
    return out
  }
}

/**
 * 上游 `stop_reason` → DSH `FinishReason`。
 *
 * `end_turn` / `stop_sequence` / `null` 都算正常结束；只要本轮产出过工具调用，正常结束
 * 也要报成 `tool-calls`，否则 DSH 不会执行这些调用。`max_tokens` 优先保留（DSH 会在
 * 截断时丢掉不可执行的工具调用）。
 *
 * @param {unknown} stopReason 上游 stop_reason。
 * @param {boolean} hadToolCalls 本轮是否产出过工具调用。
 * @returns {import('@deepseek-ai/dsh-llm').FinishReason} DSH 的结束原因。
 */
export function finishReasonFor(stopReason, hadToolCalls) {
  const reason = text(stopReason)
  if (reason === 'max_tokens') return { kind: 'max-tokens' }
  if (reason === 'tool_use') return { kind: 'tool-calls' }
  if (hadToolCalls) return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

// ---------------------------------------------------------------------------
// 错误映射
// ---------------------------------------------------------------------------

/**
 * 把 plan-client / 凭证层的错误翻译成 `LlmError`。
 *
 * 上游原始信息一个都不吞：`message` 里带 `code` / `logid` / `request_id` / HTTP status，
 * `failure.status` 与 `failure.requestId` 也填上（重试策略和诊断面都读它们）。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {LlmError} DSH 侧的错误。
 */
export function toLlmError(error) {
  if (error instanceof LlmError) return error

  if (error instanceof CredentialError) {
    const code = 'AUTH'
    const detail = typeof error.code === 'string' ? `（凭证错误 ${error.code}）` : ''
    return new LlmError(`${PLAN_ERROR_HINTS.AUTH}${detail}：${error.message}`, code, { cause: error })
  }

  if (error instanceof PlanClientError) {
    const planCode = typeof error.code === 'string' ? error.code : 'UPSTREAM'
    const mapped = PLAN_ERROR_CODE_MAP[planCode] ?? 'UPSTREAM'
    const hint = PLAN_ERROR_HINTS[/** @type {keyof typeof PLAN_ERROR_HINTS} */ (planCode)] ?? PLAN_ERROR_HINTS.UPSTREAM
    const detail = error.detail
    /** @type {string[]} */
    const facts = []
    if (detail?.code !== undefined) facts.push(`code=${String(detail.code)}`)
    if (detail?.message !== undefined && detail.message !== '') facts.push(`message=${detail.message}`)
    if (detail?.logid !== undefined) facts.push(`logid=${detail.logid}`)
    if (detail?.requestId !== undefined) facts.push(`request_id=${detail.requestId}`)
    if (detail?.status !== undefined && detail.status !== 0) facts.push(`http=${detail.status}`)
    const suffix = facts.length === 0 ? '' : `（上游 ${facts.join(', ')}）`
    /** @type {import('@deepseek-ai/dsh-llm').LlmErrorOptions} */
    const options = { cause: error }
    if (detail?.status !== undefined && detail.status !== 0) options.status = detail.status
    if (detail?.requestId !== undefined) options.requestId = ProviderRequestId(detail.requestId)
    if (detail?.retryable === true) {
      // 上游只说「可重试」，没给具体秒数；把本地退避的下限交给重试策略即可。
      options.providerRetryAfterMs = 1000
    }
    return new LlmError(`${hint}${suffix}：${error.message}`, mapped, options)
  }

  const message = error instanceof Error ? error.message : String(error)
  return new LlmError(`计划通道失败：${message}`, 'TRANSPORT', {
    cause: error instanceof Error ? error : undefined,
  })
}

// ---------------------------------------------------------------------------
// 会话标题（本地生成，不消耗额度）
// ---------------------------------------------------------------------------

/**
 * 本地生成会话标题：取最后一条用户消息的前若干字符。
 *
 * 与旧通道（`lib/app-server.js:1374-1382`）完全一致的做法 —— 标题是一次辅助调用，
 * 走网络就为了 24 个字符不值当，而且会在用户还没开始对话时就消耗额度。
 *
 * @param {GenerateOptions} options DSH 请求。
 * @returns {string} 标题。
 */
export function localSessionTitle(options) {
  const source = lastUserText(options.messages, undefined) || SESSION_TITLE_FALLBACK
  return source.replace(/\s+/gu, ' ').trim().slice(0, SESSION_TITLE_MAX_CHARS) || SESSION_TITLE_FALLBACK
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

/**
 * 计划额度直连通道的 `LlmAdapter`。
 *
 * 与 `ZcodeAppServerAdapter`（旧通道）的差别只有一处：`stream()` 里没有子进程、没有会话
 * 生命周期、没有 stdio JSON-RPC —— 每个请求都是「凭证 → 路由 → HTTP → 事件映射」。
 */
export class ZcodePlanAdapter extends LlmAdapter {
  /** @type {() => ResolvedOptions} */
  options
  /** @type {BridgeLogger | undefined} */
  logger
  /** @type {(() => ImageAttachmentSource | undefined) | undefined} */
  resolveAttachments
  /** @type {((dataBaseDir: string) => Record<string, string | null>) | undefined} */
  credentialsReader
  /** @type {(() => Record<string, string>) | undefined} */
  planCredentialReader
  /** @type {typeof fetch | undefined} */
  fetchImpl
  /** @type {(() => PlanProvider[]) | undefined} */
  providersOverride
  /** @type {PlanCatalogue | undefined} */
  catalogueCache
  /** @type {PlanModelTraitSource | undefined} */
  traitSourceCache
  /** @type {Map<string, PlanModelTraits>} */
  traitCache

  /**
   * @param {PlanAdapterDeps} deps 依赖（全部可注入）。
   */
  constructor({ options, logger, resolveAttachments, readCredentials: credentialsReader, readPlanCredentials: planCredentialReader, fetchImpl, providers }) {
    super()
    /** @type {() => ResolvedOptions} */
    this.options = options
    /** @type {BridgeLogger | undefined} */
    this.logger = logger
    /** @type {(() => ImageAttachmentSource | undefined) | undefined} */
    this.resolveAttachments = resolveAttachments
    /** @type {((dataBaseDir: string) => Record<string, string | null>) | undefined} */
    this.credentialsReader = credentialsReader
    /** @type {(() => Record<string, string>) | undefined} */
    this.planCredentialReader = planCredentialReader
    /** @type {typeof fetch | undefined} */
    this.fetchImpl = fetchImpl
    /** @type {(() => PlanProvider[]) | undefined} */
    this.providersOverride = providers
    /** 路由表缓存（配置热更新时由 {@link ZcodePlanAdapter.refreshCatalogue} 清掉）。 @type {PlanCatalogue | undefined} */
    this.catalogueCache = undefined
    /** 模型能力来源缓存。 @type {PlanModelTraitSource | undefined} */
    this.traitSourceCache = undefined
    /** 模型能力缓存。 @type {Map<string, PlanModelTraits>} */
    this.traitCache = new Map()
  }

  /**
   * 释放缓存（对称于旧通道的 `dispose()`，由 `index.js` 的 `ctx.effect` 调用）。
   *
   * @returns {void}
   */
  dispose() {
    this.catalogueCache = undefined
    this.traitSourceCache = undefined
    this.traitCache.clear()
  }

  /**
   * 清掉路由表 / 模型能力缓存，让下一次查询重新读磁盘。
   *
   * @returns {void}
   */
  refreshCatalogue() {
    this.catalogueCache = undefined
    this.traitSourceCache = undefined
    this.traitCache.clear()
  }

  /**
   * 当前配置解析出的 ZCode 数据根（凭证与 release 都从这里找）。
   *
   * @returns {string} 数据根目录；解析失败时 ''。
   */
  dataBaseDir() {
    const config = this.options()
    if (config.zcodeDataRoot !== undefined) return config.zcodeDataRoot.dataBaseDir
    try {
      return resolveZcodeDataRoot(config.zcodeDataBaseDir).dataBaseDir
    } catch {
      return ''
    }
  }

  /**
   * 计划路由表（带缓存）。
   *
   * @returns {PlanCatalogue} 路由表。
   */
  catalogue() {
    const cached = this.catalogueCache
    if (cached !== undefined) return cached
    if (this.providersOverride !== undefined) {
      /** @type {PlanCatalogue} */
      const injected = { providers: this.providersOverride(), source: 'injected' }
      this.catalogueCache = injected
      return injected
    }
    const config = this.options()
    const loaded = loadPlanCatalogue({
      dataBaseDir: this.dataBaseDir(),
      cliPath: text(config.zcodeCliPath),
    })
    /** @type {PlanCatalogue} */
    const catalogue = {
      providers: loaded.providers,
      source: loaded.source,
      ...(loaded.releasePath === undefined ? {} : { releasePath: loaded.releasePath }),
      ...(loaded.reason === undefined ? {} : { reason: loaded.reason }),
    }
    this.logger?.info?.(
      `zcode-plan: ${catalogue.providers.length} plan route(s) from ${catalogue.source === 'builtin-release' ? catalogue.releasePath : 'the built-in fallback table'}`,
    )
    this.catalogueCache = catalogue
    return catalogue
  }

  /**
   * 模型能力来源（带缓存）。
   *
   * @returns {PlanModelTraitSource} 能力来源。
   */
  traitSource() {
    const cached = this.traitSourceCache
    if (cached !== undefined) return cached
    const config = this.options()
    const releasePath = this.catalogue().releasePath
    const loaded = loadModelTraits({
      dataBaseDir: this.dataBaseDir(),
      cliPath: text(config.zcodeCliPath),
      ...(releasePath === undefined ? {} : { releasePath }),
    })
    this.traitSourceCache = loaded
    return loaded
  }

  /**
   * 一个上游模型 id 的能力（带缓存）。
   *
   * @param {string} modelId 上游模型 id。
   * @returns {PlanModelTraits} 模型能力。
   */
  traitsFor(modelId) {
    const cached = this.traitCache.get(modelId)
    if (cached !== undefined) return cached
    const traits = traitsForModel(modelId, this.traitSource())
    this.traitCache.set(modelId, traits)
    return traits
  }

  /**
   * 读取凭证：客户端共享凭证 + 插件自有凭证文件（`login` 写的那份）。
   *
   * 为什么两份都要：`zcodejwttoken` 可能来自客户端登录（`credentials.json`），也可能来自
   * 插件自己的设备码登录（`planCredentialStore`）。后者是插件**唯一**能写的地方 ——
   * 客户端那个文件是进程内锁的「整文件读—改—写」，外部写会被下一次客户端写入覆盖。
   *
   * 合并方向：**插件自有凭证优先**。它是用户在本插件里显式登录的结果，比客户端那份更新；
   * 客户端凭证补齐插件没拿到的键（例如 coding-plan 的 `account-provider:...:api-key`，
   * 那条链路只有客户端会写）。
   *
   * 插件凭证文件读不出来（损坏 / 权限）时只记一条警告，继续用客户端凭证 —— 一个坏文件
   * 不该让整条通道失效。
   *
   * **客户端凭证读不出来时不抛**：这是「插件自己 login 过、但没装 ZCode 客户端」的正常部署
   * （也正是直连通道存在的理由）。只有两份都拿不到 `zcodejwttoken` 时才算鉴权失败，由
   * `resolvePlanRoute` 报 `TOKEN_MISSING` —— 那里才知道具体缺哪个家族的凭证。
   *
   * @returns {Record<string, string | null>} 凭证表。
   */
  credentials() {
    const dataBaseDir = this.dataBaseDir()
    const reader = this.credentialsReader
    /** @type {Record<string, string | null>} */
    let merged = {}
    try {
      merged = reader !== undefined
        ? reader(dataBaseDir)
        : /** @type {Record<string, string | null>} */ (readCredentials(dataBaseDir))
    } catch (/** @type {any} */ error) {
      // 没有客户端（或客户端未登录）不是错误：插件自有凭证可能就够了。
      this.logger?.info?.(`zcode-plan: no client credentials (${error?.code ?? error?.message ?? error}); relying on the plugin credential store`)
    }
    const pluginCredentials = this.readPlanCredentials()
    if (pluginCredentials === undefined) return merged
    for (const [key, value] of Object.entries(pluginCredentials)) {
      const plain = text(value)
      if (plain !== '') merged[key] = plain
    }
    return merged
  }

  /**
   * 读插件自有的凭证文件（`login` 命令的落盘位置）。
   *
   * @returns {Record<string, string> | undefined} 凭证；未配置路径 / 文件不存在 / 读取失败时 undefined。
   */
  readPlanCredentials() {
    const reader = this.planCredentialReader
    if (reader !== undefined) {
      try {
        return reader()
      } catch (/** @type {any} */ error) {
        this.logger?.warn?.(`zcode-plan: could not read the plugin credential store (${error?.message ?? error}); falling back to the client credentials`)
        return undefined
      }
    }
    const config = this.options()
    const filePath = text(/** @type {any} */ (config).planCredentialStore)
    if (filePath === '') return undefined
    try {
      const store = new PluginCredentialStore({ filePath })
      const record = store.read()
      return Object.keys(record).length === 0 ? undefined : record
    } catch (/** @type {any} */ error) {
      this.logger?.warn?.(`zcode-plan: could not read ${filePath} (${error?.message ?? error}); falling back to the client credentials`)
      return undefined
    }
  }

  /**
   * 图片读取器：把 DSH 的 durable image ref 读成 base64。
   *
   * @returns {((ref: any) => Promise<{ mediaType: string, dataBase64: string } | undefined>) | undefined} 读取器；没有附件服务时 undefined。
   */
  imageLoader() {
    const resolve = this.resolveAttachments
    if (typeof resolve !== 'function') return undefined
    const attachments = resolve()
    if (attachments === undefined || typeof attachments.readImage !== 'function') return undefined
    return async (ref) => {
      try {
        const stored = await attachments.readImage(ref)
        const mediaType = text(stored?.ref?.mediaType) || 'image/png'
        return { mediaType, dataBase64: Buffer.from(stored.data).toString('base64') }
      } catch (/** @type {any} */ error) {
        this.logger?.warn?.(`zcode-plan: failed to read an image attachment (${error?.message ?? error}); sending a text placeholder`)
        return undefined
      }
    }
  }

  /**
   * 解析一个 DSH 模型 id。
   *
   * @param {string} model DSH 模型 id（`<providerId>#<modelId>` / `<providerId>/<modelId>` / 裸 modelId）。
   * @returns {{ providerId: string, modelId: string } | undefined} 拆解结果。
   */
  parseModel(model) {
    return parsePlanModelId(model, this.catalogue().providers)
  }

  /**
   * 描述 provider 路由。
   *
   * @param {string} provider Provider 路由键。
   * @returns {LlmProviderInfo} Provider 展示元数据。
   */
  providerInfo(provider) {
    return { id: provider, name: PLAN_PROVIDER_NAME }
  }

  /**
   * Provider 自己的重试策略。
   *
   * @returns {ResolvedRetryPolicy} 已解析的重试策略。
   */
  providerRetryPolicy() {
    return this.options().retryPolicy
  }

  /**
   * 当前配置里该通道的模型筛选列表。
   *
   * 直连通道有**自己的**开关（`planEnabledModelIds` / `planDisabledModelIds`），因为同一条
   * 模型 id 在两条通道里含义不同：旧通道的 `enabledModelIds` 填的是纯 `modelId`，直连通道
   * 填的是 `<providerId>#<modelId>`。两个通道共用一个列表会让对方的选择莫名其妙失效。
   *
   * 直连字段留空时**不回退**到旧字段：空 = 全开，这是两个通道各自独立且一致的语义。
   * 只有整个配置对象里根本没有直连字段（升级前的旧结构）才退回旧的 `enabledModelIds` /
   * `disabledModelIds` —— 那时旧字段是唯一可用的信号。
   *
   * @returns {{ enabled: string[], disabled: string[] }} 该通道的筛选列表。
   */
  modelSelection() {
    const config = this.options()
    /** @type {any} */
    const raw = config
    const planEnabled = Array.isArray(raw.planEnabledModelIds) ? normalizeIdList(raw.planEnabledModelIds) : undefined
    const planDisabled = Array.isArray(raw.planDisabledModelIds) ? normalizeIdList(raw.planDisabledModelIds) : undefined
    if (planEnabled !== undefined || planDisabled !== undefined) {
      return { enabled: planEnabled ?? [], disabled: planDisabled ?? [] }
    }
    // 没有直连专用字段的配置对象（例如只注入了旧结构）：退回旧的 enabled/disabled。
    return {
      enabled: normalizeIdList(config.enabledModelIds),
      disabled: normalizeIdList(config.disabledModelIds),
    }
  }

  /**
   * 当前对外宣告的模型清单（已应用 enable/disable 过滤）。
   *
   * @returns {PlanModelEntry[]} 过滤后的模型清单。
   */
  effectiveModels() {
    const entries = buildPlanModels(this.catalogue().providers)
    const selection = this.modelSelection()
    const selected = selectPlanModels(entries, selection.enabled, selection.disabled)
    if (selected.unknownEnabledIds.length !== 0) {
      this.logger?.warn?.(`zcode-plan: planEnabledModelIds entries not in the plan catalogue: ${selected.unknownEnabledIds.join(', ')}`)
    }
    if (selected.unknownDisabledIds.length !== 0) {
      this.logger?.warn?.(`zcode-plan: planDisabledModelIds entries not in the plan catalogue: ${selected.unknownDisabledIds.join(', ')}`)
    }
    if (selected.models.length !== entries.length) {
      this.logger?.info?.(`zcode-plan: model selection active, advertising ${selected.models.length}/${entries.length} models`)
    }
    return selected.models
  }

  /**
   * 列出该 provider 宣告的模型。
   *
   * @param {string} provider Provider 路由键。
   * @returns {Promise<readonly LlmModelInfo[]>} 模型清单。
   */
  async listModels(provider) {
    /** @type {LlmModelInfo[]} */
    const advertised = this.effectiveModels().map((entry) => ({
      provider,
      id: entry.id,
      name: entry.modelId,
      description: entry.providerId,
      inputModalities: /** @type {readonly ModelModality[]} */ (
        this.traitsFor(entry.modelId).supportsImage ? [...MODEL_MODALITIES] : ['text']
      ),
    }))
    return advertised
  }

  /**
   * 解析一个模型的能力。
   *
   * @param {string} provider Provider 路由键。
   * @param {string} model DSH 模型 id。
   * @returns {Promise<LlmResolvedModelInfo>} 模型元数据。
   */
  async resolveModel(provider, model) {
    const parsed = this.parseModel(model)
    const modelId = parsed?.modelId ?? text(model)
    const traits = this.traitsFor(modelId)
    const defaultEffort = defaultReasoningLevelOf(traits.reasoningLevels)
    /** @type {import('@deepseek-ai/dsh-llm').LlmModelReasoningInfo | undefined} */
    const reasoning = defaultEffort === undefined
      ? undefined
      : {
          efforts: traits.reasoningLevels.map((level) => ({ id: ReasoningEffortId(level), name: level })),
          defaultEffort: ReasoningEffortId(defaultEffort),
        }
    /** @type {LlmResolvedModelInfo} */
    const resolved = {
      provider,
      id: model,
      name: modelId,
      ...(parsed === undefined ? {} : { description: parsed.providerId }),
      inputModalities: /** @type {readonly ModelModality[]} */ (traits.supportsImage ? [...MODEL_MODALITIES] : ['text']),
      context: { contextWindow: traits.contextWindow },
      defaultMaxTokens: traits.maxOutputTokens,
      ...(reasoning === undefined ? {} : { reasoning }),
    }
    return resolved
  }

  /**
   * 跑一个回合，产出 DSH 的 chunk 流。
   *
   * @param {GenerateOptions} options DSH 组装好的请求。
   * @returns {AsyncGenerator<StreamChunk, void, unknown>} chunk 流。
   */
  async *stream(options) {
    // 辅助调用：标题本地生成，一个字节都不发（与旧通道一致）。
    if (options.purpose === 'session-title') {
      const title = localSessionTitle(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const model = text(options.model)
    const parsed = this.parseModel(model)
    if (parsed === undefined) {
      throw new LlmError(
        `无法解析模型 id "${model}"：直连通道的 id 必须能定位到一条计划路由（形如 account:zai-start-plan#GLM-5.3-Flash）`,
        'INVALID_REQUEST',
      )
    }
    const traits = this.traitsFor(parsed.modelId)

    /** @type {Record<string, string | null>} */
    let credentials
    try {
      credentials = this.credentials()
    } catch (/** @type {any} */ error) {
      throw toLlmError(error)
    }

    /** @type {PlanRoute} */
    let route
    try {
      route = resolvePlanRoute({ providerId: parsed.providerId, credentials })
    } catch (/** @type {any} */ error) {
      throw toLlmError(error)
    }

    /** @type {PlanMessagesRequest} */
    let request
    try {
      request = await toAnthropicRequest(options, {
        modelId: parsed.modelId,
        traits,
        defaultMaxTokens: traits.maxOutputTokens,
        imageLoader: this.imageLoader(),
        logger: this.logger,
      })
    } catch (/** @type {any} */ error) {
      throw toLlmError(error)
    }

    this.logger?.debug?.(
      `zcode-plan: POST ${route.baseUrl}/v1/messages (route ${parsed.providerId}, model ${parsed.modelId}, ${request.messages.length} message(s))`,
    )

    // `done` 由这里统一收尾，不在循环里转发：DSH 的契约是「usage 之后只能有 finish」，
    // 而空响应必须在发 finish 之前抛出去（发过 finish 再抛就成了两个终态）。
    const mapper = new PlanStreamMapper()
    /** @type {string | null} */
    let stopReason = null
    try {
      for await (const event of streamMessages(route, request, {
        signal: options.signal,
        ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      })) {
        if (event.type === 'done') {
          stopReason = event.stopReason
          continue
        }
        for (const chunk of mapper.push(event)) yield chunk
      }
    } catch (/** @type {any} */ error) {
      throw toLlmError(error)
    }

    if (!mapper.sawContent) {
      throw new LlmError(
        '计划端点返回了空响应（没有任何内容块）：上游可能拒答或返回了退化结果，可重试',
        EMPTY_RESPONSE_CODE,
      )
    }
    for (const chunk of mapper.push({ type: 'done', stopReason })) yield chunk
  }
}
