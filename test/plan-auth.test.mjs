/**
 * `lib/plan-auth.js` 的离线单测。
 *
 * 这里**不发任何真实网络请求**：`fetch` 全部注入假实现，时钟与睡眠也注入。
 * 真实端点的验证放在 `verify/` 的端到端脚本里（那需要真人点浏览器，不适合单测）。
 *
 * 覆盖点：
 * - pollToken 生成（64 字符 hex，与客户端 `randomBytes(32).toString('hex')` 一致）
 * - family 校验（只接受 zai / bigmodel）
 * - init / poll 的 URL 构造
 * - `parseInitPayload` 的硬校验（https、有限数、interval >= 1、缺字段）
 * - `parsePollPayload` 的三种状态、驼峰兼容、3004 不可重试、缺字段
 * - `toCredentialRecord` 的键名与客户端一致
 * - `pollUntilReady` 的调度语义（间隔下限、超时、failed、可重试 vs 不可重试）
 * - AES-GCM 加解密往返、信封格式、篡改检测
 * - `PluginCredentialStore` 的原子写、合并、缺失文件
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  AUTH_FAMILIES,
  DEFAULT_AUTH_ORIGIN,
  ENC_PREFIX,
  MIN_POLL_INTERVAL_MS,
  PlanAuthError,
  PluginCredentialStore,
  createPollToken,
  credentialSecret,
  decryptValue,
  deriveKey,
  encryptCredentialRecord,
  encryptValue,
  initUrl,
  normalizeFamily,
  parseInitPayload,
  parsePollPayload,
  pollUntilReady,
  pollUrl,
  requestJson,
  startDeviceAuthorization,
  stripTrailingSlash,
  toCredentialRecord,
} from '../lib/plan-auth.js'

/** 构造一个固定响应的假 fetch。 */
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    const reply = await handler(String(url), init, calls.length)
    if (reply instanceof Error) throw reply
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})
    return {
      ok: reply.status === undefined ? true : reply.status >= 200 && reply.status < 300,
      status: reply.status ?? 200,
      async text() {
        return body
      },
    }
  }
  impl.calls = calls
  return impl
}

const INIT_DATA = {
  flow_id: 'f089a2c5503a5f1853df3f97231426e7',
  poll_token: 'a'.repeat(64),
  authorize_url: 'https://chat.z.ai/api/oauth/authorize?client_id=x&redirect_uri=y&state=z&response_type=code',
  expires_at: 1_793_090_455,
  poll_interval_sec: 2,
}

// ── pollToken ────────────────────────────────────────────────────────────────

test('createPollToken 生成 64 字符小写 hex', () => {
  const token = createPollToken()
  assert.equal(token.length, 64)
  assert.match(token, /^[0-9a-f]{64}$/u)
})

test('createPollToken 可注入随机源', () => {
  const token = createPollToken(() => Buffer.alloc(32, 0xab))
  assert.equal(token, 'ab'.repeat(32))
})

// ── family ───────────────────────────────────────────────────────────────────

test('normalizeFamily 只接受 zai / bigmodel', () => {
  assert.equal(normalizeFamily('zai'), 'zai')
  assert.equal(normalizeFamily('bigmodel'), 'bigmodel')
  for (const bad of ['bogus', '', undefined, null, 1, 'ZAI']) {
    assert.throws(() => normalizeFamily(bad), (error) => {
      assert.ok(error instanceof PlanAuthError)
      assert.equal(error.code, 'INVALID_FAMILY')
      return true
    })
  }
})

test('AUTH_FAMILIES 恰好两个家族', () => {
  assert.deepEqual([...AUTH_FAMILIES], ['zai', 'bigmodel'])
})

// ── URL ──────────────────────────────────────────────────────────────────────

test('initUrl / pollUrl 拼接正确且去尾斜杠', () => {
  assert.equal(initUrl(), `${DEFAULT_AUTH_ORIGIN}/api/v1/oauth/cli/init`)
  assert.equal(initUrl('https://example.test/'), 'https://example.test/api/v1/oauth/cli/init')
  assert.equal(pollUrl('abc'), `${DEFAULT_AUTH_ORIGIN}/api/v1/oauth/cli/poll/abc`)
  assert.equal(stripTrailingSlash('https://x.test///'), 'https://x.test')
})

test('pollUrl 对 flow_id 做 URL 编码', () => {
  assert.equal(pollUrl('a/b c'), `${DEFAULT_AUTH_ORIGIN}/api/v1/oauth/cli/poll/a%2Fb%20c`)
})

// ── parseInitPayload ─────────────────────────────────────────────────────────

