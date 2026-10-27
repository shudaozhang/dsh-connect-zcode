import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMMANDS, TOOL_FLAG_NOTE } from '../lib/diagnostics.js'

/**
 * The diagnostics CLI spawns a real app-server agent with the user's account, so its
 * probes must follow the same fail-closed default as the plugin. These tests pin the
 * contract that makes that true without needing to spawn a process.
 */

test('the diagnostics help advertises the tool opt-in', () => {
  assert.match(TOOL_FLAG_NOTE, /--allow-tools/)
  assert.match(TOOL_FLAG_NOTE, /denied by default/)
})

test('every documented command is listed exactly once', () => {
  const names = COMMANDS.map((entry) => entry.name)
  assert.deepEqual(names, [
    'doctor',
    'models',
    'plan-models',
    'quota',
    'login',
    'plan-turn',
    'protocol',
    'turn',
    'image',
  ])
  assert.equal(new Set(names).size, names.length)
})

test('only the commands that spawn the agent can run tools', () => {
  // This is the invariant the `--allow-tools` flag rests on: a probe can only reach a
  // permission prompt if it actually starts an agent.
  //
  // `turn` and `image` do (they spawn `zcode app-server` and hand the model a full tool
  // set). `plan-turn` also spends quota, but it is a plain HTTP POST to the plan endpoint
  // -- there is no agent, so there are no tool requests to approve. That asymmetry is
  // exactly what the direct channel buys us, so it is pinned here rather than left
  // implicit: if someone later routes `plan-turn` through an agent, this fails.
  const spending = COMMANDS.filter((entry) => /spends quota/.test(entry.summary)).map((entry) => entry.name)
  assert.deepEqual(spending, ['plan-turn', 'turn', 'image'])

  const spawnsAgent = COMMANDS.filter((entry) => /through the agent|reaches the model/.test(entry.summary)).map((entry) => entry.name)
  assert.deepEqual(spawnsAgent, ['turn', 'image'])
})

test('the direct-channel commands are documented as not spawning the agent', () => {
  // A user reading the help must be able to tell which commands talk to the plan endpoint
  // directly and which start the client's agent, because only the latter can execute tools.
  const byName = new Map(COMMANDS.map((entry) => [entry.name, entry]))
  assert.match(byName.get('quota').summary, /no agent/)
  assert.match(byName.get('plan-models').summary, /direct HTTP/)
  assert.match(byName.get('plan-turn').summary, /direct HTTP/)
  assert.match(byName.get('login').summary, /OAuth/)
})

test('plan-models documents both projections, because the picker and the table disagree by design', () => {
  // 5 merged models vs 22 route-model pairs is the single most confusing thing about this
  // channel. The usage line has to make `--mode` discoverable, or users conclude models are
  // missing from the picker.
  const entry = COMMANDS.find((candidate) => candidate.name === 'plan-models')
  assert.match(entry.usage, /--mode merged\|explicit\|both/)
})
