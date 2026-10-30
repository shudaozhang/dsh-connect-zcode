/**
 * 客户端指纹层的行为契约。
 *
 * 这些断言全部对应 2026-10-31 的实测（客户端 3.17.1，真实额度到账后）：
 * 每一项都曾经用真实网络请求验证过「通过 / 被 405-3012 拦」的边界，测试把它们锁住，
 * 避免以后重构时又退回「只发 Bearer + 单个 system 字符串」那种必被拦的形态。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CLIENT_VERSION,
  PREAMBLE_BODY,
  PREAMBLE_HEAD,
  PREAMBLE_MIN_CHARS,
  USER_AGENT_PREFIX,
  applyClientHeaders,
  buildClientSystem,
  checkClientHeaders,
  requiresClientFingerprint,
  upgradeRequestSystem,
  withClientPreamble,
} from '../lib/plan-preamble.js'

test('the preamble is the real client text, long enough to pass the measured boundary', () => {
  assert.equal(PREAMBLE_HEAD, 'You are ZCode, an interactive agent')
  // 实测边界：1228 字符失败、1232 通过。完整 preamble 必须显著超过它。
  assert.equal(PREAMBLE_BODY.length, 2608)
  assert.equal(PREAMBLE_BODY.length > PREAMBLE_MIN_CHARS, true)
  assert.match(PREAMBLE_BODY, /# Harness/u)
  assert.match(PREAMBLE_BODY, /# ZCode Desktop Context/u)
})

test('buildClientSystem returns a block array, never a string, with the prompt last', () => {
  const blocks = buildClientSystem('You are DSH.')
  // 实测：4 块被 405 拦，2–3 块通过。
  assert.equal(blocks.length, 3)
  assert.equal(Array.isArray(blocks), true)
  assert.equal(blocks[0].text, PREAMBLE_HEAD)
  assert.equal(blocks[1].text, PREAMBLE_BODY)
  assert.equal(blocks[2].text, 'You are DSH.')
})

test('buildClientSystem stays within the block limit when there is no real prompt', () => {
  for (const empty of ['', '   ', undefined, null, 42]) {
    const blocks = buildClientSystem(/** @type {any} */ (empty))
    assert.equal(blocks.length, 2, `no prompt should yield exactly 2 blocks (got ${blocks.length})`)
    assert.equal(blocks[1].text, PREAMBLE_BODY)
  }
})

test('buildClientSystem never emits a fourth block, even for a huge prompt', () => {
  // 实测：4 块 → 405。真实 prompt 无论多长都只占最后一块。
  const blocks = buildClientSystem('x'.repeat(50_000))
  assert.equal(blocks.length, 3)
  assert.equal(blocks[2].text.length, 50_000)
})

test('withClientPreamble is the string-in / blocks-out entry point', () => {
  assert.deepEqual(withClientPreamble('hello').map((b) => b.text), [PREAMBLE_HEAD, PREAMBLE_BODY, 'hello'])
})

test('upgradeRequestSystem converts a string system and leaves a block array alone', () => {
  const stringRequest = { model: 'GLM-5.3-Flash', max_tokens: 32, system: 'You are DSH.', messages: [] }
  const upgraded = upgradeRequestSystem(stringRequest)
  assert.equal(Array.isArray(/** @type {any} */ (upgraded).system), true)
  assert.equal(/** @type {any} */ (upgraded).system.length, 3)
  assert.equal(stringRequest.system, 'You are DSH.', 'the input object must not be mutated')

  const arrayRequest = { model: 'm', max_tokens: 1, system: [{ type: 'text', text: 'x' }], messages: [] }
  assert.equal(upgradeRequestSystem(arrayRequest), arrayRequest, 'an already-compliant body is passed through')

  const noSystem = { model: 'm', max_tokens: 1, messages: [] }
  const fixed = upgradeRequestSystem(noSystem)
  // 实测：没有 preamble 一律 405，所以缺 system 时也必须补上。
  assert.equal(Array.isArray(/** @type {any} */ (fixed).system), true)
  assert.equal(/** @type {any} */ (fixed).system.length, 2)
})

test('requiresClientFingerprint only guards the zcode.z.ai plan origins', () => {
  assert.equal(requiresClientFingerprint('https://zcode.z.ai/api/v1/zcode-plan/anthropic'), true)
  assert.equal(requiresClientFingerprint('https://zcode.z.ai/api/v1/off-peak/anthropic'), true)
  assert.equal(requiresClientFingerprint('https://zcode.z.ai/api/v1/highspeed/anthropic'), true)
  // 这些端点不需要指纹层，加头反而可能触发别的校验。
  assert.equal(requiresClientFingerprint('https://api.z.ai/api/anthropic'), false)
  assert.equal(requiresClientFingerprint('https://open.bigmodel.cn/api/anthropic'), false)
  assert.equal(requiresClientFingerprint(''), false)
  assert.equal(requiresClientFingerprint('not a url'), false)
})

test('applyClientHeaders adds the three measured-required headers', () => {
  const headers = {}
  const out = applyClientHeaders(headers, 'jwt-token')
  // 实测：只有 authorization → 405；只有 x-api-key → 401；两者都要。
  assert.equal(out.authorization, 'Bearer jwt-token')
  assert.equal(out['x-api-key'], 'jwt-token')
  assert.equal(out['user-agent'].startsWith(USER_AGENT_PREFIX), true)
  assert.equal(checkClientHeaders(out).ok, true)
})

test('applyClientHeaders accepts a token that already carries the Bearer prefix', () => {
  const out = applyClientHeaders({}, 'Bearer jwt-token')
  assert.equal(out.authorization, 'Bearer jwt-token', 'the prefix must not be doubled')
  assert.equal(out['x-api-key'], 'jwt-token')
})

test('applyClientHeaders honours an explicit client version and falls back safely', () => {
  assert.match(applyClientHeaders({}, 't', '9.9.9')['user-agent'], /^ZCode\/9\.9\.9 /u)
  assert.match(applyClientHeaders({}, 't', '')['user-agent'], new RegExp(`^ZCode/${DEFAULT_CLIENT_VERSION.replace(/\./gu, '\\.')} `, 'u'))
})

test('checkClientHeaders names every missing fingerprint header', () => {
  assert.deepEqual(checkClientHeaders({}), {
    ok: false,
    missing: ['authorization', 'x-api-key', 'user-agent'],
  })
  assert.deepEqual(checkClientHeaders({ authorization: 'Bearer x' }), {
    ok: false,
    missing: ['x-api-key', 'user-agent'],
  })
  // 大小写不敏感：真实请求头就是这个形状。
  assert.equal(checkClientHeaders({ Authorization: 'Bearer x', 'X-Api-Key': 'x', 'User-Agent': 'ZCode/3.17.1' }).ok, true)
})