test('parseInitPayload 接受合法响应', () => {
  const init = parseInitPayload({ code: 0, msg: '', data: INIT_DATA })
  assert.equal(init.flowId, INIT_DATA.flow_id)
  assert.equal(init.authorizeUrl, INIT_DATA.authorize_url)
  assert.equal(init.expiresAt, INIT_DATA.expires_at)
  assert.equal(init.pollIntervalSec, 2)
})

test('parseInitPayload 拒绝非零业务码', () => {
  assert.throws(() => parseInitPayload({ code: 1000, msg: 'something went wrong' }), (error) => {
    assert.equal(error.code, 'INIT_FAILED')
    assert.equal(error.businessCode, 1000)
    return true
  })
})

test('parseInitPayload 拒绝非 https 的 authorize_url', () => {
  const data = { ...INIT_DATA, authorize_url: 'http://chat.z.ai/x' }
  assert.throws(() => parseInitPayload({ code: 0, data }), (error) => {
    assert.equal(error.code, 'INIT_MALFORMED')
    return true
  })
})

test('parseInitPayload 拒绝缺失或非有限的 expires_at', () => {
  for (const expiresAt of [undefined, null, '123', Number.NaN, Number.POSITIVE_INFINITY]) {
    const data = { ...INIT_DATA, expires_at: expiresAt }
    assert.throws(() => parseInitPayload({ code: 0, data }), (error) => {
      assert.equal(error.code, 'INIT_MALFORMED')
      return true
    })
  }
})

test('parseInitPayload 拒绝 poll_interval_sec < 1', () => {
  for (const interval of [0, 0.5, -1, undefined, '2']) {
    const data = { ...INIT_DATA, poll_interval_sec: interval }
    assert.throws(() => parseInitPayload({ code: 0, data }), (error) => {
      assert.equal(error.code, 'INIT_MALFORMED')
      return true
    })
  }
})

test('parseInitPayload 拒绝缺失 flow_id', () => {
  const data = { ...INIT_DATA, flow_id: '   ' }
  assert.throws(() => parseInitPayload({ code: 0, data }), (error) => {
    assert.equal(error.code, 'INIT_MALFORMED')
    return true
  })
})

// ── parsePollPayload ────────────────────────────────────────────────────────

const READY = {
  code: 0,
  data: {
    status: 'ready',
    token: 'zcode-jwt-value',
    user: { user_id: '27631789178572539', name: 'tester', email: 'a@b.c' },
    zai: { access_token: 'zai-access', refresh_token: 'zai-refresh' },
  },
}

test('parsePollPayload 解析 pending / failed', () => {
  assert.deepEqual(parsePollPayload({ code: 0, data: { status: 'pending' } }, 'zai'), { status: 'pending' })
  assert.deepEqual(parsePollPayload({ code: 0, data: { status: 'failed' } }, 'zai'), { status: 'failed' })
})

test('parsePollPayload 解析 ready（下划线写法）', () => {
  const ready = parsePollPayload(READY, 'zai')
  assert.equal(ready.status, 'ready')
  assert.equal(ready.token, 'zcode-jwt-value')
  assert.equal(ready.accessToken, 'zai-access')
  assert.equal(ready.refreshToken, 'zai-refresh')
  assert.deepEqual(ready.user, { userId: '27631789178572539', name: 'tester', email: 'a@b.c' })
})

test('parsePollPayload 兼容驼峰写法', () => {
  const payload = {
    code: 0,
    data: {
      status: 'ready',
      token: 'jwt',
      user: { user_id: 'u1' },
      bigmodel: { accessToken: 'camel-access', refreshToken: 'camel-refresh' },
    },
  }
  const ready = parsePollPayload(payload, 'bigmodel')
  assert.equal(ready.accessToken, 'camel-access')
  assert.equal(ready.refreshToken, 'camel-refresh')
})

test('parsePollPayload 用 family 作为 data 的 key，不是固定 zai', () => {
  const payload = {
    code: 0,
    data: { status: 'ready', token: 'jwt', user: { user_id: 'u1' }, bigmodel: { access_token: 'bm' } },
  }
  assert.throws(() => parsePollPayload(payload, 'zai'), (error) => {
    assert.equal(error.code, 'POLL_MALFORMED')
    return true
  })
  assert.equal(parsePollPayload(payload, 'bigmodel').accessToken, 'bm')
})

test('parsePollPayload 拒绝缺 data.token / user_id / access_token', () => {
  const cases = [
    { ...READY, data: { ...READY.data, token: '' } },
    { ...READY, data: { ...READY.data, user: {} } },
    { ...READY, data: { ...READY.data, zai: {} } },
  ]
  for (const payload of cases) {
    assert.throws(() => parsePollPayload(payload, 'zai'), (error) => {
      assert.equal(error.code, 'POLL_MALFORMED')
      return true
    })
  }
})

