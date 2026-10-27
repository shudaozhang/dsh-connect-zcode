// 计划端点直连客户端（`lib/plan-client.js`）。
//
// 这个模块的价值全在「把凭证变成正确的请求头」和「把字节流变成统一事件」两件事上，
// 而这两件事都可以完全离线验证：路由/鉴权头是纯数据，SSE 是纯状态机。所以下面的测试
// 一个真实网络请求都不发 —— 需要 HTTP 的地方一律注入假 `fetch` / 假 `Response`。
//
// 唯一没法在这里覆盖的是「上游确实认这组头」：本机套餐无额度，实测只能拿到业务码
// （1005 / 1309 / 3009），证明链路通但拿不到正常内容流。那份证据记在模块文档里。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ANTHROPIC_VERSION,
  PLAN_ENDPOINTS,
  PlanClientError,
  classifyPlanError,
  createAnthropicTranslator,
  createSseParser,
  dedupeRoutes,
  isFailoverError,
  messagesUrl,
  parseErrorEnvelope,
  pickCodingPlanApiKey,
  resolvePlanRoute,
  streamMessages,
  streamMessagesAcrossRoutes,
  translateMessage,
} from '../lib/plan-client.js'

/** `account-provider:coding-plan:<providerId>:account:<identity>:api-key` 这种存储键。 */
const planKeyFor = (providerId, accountId = '12345') =>
  `account-provider:coding-plan:${providerId}:account:${accountId}:api-key`

/**
 * @param {string} text 待切分的文本。
 * @param {number[]} sizes 每块字符数。
 * @returns {Uint8Array[]} 按字符切分后编码的字节块（刻意在 UTF-8 字符内部切）。
 */
function splitBytes(text, sizes) {
  const bytes = new TextEncoder().encode(text)
  /** @type {Uint8Array[]} */
  const out = []
  let offset = 0
  for (const size of sizes) {
    out.push(bytes.subarray(offset, offset + size))
    offset += size
  }
  if (offset < bytes.length) out.push(bytes.subarray(offset))
  return out
}

/**
 * 构造一个假的 SSE `Response`。
 *
 * @param {Uint8Array[]} chunks 依次入队的字节块。
 * @param {number} [status] HTTP 状态。
 * @param {Record<string, string>} [headers] 响应头。
 * @returns {Response} 可直接交给 `streamMessages` 的响应。
 */
function sseResponse(chunks, status = 200, headers = { 'content-type': 'text/event-stream' }) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, { status, headers })
}

// ---------------------------------------------------------------------------
// 路由解析 + 鉴权头
// ---------------------------------------------------------------------------

test('resolvePlanRoute maps every measured provider family to its measured endpoint and auth shape', () => {
  const credentials = {
    zcodejwttoken: 'jwt-token',
    [planKeyFor('account:zai-individual-coding-plan')]: 'zai-plan-key',
    [planKeyFor('account:bigmodel-individual-coding-plan')]: 'bigmodel-plan-key',
    [planKeyFor('account:bigmodel-team-coding-plan')]: 'bigmodel-team-key',
    [planKeyFor('account:bigmodel-offpeak-idle-plan')]: 'offpeak-plan-key',
    [planKeyFor('account:bigmodel-highspeed-card')]: 'highspeed-plan-key',
  }

  const startZai = resolvePlanRoute({ providerId: 'account:zai-start-plan', credentials })
  assert.equal(startZai.baseUrl, 'https://zcode.z.ai/api/v1/zcode-plan/anthropic')
  assert.equal(startZai.family, 'zai')
  assert.equal(startZai.planKind, 'start-plan')
  assert.equal(startZai.authKind, 'bearer-jwt')
  const startHeaders = startZai.buildHeaders()
  assert.equal(startHeaders.authorization, 'Bearer jwt-token')
  assert.equal(startHeaders['x-api-key'], undefined, 'the start-plan endpoint must not get x-api-key')

  const startBigmodel = resolvePlanRoute({ providerId: 'account:bigmodel-start-plan', credentials })
  assert.equal(startBigmodel.baseUrl, PLAN_ENDPOINTS['start-plan'], 'both start-plan families share the zcode-plan endpoint')
  assert.equal(startBigmodel.family, 'bigmodel')
  assert.equal(startBigmodel.buildHeaders().authorization, 'Bearer jwt-token')

  const zaiCoding = resolvePlanRoute({ providerId: 'account:zai-individual-coding-plan', credentials })
  assert.equal(zaiCoding.baseUrl, 'https://api.z.ai/api/anthropic')
  assert.equal(zaiCoding.authKind, 'api-key')
  const zaiHeaders = zaiCoding.buildHeaders()
  assert.equal(zaiHeaders['x-api-key'], 'zai-plan-key')
  assert.equal(zaiHeaders.authorization, undefined, 'api.z.ai must not get the Bearer JWT (that is the 401)')

  const bigmodelCoding = resolvePlanRoute({ providerId: 'account:bigmodel-team-coding-plan', credentials })
  assert.equal(bigmodelCoding.baseUrl, 'https://open.bigmodel.cn/api/anthropic')
  assert.equal(bigmodelCoding.buildHeaders()['x-api-key'], 'bigmodel-team-key', 'the key is picked by the exact providerId')

  const offpeak = resolvePlanRoute({ providerId: 'account:bigmodel-offpeak-idle-plan', credentials })
  assert.equal(offpeak.baseUrl, 'https://zcode.z.ai/api/v1/off-peak/anthropic')
  assert.equal(offpeak.authKind, 'bearer-jwt+coding-plan-key')
  const offpeakHeaders = offpeak.buildHeaders()
  assert.equal(offpeakHeaders.authorization, 'Bearer jwt-token')
  assert.equal(offpeakHeaders['X-Coding-Plan-Api-Key'], 'offpeak-plan-key')
  assert.equal(offpeakHeaders['X-Off-Peak-Ticket-ID'], undefined, 'no ticket id is invented when the caller has none')

  const highspeed = resolvePlanRoute({ providerId: 'account:bigmodel-highspeed-card', credentials, cardId: 'card-9' })
  assert.equal(highspeed.baseUrl, 'https://zcode.z.ai/api/v1/highspeed/anthropic')
  assert.equal(highspeed.authKind, 'bearer-jwt+coding-plan-key+card-id')
  const highspeedHeaders = highspeed.buildHeaders()
  assert.equal(highspeedHeaders.authorization, 'Bearer jwt-token')
  assert.equal(highspeedHeaders['X-Coding-Plan-Api-Key'], 'highspeed-plan-key')
  assert.equal(highspeedHeaders['X-Highspeed-Card-ID'], 'card-9')
})

