/**
 * CI environment detection for Canary headless optimizations.
 *
 * Faithful TypeScript port of `agent/core/ci_env.py`.
 *
 * Python→TS nuances:
 *   - `os.environ.get(v)` → `process.env[v]` (an unset var is `undefined`).
 *   - Python's `any(os.environ.get(v) ...)` uses truthiness: a non-empty
 *     string is truthy, `""` is falsy, and `"0"` is truthy (non-empty). JS
 *     `Boolean(process.env[v])` matches exactly — `undefined`/`""` → false,
 *     `"0"`/`"true"` → true.
 */

// Most platforms set CI=true; GitLab sets CI_SERVER; Bitbucket sets
// BITBUCKET_BUILD_NUMBER.
const CI_VARS = [
  'CI',
  'GITHUB_ACTIONS',
  'CIRCLECI',
  'TRAVIS',
  'CI_SERVER',
  'BITBUCKET_BUILD_NUMBER',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
] as const;

/**
 * Return true when a recognized CI environment variable is set and non-empty.
 *
 * Python: `is_ci`.
 */
export function isCi(): boolean {
  return CI_VARS.some((v) => Boolean(process.env[v]));
}