test('parsePollPayload 把 3004 标成不可重试的 FLOW_INVALID', () => {
  assert.throws(() => parsePollPayload({ code: 3004, msg: 'invalid_flow' }, 'zai'), (error) => {
    assert.equal(error.code, 'FLOW_INVALID')
    assert.equal(error.retryable, false)
    assert.equal(error.businessCode, 3004)
    return true
  })
})

test('parsePollPayload 其它业务码标成可重试', () => {
  assert.throws(() => parsePollPayload({ code: 9999, msg: 'boom' }, 'zai'), (error) => {
    assert.equal(error.code, 'POLL_FAILED')
    assert.equal(error.retryable, true)
    return true
  })
})

// ── toCredentialRecord ──────────────────────────────────────────────────────

test('toCredentialRecord 的键名与 ZCode 客户端一致', () => {
  const ready = parsePollPayload(READY, 'zai')
  const record = toCredentialRecord(ready, 'zai')
  assert.equal(record.zcodejwttoken, 'zcode-jwt-value')
  assert.equal(record['oauth:active_provider'], 'zai')
  assert.equal(record['oauth:zai:access_token'], 'zai-access')
  assert.equal(record['oauth:zai:refresh_token'], 'zai-refresh')
  const info = JSON.parse(record['oauth:zai:user_info'])
  assert.equal(info.user_id, '27631789178572539')
})

test('toCredentialRecord 在无 refresh_token 时不写该键', () => {
  const ready = parsePollPayload({ code: 0, data: { ...READY.data, zai: { access_token: 'x' } } }, 'zai')
  const record = toCredentialRecord(ready, 'zai')
  assert.equal('oauth:zai:refresh_token' in record, false)
})

// ── pollUntilReady ──────────────────────────────────────────────────────────

/** 构造一个可编排的轮询序列。 */
function scriptedPoll(results) {
  let index = 0
  return async () => {
    const next = results[Math.min(index, results.length - 1)]
    index += 1
    if (next instanceof Error) throw next
    return next
  }
}

test('pollUntilReady 在第一次就 ready 时直接返回', async () => {
  const ready = parsePollPayload(READY, 'zai')
  const result = await pollUntilReady({
    poll: scriptedPoll([ready]),
    expiresAt: 9_999_999_999,
    pollIntervalSec: 2,
    sleep: async () => {},
  })
  assert.equal(result.token, 'zcode-jwt-value')
})