test('buildHeaders always carries the Anthropic envelope headers and switches accept on stream', () => {
  const route = resolvePlanRoute({ providerId: 'account:zai-start-plan', credentials: { zcodejwttoken: 'jwt' } })
  const plain = route.buildHeaders()
  assert.equal(plain['content-type'], 'application/json')
  assert.equal(plain['anthropic-version'], ANTHROPIC_VERSION)
  assert.equal(plain.accept, 'application/json')

  const streaming = route.buildHeaders({ stream: true })
  assert.equal(streaming.accept, 'text/event-stream')
  assert.equal(streaming['anthropic-version'], '2023-06-01')

  const withExtra = route.buildHeaders({ stream: true, extra: { 'x-trace': 'abc' } })
  assert.equal(withExtra['x-trace'], 'abc')
})

test('resolvePlanRoute refuses unknown routes and routes with missing credentials', () => {
  const credentials = { zcodejwttoken: 'jwt' }

  assert.throws(() => resolvePlanRoute({ providerId: '', credentials }), (error) => {
    assert.ok(error instanceof PlanClientError)
    assert.equal(error.code, 'UNKNOWN_PROVIDER')
    return true
  })
  assert.throws(() => resolvePlanRoute({ providerId: 'zai-api', credentials }), /无法识别/u)
  // A bare family name with no plan kind is not a plan route.
  assert.throws(() => resolvePlanRoute({ providerId: 'account:zai', credentials }), /无法识别/u)

  // start-plan needs the JWT; api-key must not silently stand in for it.
  assert.throws(
    () => resolvePlanRoute({ providerId: 'account:zai-start-plan', credentials: {} }),
    (error) => error instanceof PlanClientError && error.code === 'TOKEN_MISSING',
  )
  // coding-plan needs the account api key; the JWT must not silently stand in for it.
  assert.throws(
    () => resolvePlanRoute({ providerId: 'account:bigmodel-individual-coding-plan', credentials }),
    (error) => error instanceof PlanClientError && error.code === 'API_KEY_MISSING',
  )
  // A JWT from another family is still the right credential for its own route.
  const codingCredentials = { [planKeyFor('account:bigmodel-individual-coding-plan')]: 'ak' }
  assert.throws(
    () => resolvePlanRoute({ providerId: 'account:bigmodel-offpeak-idle-plan', credentials: codingCredentials }),
    (error) => error instanceof PlanClientError && error.code === 'TOKEN_MISSING',
  )
})

test('the highspeed route refuses to build headers without an explicit card id', () => {
  const credentials = {
    zcodejwttoken: 'jwt',
    [planKeyFor('account:zai-highspeed-card')]: 'ak',
  }
  const route = resolvePlanRoute({ providerId: 'account:zai-highspeed-card', credentials })
  // Resolving succeeds (the card is per-request), building headers does not.
  assert.throws(() => route.buildHeaders(), (error) => {
    assert.ok(error instanceof PlanClientError)
    assert.equal(error.code, 'CARD_ID_MISSING')
    return true
  })
  assert.throws(() => route.buildHeaders({ stream: true }), (error) => error instanceof PlanClientError && error.code === 'CARD_ID_MISSING')
})

test('resolvePlanRoute honours an explicit baseUrl override (proxy / test harness)', () => {
  const route = resolvePlanRoute({
    providerId: 'account:zai-start-plan',
    credentials: { zcodejwttoken: 'jwt' },
    baseUrl: 'http://127.0.0.1:8080/anthropic',
  })
  assert.equal(route.baseUrl, 'http://127.0.0.1:8080/anthropic')
  assert.equal(messagesUrl(route.baseUrl), 'http://127.0.0.1:8080/anthropic/v1/messages')
})

test('messagesUrl appends /v1/messages exactly once and is tolerant of trailing slashes', () => {
  assert.equal(messagesUrl('https://open.bigmodel.cn/api/anthropic'), 'https://open.bigmodel.cn/api/anthropic/v1/messages')
  assert.equal(messagesUrl('https://open.bigmodel.cn/api/anthropic/'), 'https://open.bigmodel.cn/api/anthropic/v1/messages')
  assert.equal(messagesUrl('https://open.bigmodel.cn/api/anthropic/v1/messages'), 'https://open.bigmodel.cn/api/anthropic/v1/messages')
  assert.throws(() => messagesUrl('   '), (error) => error instanceof PlanClientError)
})

