/**
 * Resolve an app-server permission request under the configured policy.
 * Unknown permission-shaped methods are always denied: their response contract and
 * consequences are not known, so the full-auto option cannot implicitly bless them.
 *
 * @param {string} method App-server request method.
 * @param {'deny' | 'allow-all'} policy Configured plugin policy.
 * @returns {{ decision: 'allow' | 'deny', reason?: string } | undefined} A response for permission requests, or undefined for other methods.
 */
export function permissionResponse(method, policy) {
  if (method === 'interaction/requestPermission') {
    return policy === 'allow-all'
      ? { decision: 'allow' }
      : { decision: 'deny', reason: 'Permission requests are denied by the plugin policy.' }
  }
  if (/approval|permission/i.test(method)) {
    return { decision: 'deny', reason: 'Unknown permission method; denied by the plugin policy.' }
  }
  return undefined
}

/**
 * Keep the CLI in build mode for both policies, so permission requests pass through
 * this bridge instead of yolo silently bypassing the unknown-method denial.
 *
 * @param {'deny' | 'allow-all'} _policy Configured plugin policy.
 * @returns {'build'} Keep requests visible to the bridge for both policies.
 */
export function modeForPolicy(_policy) {
  return 'build'
}