test('pollUntilReady 跳过 pending 直到 ready', async () => {
  const pending = { status: 'pending' }
  const ready = parsePollPayload(READY, 'zai')
  const sleeps = []
  const result = await pollUntilReady({
    poll: scriptedPoll([pending, pending, ready]),
    expiresAt: 9_999_999_999,
    pollIntervalSec: 2,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  assert.equal(result.token, 'zcode-jwt-value')
  // 间隔 = max(1000, 2 * 1000) = 2000
  assert.deepEqual(sleeps, [2000, 2000])
})

test('pollUntilReady 把间隔下限钉在 1000ms', async () => {
  const sleeps = []
  const pending = { status: 'pending' }
  const ready = parsePollPayload(READY, 'zai')
  await pollUntilReady({
    poll: scriptedPoll([pending, ready]),
    expiresAt: 9_999_999_999,
    pollIntervalSec: 0.1,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  assert.deepEqual(sleeps, [MIN_POLL_INTERVAL_MS])
})

test('pollUntilReady 在 failed 时抛 AUTH_FAILED', async () => {
  await assert.rejects(
    () => pollUntilReady({
      poll: scriptedPoll([{ status: 'failed' }]),
      expiresAt: 9_999_999_999,
      pollIntervalSec: 2,
      sleep: async () => {},
    }),
    (error) => {
      assert.equal(error.code, 'AUTH_FAILED')
      return true
    },
  )
})

test('pollUntilReady 在超过 expires_at 时抛 AUTH_TIMEOUT', async () => {
  let clock = 0
  await assert.rejects(
    () => pollUntilReady({
      poll: scriptedPoll([{ status: 'pending' }]),
      expiresAt: 10,
      pollIntervalSec: 1,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    }),
    (error) => {
      assert.equal(error.code, 'AUTH_TIMEOUT')
      return true
    },
  )
})

test('pollUntilReady 重试 429 / 5xx，但不重试 3004', async () => {
  const ready = parsePollPayload(READY, 'zai')
  const retryable = new PlanAuthError('rate limited', 'POLL_FAILED', { httpStatus: 429, retryable: true })
  const result = await pollUntilReady({
    poll: scriptedPoll([retryable, ready]),
    expiresAt: 9_999_999_999,
    pollIntervalSec: 1,
    sleep: async () => {},
  })
  assert.equal(result.token, 'zcode-jwt-value')

  const invalidFlow = new PlanAuthError('invalid flow', 'FLOW_INVALID', { businessCode: 3004, retryable: false })
  await assert.rejects(
    () => pollUntilReady({
      poll: scriptedPoll([invalidFlow]),
      expiresAt: 9_999_999_999,
      pollIntervalSec: 1,
      sleep: async () => {},
    }),
    (error) => {
      assert.equal(error.code, 'FLOW_INVALID')
      return true
    },
  )
})

test('pollUntilReady 在 signal 已中止时立刻失败', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => pollUntilReady({
      poll: scriptedPoll([{ status: 'pending' }]),
      expiresAt: 9_999_999_999,
      pollIntervalSec: 1,
      signal: controller.signal,
      sleep: async () => {},
    }),
    (error) => {
      assert.equal(error.code, 'AUTH_TIMEOUT')
      return true
    },
  )
})

// ── 加解密 ──────────────────────────────────────────────────────────────────

test('encryptValue / decryptValue 往返', () => {
  const secret = 'zcodejwttoken-value'
  const cipher = encryptValue(secret)
  assert.ok(cipher.startsWith(ENC_PREFIX))
  assert.equal(cipher.slice(ENC_PREFIX.length).split('.').length, 3)
  assert.equal(decryptValue(cipher), secret)
})

test('encryptValue 每次的 IV 都不同', () => {
  const a = encryptValue('same')
  const b = encryptValue('same')
  assert.notEqual(a, b)
  assert.equal(decryptValue(a), decryptValue(b))
})

test('decryptValue 对非密文原样返回，对篡改返回 null', () => {
  assert.equal(decryptValue('plain'), 'plain')
  const cipher = encryptValue('secret')
  const parts = cipher.slice(ENC_PREFIX.length).split('.')
  const tampered = `${ENC_PREFIX}${parts[0]}.${parts[1]}.${Buffer.from('tampered').toString('base64url')}`
  assert.equal(decryptValue(tampered), null)
  assert.equal(decryptValue(`${ENC_PREFIX}garbage`), null)
})

test('deriveKey 是 SHA-256 单轮，与客户端一致', () => {
  assert.equal(deriveKey('abc').length, 32)
  assert.equal(deriveKey('abc').toString('hex'), deriveKey('abc').toString('hex'))
  assert.notEqual(deriveKey('abc').toString('hex'), deriveKey('abd').toString('hex'))
})

test('credentialSecret 用机器指纹，且可被 ZCODE_CREDENTIAL_SECRET 覆盖', () => {
  const original = process.env.ZCODE_CREDENTIAL_SECRET
  try {
    delete process.env.ZCODE_CREDENTIAL_SECRET
    assert.match(credentialSecret(), /^zcode-credential-fallback:/u)
    process.env.ZCODE_CREDENTIAL_SECRET = 'explicit'
    assert.equal(credentialSecret(), 'explicit')
    assert.equal(credentialSecret('inline'), 'inline')
  } finally {
    if (original === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET
    else process.env.ZCODE_CREDENTIAL_SECRET = original
  }
})

test('encryptCredentialRecord 加密全部条目', () => {
  const record = { a: '1', b: '2' }
  const encrypted = encryptCredentialRecord(record)
  assert.ok(encrypted.a.startsWith(ENC_PREFIX))
  assert.ok(encrypted.b.startsWith(ENC_PREFIX))
  assert.equal(decryptValue(encrypted.a), '1')
})

// ── PluginCredentialStore ───────────────────────────────────────────────────

/** 建一个临时目录，返回路径与清理函数。 */
function withTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'zcode-plan-auth-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('PluginCredentialStore 文件不存在时读到空对象', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const store = new PluginCredentialStore({ filePath: path.join(dir, 'missing.json') })
    assert.deepEqual(store.read(), {})
  } finally {
    cleanup()
  }
})

test('PluginCredentialStore merge 加密落盘并可读回', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const filePath = path.join(dir, 'nested', 'credentials.json')
    const store = new PluginCredentialStore({ filePath })
    const merged = store.merge({ zcodejwttoken: 'jwt-value' })
    assert.equal(merged.zcodejwttoken, 'jwt-value')
    // 落盘的必须是密文，不能有明文
    const onDisk = readFileSync(filePath, 'utf8')
    assert.ok(onDisk.includes(ENC_PREFIX))
    assert.equal(onDisk.includes('jwt-value'), false)
    assert.deepEqual(store.read(), { zcodejwttoken: 'jwt-value' })
  } finally {
    cleanup()
  }
})