test('pickCodingPlanApiKey matches the stored key by prefix and tolerates the account: prefix', () => {
  const credentials = {
    [planKeyFor('account:bigmodel-team-coding-plan', '7')]: 'team-key',
    [planKeyFor('account:bigmodel-team-coding-plan', '8')]: 'team-key-2',
    'account-provider:coding-plan:account:zai-start-plan:account:9:api-key': 'start-key',
    // Near-misses that must not match.
    'account-provider:coding-plan:account:bigmodel-team-coding-plan-extra:account:1:api-key': 'wrong',
    'zcodejwttoken': 'jwt',
  }

  assert.equal(pickCodingPlanApiKey(credentials, 'account:bigmodel-team-coding-plan'), 'team-key')
  assert.equal(pickCodingPlanApiKey(credentials, 'bigmodel-team-coding-plan'), 'team-key', 'the account: prefix is optional')
  assert.equal(pickCodingPlanApiKey(credentials, 'account:zai-start-plan'), 'start-key')
  assert.equal(pickCodingPlanApiKey(credentials, 'account:zai-individual-coding-plan'), undefined)
  assert.equal(pickCodingPlanApiKey(credentials, ''), undefined)
  assert.equal(pickCodingPlanApiKey(undefined, 'account:zai-start-plan'), undefined)
  assert.equal(pickCodingPlanApiKey({ [planKeyFor('account:zai-start-plan')]: '   ' }, 'account:zai-start-plan'), undefined)
})

// ---------------------------------------------------------------------------
// 错误信封 + 分类
// ---------------------------------------------------------------------------

test('parseErrorEnvelope understands both measured upstream error shapes', () => {
  // zcode-plan: {code, msg, logid}
  const plan = parseErrorEnvelope('{"code":1005,"msg":"exceed quota limit","logid":"lg-1"}')
  assert.deepEqual(plan, {
    code: 1005,
    message: 'exceed quota limit',
    logid: 'lg-1',
    requestId: undefined,
    upstreamType: undefined,
  })

  // bigmodel anthropic: {type:'error', error:{type, code, message}, request_id}
  const anthropic = parseErrorEnvelope(
    '{"type":"error","error":{"type":"rate_limit_error","code":"1309","message":"[1309][您的GLM Coding Plan套餐已到期]"},"request_id":"rq-2"}',
  )
  assert.equal(anthropic?.code, '1309', 'string codes stay strings')
  assert.equal(anthropic?.message, '[1309][您的GLM Coding Plan套餐已到期]')
  assert.equal(anthropic?.requestId, 'rq-2')
  assert.equal(anthropic?.upstreamType, 'rate_limit_error')

  // A success envelope carries nothing to report.
  assert.equal(parseErrorEnvelope('{"code":0,"msg":"","data":{}}'), undefined)
  assert.equal(parseErrorEnvelope('{"code":"0","msg":"ok"}'), undefined)
  // Non-JSON / empty / non-object bodies are not envelopes.
  assert.equal(parseErrorEnvelope(''), undefined)
  assert.equal(parseErrorEnvelope('   '), undefined)
  assert.equal(parseErrorEnvelope('<html>502 Bad Gateway</html>'), undefined)
  assert.equal(parseErrorEnvelope('[1,2,3]'), undefined)
  assert.equal(parseErrorEnvelope('null'), undefined)
})

test('classifyPlanError maps the measured business codes to their kind and keeps the raw code/message', () => {
  const quota = classifyPlanError(200, '{"code":1005,"msg":"exceed quota limit","logid":"lg"}')
  assert.equal(quota.kind, 'quota', 'a 200 carrying 1005 is still a quota failure -- this is the trap')
  assert.equal(quota.code, 1005)
  assert.equal(quota.message, 'exceed quota limit')
  assert.equal(quota.retryable, false)
  assert.equal(quota.status, 200)
  assert.equal(quota.logid, 'lg')

  const expired = classifyPlanError(
    429,
    '{"type":"error","error":{"type":"rate_limit_error","code":"1309","message":"您的GLM Coding Plan套餐已到期"},"request_id":"rq"}',
  )
  assert.equal(expired.kind, 'quota', 'an expired plan is quota, not concurrency, even on 429')
  assert.equal(expired.code, '1309')
  assert.equal(expired.message, '您的GLM Coding Plan套餐已到期')
  assert.equal(expired.requestId, 'rq')
  assert.equal(expired.retryable, false)

  assert.equal(classifyPlanError(200, '{"code":1113,"msg":"余额不足"}').kind, 'quota')

  const concurrency = classifyPlanError(429, '{"code":3009,"msg":"model concurrency limit exceeded","logid":"lg"}')
  assert.equal(concurrency.kind, 'concurrency')
  assert.equal(concurrency.retryable, true, '3009 is worth backing off and retrying')
  assert.equal(concurrency.code, 3009)

  const param = classifyPlanError(400, '{"code":3001,"msg":"parameter error"}')
  assert.equal(param.kind, 'param')
  assert.equal(param.code, 3001)
  assert.equal(param.retryable, false)

  // Crossed auth headers are the measured 401.
  for (const status of [401, 403]) {
    const auth = classifyPlanError(status, '{"type":"error","error":{"type":"authentication_error","message":"invalid api key"}}')
    assert.equal(auth.kind, 'auth')
    assert.equal(auth.retryable, false)
    assert.equal(auth.message, 'invalid api key')
  }

  const upstream = classifyPlanError(502, '<html>bad gateway</html>')
  assert.equal(upstream.kind, 'upstream')
  assert.equal(upstream.retryable, true)
  assert.equal(upstream.code, undefined)
  assert.match(upstream.message, /bad gateway/u)
  assert.equal(classifyPlanError(503, '').kind, 'upstream')
})

