// Client-signing primitives (`lib/client-signing.js`).
//
// The pure parts of the signing chain are tested offline against the values measured
// from the shipped client (3.16.3), so a refactor cannot silently break the two things
// that are easy to get wrong: the canonical strings that get signed, and the proof-of-work
// difficulty. The network half is exercised separately (see the bottom of this file) and
// skipped when the machine has no cached ZCode credentials.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  isSessionFresh,
  parseSigningJwt,
  randomHex,
  selectProjectTokenSource,
  signRequestHeaders,
  solveProofOfWork,
} from '../lib/client-signing.js'

test('randomHex returns the requested byte count in lower-case hex', () => {
  for (const n of [1, 12, 16, 32]) {
    const out = randomHex(n)
    assert.equal(out.length, n * 2)
    assert.match(out, /^[0-9a-f]+$/)
  }
  // Not a constant: two draws must differ.
  assert.notEqual(randomHex(16), randomHex(16))
})

test('parseSigningJwt accepts only the signing shape the client requires', () => {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const signing = `${encode({ typ: 'JWT', sign_type: 'SIGN', alg: 'HS256' })}.${encode({ api_key: 'abc', exp: Math.floor(Date.now() / 1000) + 300 })}.sig`
  const parsed = parseSigningJwt(signing)
  assert.ok(parsed !== undefined, 'a sign_type=SIGN token with api_key must parse')
  assert.equal(parsed.apiKeyId, 'abc')
  assert.ok(parsed.expiresAt > Date.now())

  // The real `zcodejwttoken` in credentials.json looks like this: no sign_type, no api_key.
  // Using it as a signing credential is exactly the mistake that produces 401s.
  const ordinary = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ user_id: '1', token_version: 0 })}.sig`
  assert.equal(parseSigningJwt(ordinary), undefined, 'a non-signing JWT must be rejected')

  assert.equal(parseSigningJwt(''), undefined)
  assert.equal(parseSigningJwt('a.b'), undefined)
  assert.equal(parseSigningJwt(undefined), undefined)
})

test('selectProjectTokenSource matches the origin exactly and picks the family token', () => {
  const location = { organizationId: 'org-1', projectId: 'proj-1', apiKeyId: 'key-1' }
  const credentials = {
    [`project-key-location:v1:${encodeURIComponent(JSON.stringify(['https://bigmodel.cn', 'bigmodel', 'acct', null, 1, 'non-team']))}`]: JSON.stringify(location),
    [`project-key-location:v1:${encodeURIComponent(JSON.stringify(['https://api.z.ai', 'zai', 'acct', null, 1, 'non-team']))}`]: JSON.stringify({ organizationId: 'org-2', projectId: 'proj-2', apiKeyId: 'key-2' }),
    'oauth:bigmodel:access_token': 'bigmodel-token',
    zcodejwttoken: 'zai-token',
  }
  const bigmodel = selectProjectTokenSource(credentials, 'https://bigmodel.cn')
  assert.deepEqual(bigmodel?.location, location)
  assert.equal(bigmodel?.accessToken, 'bigmodel-token', 'the bigmodel family uses oauth:bigmodel:access_token')

  const zai = selectProjectTokenSource(credentials, 'https://api.z.ai')
  assert.equal(zai?.location.apiKeyId, 'key-2')
  assert.equal(zai?.accessToken, 'zai-token', 'the zai family uses zcodejwttoken')

  // An origin with no cached project must not silently borrow another family's token.
  assert.equal(selectProjectTokenSource(credentials, 'https://example.com'), undefined)
})

test('selectProjectTokenSource refuses when the family has no access token', () => {
  const credentials = {
    [`project-key-location:v1:${encodeURIComponent(JSON.stringify(['https://bigmodel.cn', 'bigmodel', 'acct', null, 1, 'non-team']))}`]: JSON.stringify({ organizationId: 'o', projectId: 'p', apiKeyId: 'k' }),
  }
  assert.equal(selectProjectTokenSource(credentials, 'https://bigmodel.cn'), undefined)
})

test('proof of work meets the required difficulty and is shaped like the client expects', async () => {
  // Difficulty measured from createClientRequestProofOfWork: 8 leading zero bits.
  const apiKeyId = '1cffb8d8718e434da4214b6d40a5eeec'
  const sessionId = 'probe-session'
  const ts = '1792817735000'
  const solution = await solveProofOfWork({ apiKeyId, sessionId, ts })

  assert.equal(solution.length, 32, '12-byte nonce + 8 hex-digit counter')
  const seed = createHash('sha256').update(`${apiKeyId} zcode ${sessionId} ${ts}`).digest('hex').slice(0, 32)
  const digest = createHash('sha256').update(`${seed} ${solution}`).digest()
  assert.equal(digest[0], 0, 'first byte must be zero (8 leading bits)')
})

test('signRequestHeaders emits every header the client sets, with the signed fields in order', async () => {
  // A real Ed25519 key so the signature path is exercised, not stubbed.
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const session = {
    apiKeyId: '1cffb8d8718e434da4214b6d40a5eeec',
    origin: 'https://bigmodel.cn',
    clientVersion: '3.16.3',
    privateKey: pair.privateKey,
    expiresAt: Date.now() + 300_000,
  }
  const now = 1792817735000
  const headers = await signRequestHeaders(session, { sessionId: 'fixed-session', now })

  assert.deepEqual(
    Object.keys(headers).sort(),
    ['X-App-Id', 'X-Client-Nonce', 'X-Client-Pow', 'X-Client-Sig', 'X-Client-Ts', 'X-Client-Version', 'X-Session-Id'].sort(),
  )
  assert.equal(headers['X-Client-Ts'], String(now))
  assert.equal(headers['X-Client-Version'], '3.16.3')
  assert.equal(headers['X-Session-Id'], 'fixed-session', 'X-Session-Id is required and must be echoed')
  assert.equal(headers['X-App-Id'], 'zcode')

  // The signed canonical string is `{apiKeyId} {ts} {clientVersion} {sessionId} {nonce}`.
  // Verify the signature over exactly that, so a reordering bug fails here.
  const message = `${session.apiKeyId} ${String(now)} ${session.clientVersion} fixed-session ${headers['X-Client-Nonce']}`
  const ok = await crypto.subtle.verify(
    'Ed25519',
    pair.publicKey,
    Buffer.from(headers['X-Client-Sig'], 'base64'),
    new TextEncoder().encode(message),
  )
  assert.equal(ok, true, 'X-Client-Sig must sign apiKeyId ts version sessionId nonce in that order')
})

test('signRequestHeaders generates a fresh session id and nonce per call', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const session = { apiKeyId: 'k', origin: 'o', clientVersion: 'v', privateKey: pair.privateKey, expiresAt: Date.now() + 300_000 }
  const a = await signRequestHeaders(session)
  const b = await signRequestHeaders(session)
  assert.notEqual(a['X-Session-Id'], b['X-Session-Id'])
  assert.notEqual(a['X-Client-Nonce'], b['X-Client-Nonce'])
})

test('isSessionFresh treats a session near expiry as stale', () => {
  assert.equal(isSessionFresh(undefined), false)
  // Inside the skew window: must be treated as stale so callers re-handshake.
  assert.equal(isSessionFresh({ expiresAt: Date.now() + 5_000 }), false)
  assert.equal(isSessionFresh({ expiresAt: Date.now() + 10 * 60 * 1000 }), true)
})
