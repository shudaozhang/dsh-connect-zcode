#!/usr/bin/env node
/**
 * Diagnostics entry point for dsh-zcode-plan-bridge.
 *
 *   npx dsh-zcode-plan-bridge doctor
 *   node bin/dsh-zcode-plan-bridge.js doctor
 *
 * The commands live in lib/diagnostics.js; this wrapper only forwards argv and the exit
 * code so the package can declare a `bin` without shipping a second implementation.
 *
 * @module bin/dsh-zcode-plan-bridge
 */

import { runCli } from '../lib/diagnostics.js'

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (/** @type {any} */ error) => {
    console.error(`diagnostics failed: ${error?.message ?? error}`)
    process.exitCode = 1
  },
)