test('classifyPlanError never swallows the raw body and degrades gracefully without an envelope', () => {
  const result = classifyPlanError(418, 'teapot')
  assert.equal(result.kind, 'upstream')
  assert.equal(result.message, 'teapot')
  assert.equal(result.body, 'teapot')

  // A very long non-JSON body is truncated but still recognisable.
  const long = 'x'.repeat(2000)
  const truncated = classifyPlanError(500, long)
  assert.equal(truncated.body.length, 500)
  assert.ok(truncated.message.length <= 300)
})

// ---------------------------------------------------------------------------
// SSE 解析
// ---------------------------------------------------------------------------

test('createSseParser survives chunk boundaries splitting lines and \\r\\n pairs', () => {
  const wire = 'event: ping\r\ndata: {"a":1}\r\n\r\ndata: second\n\n'
  // One character at a time: the \r and its \n always land in different chunks.
  const parser = createSseParser()
  /** @type {{ event: string, data: string }[]} */
  const events = []
  for (const ch of wire) events.push(...parser.push(ch))
  events.push(...parser.flush())

  assert.deepEqual(events, [
    { event: 'ping', data: '{"a":1}' },
    { event: 'message', data: 'second' },
  ])
  assert.equal(parser.pending(), '')
})

test('createSseParser joins consecutive data lines and pairs event with data', () => {
  const parser = createSseParser()
  const events = parser.push(
    ': heartbeat\n' +
      'data: line one\n' +
      'data: line two\n' +
      '\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta"}\n' +
      '\n' +
      'data:[DONE]\n\n',
  )
  assert.deepEqual(events, [
    { event: 'message', data: 'line one\nline two' },
    { event: 'content_block_delta', data: '{"type":"content_block_delta"}' },
    { event: 'message', data: '[DONE]' },
  ])
})

test('createSseParser handles a bare \\r line terminator and a last event without a trailing blank line', () => {
  const parser = createSseParser()
  const events = [...parser.push('data: a\rdata: b\r\r'), ...parser.push('data: tail'), ...parser.flush()]
  // A bare \r is a line terminator (SSE allows it); a lone `data:` line is data, not a new event.
  assert.deepEqual(events, [
    { event: 'message', data: 'a\nb' },
    { event: 'message', data: 'tail' },
  ])

  // No trailing newline at all: flush still emits the last record.
  const unterminated = createSseParser()
  assert.deepEqual([...unterminated.push('event: x'), ...unterminated.flush()], [])
  const noNewline = createSseParser()
  assert.deepEqual([...noNewline.push('\ndata: last'), ...noNewline.flush()], [{ event: 'message', data: 'last' }])
})

test('createSseParser keeps multi-byte UTF-8 intact when a chunk ends mid-character', () => {
  const wire = 'data: {"text":"中文增量"}\n\ndata: {"text":"第二块"}\n\n'
  // Split at odd byte offsets so several chunks end inside a 3-byte character.
  const chunks = splitBytes(wire, [1, 2, 3, 5, 7, 11, 13])
  const parser = createSseParser()
  /** @type {{ event: string, data: string }[]} */
  const events = []
  for (const chunk of chunks) events.push(...parser.push(chunk))
  events.push(...parser.flush())

  assert.deepEqual(events.map((event) => JSON.parse(event.data).text), ['中文增量', '第二块'])
})

// ---------------------------------------------------------------------------
// 翻译器：上游事件 → 统一事件
// ---------------------------------------------------------------------------

test('the translator turns an Anthropic text stream into text/usage/done', () => {
  const translator = createAnthropicTranslator()
  const wire = [
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'He' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }],
    ['message_stop', { type: 'message_stop' }],
  ]

  /** @type {import('../lib/plan-client.js').PlanStreamEvent[]} */
  const out = []
  for (const [name, payload] of wire) out.push(...translator.push({ event: /** @type {string} */ (name), data: JSON.stringify(payload) }))

  assert.deepEqual(out, [
    { type: 'usage', inputTokens: 12, outputTokens: 1 },
    { type: 'text', delta: 'He' },
    { type: 'text', delta: 'llo' },
    { type: 'usage', inputTokens: 12, outputTokens: 7 },
    { type: 'done', stopReason: 'end_turn' },
  ])
  assert.equal(translator.finished, true)
  // Events after done are dropped, not replayed.
  assert.deepEqual(translator.push({ event: 'message', data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"late"}}' }), [])
})

test('the translator maps thinking deltas to reasoning and tool_use blocks to start + json deltas', () => {
  const translator = createAnthropicTranslator()
  const feed = (payload) => translator.push({ event: /** @type {string} */ (payload.type), data: JSON.stringify(payload) })

  assert.deepEqual(feed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一下' } }), [
    { type: 'reasoning', delta: '想一下' },
  ])
  // signature_delta carries nothing DSH can use.
  assert.deepEqual(feed({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }), [])

  assert.deepEqual(feed({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } }), [
    { type: 'tool_use_start', id: 'toolu_1', name: 'read_file' },
  ])
  assert.deepEqual(feed({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } }), [
    { type: 'tool_use_delta', id: 'toolu_1', partialJson: '{"pa' },
  ])
  assert.deepEqual(feed({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'th":"x"}' } }), [
    { type: 'tool_use_delta', id: 'toolu_1', partialJson: 'th":"x"}' },
  ])
  // A non-streamed tool call arrives with its input already complete.
  assert.deepEqual(feed({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: 'ls', input: { path: '.' } } }), [
    { type: 'tool_use_start', id: 'toolu_2', name: 'ls' },
    { type: 'tool_use_delta', id: 'toolu_2', partialJson: '{"path":"."}' },
  ])
})