test('PluginCredentialStore merge 保留未提及的旧条目', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const store = new PluginCredentialStore({ filePath: path.join(dir, 'credentials.json') })
    store.merge({ zcodejwttoken: 'jwt' })
    const merged = store.merge({ 'oauth:active_provider': 'zai' })
    assert.deepEqual(merged, { zcodejwttoken: 'jwt', 'oauth:active_provider': 'zai' })
    assert.deepEqual(store.read(), merged)
  } finally {
    cleanup()
  }
})

test('PluginCredentialStore encrypt:false 时明文落盘', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const filePath = path.join(dir, 'plain.json')
    const store = new PluginCredentialStore({ filePath, encrypt: false })
    store.merge({ zcodejwttoken: 'plain-jwt' })
    assert.ok(readFileSync(filePath, 'utf8').includes('plain-jwt'))
    assert.deepEqual(store.read(), { zcodejwttoken: 'plain-jwt' })
  } finally {
    cleanup()
  }
})

test('PluginCredentialStore 对损坏的 JSON 抛 CREDENTIAL_STORE', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const filePath = path.join(dir, 'bad.json')
    writeFileSync(filePath, 'not json', 'utf8')
    const store = new PluginCredentialStore({ filePath })
    assert.throws(() => store.read(), (error) => {
      assert.equal(error.code, 'CREDENTIAL_STORE')
      return true
    })
  } finally {
    cleanup()
  }
})

// ── startDeviceAuthorization / requestJson ──────────────────────────────────

test('startDeviceAuthorization 发 POST init 并返回 poll 句柄', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith('/oauth/cli/init')) return { status: 200, body: { code: 0, data: INIT_DATA } }
    return { status: 200, body: { code: 0, data: { status: 'pending' } } }
  })
  const flow = await startDeviceAuthorization({ family: 'zai', fetchImpl })
  assert.equal(flow.family, 'zai')
  assert.equal(flow.flowId, INIT_DATA.flow_id)
  assert.equal(flow.authorizeUrl, INIT_DATA.authorize_url)

  const initCall = fetchImpl.calls[0]
  assert.equal(initCall.init.method, 'POST')
  assert.match(initCall.init.headers.authorization, /^Bearer [0-9a-f]{64}$/u)
  assert.deepEqual(JSON.parse(initCall.init.body), { provider: 'zai' })

  assert.deepEqual(await flow.poll(), { status: 'pending' })
  const pollCall = fetchImpl.calls[1]
  assert.equal(pollCall.init.method, 'GET')
  assert.ok(pollCall.url.endsWith(`/oauth/cli/poll/${INIT_DATA.flow_id}`))
})

test('startDeviceAuthorization 拒绝非法 family', async () => {
  await assert.rejects(
    () => startDeviceAuthorization({ family: 'bogus', fetchImpl: fakeFetch(() => ({ status: 200, body: {} })) }),
    (error) => {
      assert.equal(error.code, 'INVALID_FAMILY')
      return true
    },
  )
})

test('requestJson 把 HTTP 错误翻译成带 httpStatus 的 PlanAuthError', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 401, body: { code: 3004, msg: 'invalid_flow' } }))
  await assert.rejects(
    () => requestJson(fetchImpl, 'https://x.test/y', { method: 'GET', headers: {}, timeoutMs: 1000 }),
    (error) => {
      assert.equal(error.httpStatus, 401)
      assert.equal(error.businessCode, 3004)
      return true
    },
  )
})

test('requestJson 对非 JSON 响应抛 INVALID_RESPONSE', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 200, body: '<html>nope</html>' }))
  await assert.rejects(
    () => requestJson(fetchImpl, 'https://x.test/y', { method: 'GET', headers: {}, timeoutMs: 1000 }),
    (error) => {
      assert.equal(error.code, 'INVALID_RESPONSE')
      return true
    },
  )
})

test('requestJson 把网络异常翻译成 NETWORK', async () => {
  const fetchImpl = fakeFetch(() => Object.assign(new Error('boom'), { cause: { code: 'ECONNREFUSED' } }))
  await assert.rejects(
    () => requestJson(fetchImpl, 'https://x.test/y', { method: 'GET', headers: {}, timeoutMs: 1000 }),
    (error) => {
      assert.equal(error.code, 'NETWORK')
      return true
    },
  )
})
