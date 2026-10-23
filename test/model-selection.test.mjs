// Unit tests for the per-model enable/disable selection (pure functions, no spawn).
// Run with: node --test test/model-selection.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeIdList, selectEnabledModels } from '../lib/zcode-runtime.js'

/** Three fake advertised models, in catalogue order. */
const models = [{ id: 'GLM-5.3' }, { id: 'qwen3.8-flash' }, { id: 'deepseek-v4-pro' }]

test('empty selection keeps every model in catalogue order', () => {
  const result = selectEnabledModels(models, [], [])
  assert.deepEqual(result.models.map((m) => m.id), ['GLM-5.3', 'qwen3.8-flash', 'deepseek-v4-pro'])
  assert.deepEqual(result.unknownEnabledIds, [])
  assert.deepEqual(result.unknownDisabledIds, [])
})

test('undefined selection is treated as "all"', () => {
  const result = selectEnabledModels(models)
  assert.equal(result.models.length, 3)
})

test('an allow list keeps only the listed ids, in catalogue order (not user order)', () => {
  const result = selectEnabledModels(models, ['deepseek-v4-pro', 'GLM-5.3'], [])
  assert.deepEqual(result.models.map((m) => m.id), ['GLM-5.3', 'deepseek-v4-pro'])
  assert.deepEqual(result.unknownEnabledIds, [])
})

test('a block list removes ids from the full set', () => {
  const result = selectEnabledModels(models, [], ['qwen3.8-flash'])
  assert.deepEqual(result.models.map((m) => m.id), ['GLM-5.3', 'deepseek-v4-pro'])
})

test('the block list wins over the allow list', () => {
  const result = selectEnabledModels(models, ['GLM-5.3', 'qwen3.8-flash'], ['qwen3.8-flash'])
  assert.deepEqual(result.models.map((m) => m.id), ['GLM-5.3'])
})

test('ids that match nothing are reported, not silently ignored', () => {
  const result = selectEnabledModels(models, ['GLM-5.3', 'typo-model'], ['also-typo'])
  assert.deepEqual(result.models.map((m) => m.id), ['GLM-5.3'])
  assert.deepEqual(result.unknownEnabledIds, ['typo-model'])
  assert.deepEqual(result.unknownDisabledIds, ['also-typo'])
})

test('an allow list of only unknown ids yields an empty picker (and reports them)', () => {
  const result = selectEnabledModels(models, ['nope'], [])
  assert.deepEqual(result.models, [])
  assert.deepEqual(result.unknownEnabledIds, ['nope'])
})

test('selection does not mutate the input array', () => {
  const input = [{ id: 'a' }, { id: 'b' }]
  selectEnabledModels(input, ['a'], [])
  assert.equal(input.length, 2)
})

test('normalizeIdList trims, drops empties and de-duplicates while preserving order', () => {
  assert.deepEqual(normalizeIdList([' a ', '', 'b', 'a', '  ']), ['a', 'b'])
  assert.deepEqual(normalizeIdList(undefined), [])
  assert.deepEqual(normalizeIdList([]), [])
})