test('the translator treats [DONE], message_stop and an error frame as terminal', () => {
  const done = createAnthropicTranslator()
  assert.deepEqual(done.push({ event: 'message', data: '[DONE]' }), [{ type: 'done', stopReason: null }])
  assert.equal(done.finished, true)
  assert.deepEqual(done.push({ event: 'message', data: '[DONE]' }), [], 'done is emitted exactly once')

  const stop = createAnthropicTranslator()
  assert.deepEqual(stop.push({ event: 'message', data: '{"type":"message_stop"}' }), [{ type: 'done', stopReason: null }])

  const failed = createAnthropicTranslator()
  assert.deepEqual(
    failed.push({ event: 'error', data: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }),
    [],
    'the error frame produces no event -- the caller throws from .failure',
  )
  assert.equal(failed.finished, true)
  assert.equal(failed.failure?.kind, 'upstream')
  assert.equal(failed.failure?.message, 'Overloaded')
})

test('the translator ignores empty, non-JSON and unknown frames instead of aborting the stream', () => {
  const translator = createAnthropicTranslator()
  for (const data of ['', '   ', 'not-json', '{"type":"ping"}', 'null', '{"type":"content_block_start","content_block":{"type":"text"}}']) {
    assert.deepEqual(translator.push({ event: 'message', data }), [], `frame ${JSON.stringify(data)} must be ignored`)
  }
  assert.equal(translator.finished, false)
})

test('translateMessage flattens a non-streamed Anthropic response into the same event vocabulary', () => {
  const events = translateMessage({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '先想' },
      { type: 'text', text: '答案' },
      { type: 'tool_use', id: 'toolu_9', name: 'grep', input: { pattern: 'x' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 30, output_tokens: 12 },
  })
  assert.deepEqual(events, [
    { type: 'reasoning', delta: '先想' },
    { type: 'text', delta: '答案' },
    { type: 'tool_use_start', id: 'toolu_9', name: 'grep' },
    { type: 'tool_use_delta', id: 'toolu_9', partialJson: '{"pattern":"x"}' },
    { type: 'usage', inputTokens: 30, outputTokens: 12 },
    { type: 'done', stopReason: 'tool_use' },
  ])
  assert.deepEqual(translateMessage(null), [])
  assert.deepEqual(translateMessage({ content: [] }), [{ type: 'done', stopReason: null }])
})

// ---------------------------------------------------------------------------
// streamMessages：注入假 fetch，跑通整条链路
// ---------------------------------------------------------------------------

/** 一次完整的 SSE 回合，刻意在 JSON 中间切块。 */
const TEXT_TURN =
  'event: message_start\n' +
  'data: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":0}}}\n' +
  '\n' +
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n' +
  '\n' +
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"，世界"}}\n' +
  '\n' +
  'event: message_delta\n' +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n' +
  '\n' +
  'event: message_stop\n' +
  'data: {"type":"message_stop"}\n' +
  '\n'

test('streamMessages posts to <baseUrl>/v1/messages with the route headers and forces stream:true', async () => {
  /** @type {{ url: string, init: RequestInit } | undefined} */
  let seen
  const fetchImpl = /** @type {typeof fetch} */ (
    async (url, init) => {
      seen = { url: String(url), init: /** @type {RequestInit} */ (init) }
      return sseResponse([new TextEncoder().encode(TEXT_TURN)])
    }
  )
  const route = resolvePlanRoute({ providerId: 'account:zai-start-plan', credentials: { zcodejwttoken: 'jwt' } })

  /** @type {import('../lib/plan-client.js').PlanStreamEvent[]} */
  const events = []
  for await (const event of streamMessages(
    route,
    { model: 'GLM-5.3', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl },
  )) {
    events.push(event)
  }

  assert.ok(seen !== undefined, 'fetch must be called')
  assert.equal(seen.url, 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages')
  const headers = /** @type {Record<string, string>} */ (seen.init.headers)
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers.accept, 'text/event-stream')
  assert.equal(headers.authorization, 'Bearer jwt')
  assert.equal(seen.init.method, 'POST')

  const body = JSON.parse(String(seen.init.body))
  assert.equal(body.stream, true, 'stream must be forced on regardless of the caller')
  assert.equal(body.model, 'GLM-5.3')
  assert.equal(body.max_tokens, 64)

  assert.deepEqual(events, [
    { type: 'usage', inputTokens: 9, outputTokens: 0 },
    { type: 'text', delta: '你好' },
    { type: 'text', delta: '，世界' },
    { type: 'usage', inputTokens: 9, outputTokens: 4 },
    { type: 'done', stopReason: 'end_turn' },
  ])
})

test('streamMessages assembles a stream delivered in hostile chunk boundaries', async () => {
  const chunks = splitBytes(TEXT_TURN, [1, 3, 2, 40, 7, 1, 64, 5])
  const fetchImpl = /** @type {typeof fetch} */ (async () => sseResponse(chunks))
  const route = resolvePlanRoute({ providerId: 'account:zai-start-plan', credentials: { zcodejwttoken: 'jwt' } })

  /** @type {string} */
  let text = ''
  /** @type {import('../lib/plan-client.js').PlanStreamEvent[]} */
  const rest = []
  for await (const event of streamMessages(route, { model: 'm', max_tokens: 1, messages: [] }, { fetchImpl })) {
    if (event.type === 'text') text += event.delta
    else rest.push(event)
  }
  assert.equal(text, '你好，世界')
  assert.deepEqual(rest.at(-1), { type: 'done', stopReason: 'end_turn' })
})

test('streamMessages throws QUOTA for the measured 200-carrying-1005 response', async () => {
  const fetchImpl = /** @type {typeof fetch} */ (
    async () =>
      new Response('{"code":1005,"msg":"exceed quota limit","logid":"lg-9"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  )
  const route = resolvePlanRoute({ providerId: 'account:zai-start-plan', credentials: { zcodejwttoken: 'jwt' } })

  await assert.rejects(
    (async () => {
      for await (const _event of streamMessages(route, { model: 'm', max_tokens: 1, messages: [] }, { fetchImpl })) {
        assert.fail('a quota failure must not yield events')
      }
    })(),
    (error) => {
      assert.ok(error instanceof PlanClientError)
      assert.equal(error.code, 'QUOTA')
      assert.equal(error.detail?.kind, 'quota')
      assert.equal(error.detail?.code, 1005)
      assert.equal(error.detail?.message, 'exceed quota limit')
      assert.equal(error.detail?.logid, 'lg-9')
      assert.match(error.message, /exceed quota limit/u)
      return true
    },
  )
})

test('streamMessages throws CONCURRENCY (retryable) for the measured 429/3009 response', async () => {
  const fetchImpl = /** @type {typeof fetch} */ (
    async () =>
      new Response('{"code":3009,"msg":"model concurrency limit exceeded","logid":"lg-3"}', {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
  )
  const route = resolvePlanRoute({ providerId: 'account:zai-start-plan', credentials: { zcodejwttoken: 'jwt' } })
  await assert.rejects(
    (async () => {
      for await (const _event of streamMessages(route, { model: 'm', max_tokens: 1, messages: [] }, { fetchImpl })) assert.fail('no events')
    })(),
    (error) => {
      assert.equal(error.code, 'CONCURRENCY')
      assert.equal(error.retryable, true)
      assert.equal(error.detail?.kind, 'concurrency')
      return true
    },
  )
})

test('streamMessages throws QUOTA for the measured bigmodel 429/1309 response', async () => {
  const fetchImpl = /** @type {typeof fetch} */ (
    async () =>
      new Response(
        '{"type":"error","error":{"type":"rate_limit_error","code":"1309","message":"[1309][您的GLM Coding Plan套餐已到期，请续费或升级]"}}',
        { status: 429, headers: { 'content-type': 'application/json' } },
      )
  )
  const route = resolvePlanRoute({
    providerId: 'account:bigmodel-individual-coding-plan',
    credentials: { [planKeyFor('account:bigmodel-individual-coding-plan')]: 'ak' },
  })
  await assert.rejects(
    (async () => {
      for await (const _event of streamMessages(route, { model: 'm', max_tokens: 1, messages: [] }, { fetchImpl })) assert.fail('no events')
    })(),
    (error) => {
      assert.equal(error.code, 'QUOTA', 'an expired plan is quota, not concurrency')
      assert.equal(error.detail?.code, '1309')
      assert.match(error.detail?.message, /套餐已到期/u)
      return true
    },
  )
})

test('streamMessages falls back to one-shot JSON when upstream ignores stream:true', async () => {
  const payload = {
    type: 'message',
    content: [{ type: 'text', text: '一次性回复' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 },
  }
  const fetchImpl = /** @type {typeof fetch} */ (
    async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  )
  const route = resolvePlanRoute({ providerId: 'account:zai-start-plan', credentials: { zcodejwttoken: 'jwt' } })
  /** @type {import('../lib/plan-client.js').PlanStreamEvent[]} */
  const events = []
  for await (const event of streamMessages(route, { model: 'm', max_tokens: 1, messages: [] }, { fetchImpl })) events.push(event)
  assert.deepEqual(events, [
    { type: 'text', delta: '一次性回复' },
    { type: 'usage', inputTokens: 5, outputTokens: 3 },
    { type: 'done', stopReason: 'end_turn' },
  ])
})

test('streamMessages reports an in-stream error frame as an upstream failure', async () => {
  const wire =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n' +
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
  const fetchImpl = /** @type {typeof fetch} */ (async () => sseResponse([new TextEncoder().encode(wire)]))
  const route = resolvePlanRoute({ providerId: 'account:zai-start-plan', credentials: { zcodejwttoken: 'jwt' } })
  await assert.rejects(
    (async () => {
      for await (const _event of streamMessages(route, { model: 'm', max_tokens: 1, messages: [] }, { fetchImpl })) {
        /* drain */
      }
    })(),
    (error) => {
      assert.equal(error.code, 'UPSTREAM')
      assert.equal(error.detail?.message, 'Overloaded')
      return true
    },
  )
})

test('streamMessages surfaces transport failures, aborts and missing bodies distinctly', async () => {
  const route = resolvePlanRoute({ providerId: 'account:zai-start-plan', credentials: { zcodejwttoken: 'jwt' } })
  const request = { model: 'm', max_tokens: 1, messages: [] }

  const boom = /** @type {typeof fetch} */ (async () => {
    throw new TypeError('fetch failed')
  })
  await assert.rejects(
    (async () => {
      for await (const _event of streamMessages(route, request, { fetchImpl: boom })) assert.fail('no events')
    })(),
    (error) => error instanceof PlanClientError && error.code === 'TRANSPORT' && /fetch failed/u.test(error.message),
  )

  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(
    (async () => {
      for await (const _event of streamMessages(route, request, { fetchImpl: boom, signal: aborted.signal })) assert.fail('no events')
    })(),
    (error) => error instanceof PlanClientError && error.code === 'ABORTED',
  )

  const emptyBody = /** @type {typeof fetch} */ (async () => new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  await assert.rejects(
    (async () => {
      for await (const _event of streamMessages(route, request, { fetchImpl: emptyBody })) assert.fail('no events')
    })(),
    (error) => error instanceof PlanClientError && error.code === 'BAD_RESPONSE',
  )

  const garbage = /** @type {typeof fetch} */ (
    async () => new Response('not json at all', { status: 200, headers: { 'content-type': 'application/json' } })
  )
  await assert.rejects(
    (async () => {
      for await (const _event of streamMessages(route, request, { fetchImpl: garbage })) assert.fail('no events')
    })(),
    (error) => error instanceof PlanClientError && error.code === 'BAD_RESPONSE',
  )
})

// ---------------------------------------------------------------------------
// 多路由自动切换（merged 模式）
// ---------------------------------------------------------------------------

/** 一条正常产出文本的 SSE 线格式。 */
const OK_WIRE =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3},"delta":{"stop_reason":"end_turn"}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'

/** 两条候选路由（start-plan 优先，coding-plan 兜底）。 */
const CHAIN = [
  resolvePlanRoute({ providerId: 'account:zai-start-plan', credentials: { zcodejwttoken: 'jwt' } }),
  resolvePlanRoute({
    providerId: 'account:zai-individual-coding-plan',
    credentials: { zcodejwttoken: 'jwt', [planKeyFor('account:zai-individual-coding-plan')]: 'plan-key' },
  }),
]

/**
 * @param {readonly import('../lib/plan-client.js').PlanRoute[]} routes 候选链。
 * @param {import('../lib/plan-client.js').PlanFailoverOptions} [options] 参数。
 * @returns {Promise<import('../lib/plan-client.js').PlanStreamEvent[]>} 全部事件。
 */
async function drainChain(routes, options = {}) {
  /** @type {import('../lib/plan-client.js').PlanStreamEvent[]} */
  const out = []
  for await (const event of streamMessagesAcrossRoutes(routes, { model: 'm', max_tokens: 1, messages: [] }, options)) out.push(event)
  return out
}

test('isFailoverError: quota/concurrency/auth/transport are worth another route, param/abort are not', () => {
  for (const code of ['QUOTA', 'CONCURRENCY', 'AUTH', 'TOKEN_MISSING', 'API_KEY_MISSING', 'CARD_ID_MISSING', 'UPSTREAM', 'TRANSPORT', 'TIMEOUT']) {
    assert.equal(isFailoverError(new PlanClientError('x', code)), true, `${code} should fail over`)
  }
  for (const code of ['PARAM', 'ABORTED', 'BAD_RESPONSE', 'UNKNOWN_PROVIDER']) {
    assert.equal(isFailoverError(new PlanClientError('x', code)), false, `${code} must not fail over`)
  }
  assert.equal(isFailoverError(new Error('plain')), false, 'a non-PlanClientError is not a route problem')
})

test('dedupeRoutes drops a route whose request would be byte-identical (same endpoint, same credential)', () => {
  // Measured on the real release: account:zai-start-plan and account:bigmodel-start-plan share
  // the endpoint AND the single zcodejwttoken, so their requests are identical. Retrying the
  // second one costs a round trip and cannot change the outcome.
  const credentials = { zcodejwttoken: 'jwt' }
  const zaiStart = resolvePlanRoute({ providerId: 'account:zai-start-plan', credentials })
  const bigmodelStart = resolvePlanRoute({ providerId: 'account:bigmodel-start-plan', credentials })
  const zaiCoding = resolvePlanRoute({
    providerId: 'account:zai-individual-coding-plan',
    credentials: { zcodejwttoken: 'jwt', [planKeyFor('account:zai-individual-coding-plan')]: 'zai-key' },
  })
  const bigmodelCoding = resolvePlanRoute({
    providerId: 'account:bigmodel-individual-coding-plan',
    credentials: { zcodejwttoken: 'jwt', [planKeyFor('account:bigmodel-individual-coding-plan')]: 'bigmodel-key' },
  })
  const deduped = dedupeRoutes([zaiStart, bigmodelStart, zaiCoding, bigmodelCoding])
  // The two start-plan routes collapse; the two coding-plan routes stay (different baseUrl and key).
  assert.deepEqual(deduped.map((route) => route.providerId), [
    'account:zai-start-plan',
    'account:zai-individual-coding-plan',
    'account:bigmodel-individual-coding-plan',
  ])
  // The highest-priority route of a duplicate group is the one kept.
  assert.equal(dedupeRoutes([bigmodelStart, zaiStart])[0].providerId, 'account:bigmodel-start-plan')
  // An empty / malformed input degrades to an empty list, never a throw.
  assert.deepEqual(dedupeRoutes([]), [])
  assert.deepEqual(dedupeRoutes(/** @type {any} */ (null)), [])
})

test('dedupeRoutes keeps a route whose headers cannot be built (a missing card id is a real failure to report)', () => {
  // highspeed-card throws CARD_ID_MISSING from buildHeaders; silently dropping it would turn a
  // "you have no card" into "this model has no routes".
  const highspeed = resolvePlanRoute({
    providerId: 'account:zai-highspeed-card',
    credentials: {
      zcodejwttoken: 'jwt',
      [planKeyFor('account:zai-highspeed-card')]: 'hs-key',
    },
  })
  const start = resolvePlanRoute({ providerId: 'account:zai-start-plan', credentials: { zcodejwttoken: 'jwt' } })
  const deduped = dedupeRoutes([start, highspeed])
  assert.deepEqual(deduped.map((route) => route.providerId), ['account:zai-start-plan', 'account:zai-highspeed-card'])
})

test('streamMessagesAcrossRoutes walks the chain and reports each attempt', async () => {
  /** @type {string[]} */
  const urls = []
  /** @type {import('../lib/plan-client.js').PlanRouteAttempt[]} */
  const attempts = []
  const fetchImpl = /** @type {typeof fetch} */ (async (url) => {
    urls.push(String(url))
    if (urls.length === 1) return new Response('{"code":1005,"msg":"exceed quota limit"}', { status: 200, headers: { 'content-type': 'application/json' } })
    return sseResponse([new TextEncoder().encode(OK_WIRE)])
  })
  const events = await drainChain(CHAIN, { fetchImpl, onAttempt: (attempt) => attempts.push(attempt) })
  assert.deepEqual(urls, [
    'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',
    'https://api.z.ai/api/anthropic/v1/messages',
  ])
  assert.deepEqual(attempts.map((attempt) => [attempt.providerId, attempt.ok, attempt.failover]), [
    ['account:zai-start-plan', false, true],
    ['account:zai-individual-coding-plan', true, undefined],
  ])
  assert.ok(events.some((event) => event.type === 'text' && event.delta === 'pong'))
  assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'end_turn' })
})

test('streamMessagesAcrossRoutes buffers until the route proves it has content', async () => {
  // The first route emits usage then dies without ever producing content. None of it may reach
  // the caller: a half-turn from a failed route would look like a real answer.
  const wire = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":0}}}\n\n'
  const fetchImpl = /** @type {typeof fetch} */ (async (url) => {
    if (String(url).includes('zcode-plan')) return sseResponse([new TextEncoder().encode(wire)])
    return sseResponse([new TextEncoder().encode(OK_WIRE)])
  })
  const events = await drainChain(CHAIN, { fetchImpl })
  // Every usage event belongs to the route that actually answered (input_tokens 7, not the
  // failed route's 9). A leaked 9 would mean the buffered attempt was flushed.
  const usages = events.filter((event) => event.type === 'usage')
  assert.ok(usages.length > 0)
  for (const usage of usages) assert.equal(usage.inputTokens, 7, 'the failed route contributed no events')
  assert.ok(events.some((event) => event.type === 'text' && event.delta === 'pong'))
})

test('streamMessagesAcrossRoutes does not switch once content has been committed', async () => {
  // A mid-stream failure after content must surface, not silently restart on another route.
  const wire =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n' +
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
  let calls = 0
  const fetchImpl = /** @type {typeof fetch} */ (async () => {
    calls += 1
    return sseResponse([new TextEncoder().encode(wire)])
  })
  await assert.rejects(drainChain(CHAIN, { fetchImpl }), (error) => {
    assert.equal(error.code, 'UPSTREAM')
    return true
  })
  assert.equal(calls, 1, 'a committed route must not be retried elsewhere')
})

test('streamMessagesAcrossRoutes throws the last error with the full attempt chain attached', async () => {
  let calls = 0
  const fetchImpl = /** @type {typeof fetch} */ (async () => {
    calls += 1
    return new Response('{"code":1005,"msg":"exceed quota limit"}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  await assert.rejects(drainChain(CHAIN, { fetchImpl }), (error) => {
    assert.equal(error.code, 'QUOTA')
    assert.equal(error.attempts?.length, 2)
    assert.deepEqual(error.attempts.map((attempt) => attempt.providerId), [
      'account:zai-start-plan',
      'account:zai-individual-coding-plan',
    ])
    return true
  })
  assert.equal(calls, 2)
})

test('streamMessagesAcrossRoutes rejects an empty chain instead of silently doing nothing', async () => {
  await assert.rejects(drainChain([]), (error) => error.code === 'UNKNOWN_PROVIDER')
})

test('streamMessagesAcrossRoutes treats an empty answer as a failed route and moves on', async () => {
  // A route that returns "no content at all" is not an answer; the next route may do better.
  const empty = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  /** @type {import('../lib/plan-client.js').PlanRouteAttempt[]} */
  const attempts = []
  const fetchImpl = /** @type {typeof fetch} */ (async (url) => {
    if (String(url).includes('zcode-plan')) return sseResponse([new TextEncoder().encode(empty)])
    return sseResponse([new TextEncoder().encode(OK_WIRE)])
  })
  const events = await drainChain(CHAIN, { fetchImpl, onAttempt: (attempt) => attempts.push(attempt) })
  assert.equal(attempts[0].code, 'EMPTY_RESPONSE')
  assert.equal(attempts[0].failover, true)
  assert.ok(events.some((event) => event.type === 'text' && event.delta === 'pong'))
})
