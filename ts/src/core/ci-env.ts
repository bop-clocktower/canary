/**
 * CI environment detection for Canary headless optimizations.
 *
 * A variable counts as set when it is a non-empty string: `undefined` and `""`
 * are unset, while `"0"` and `"true"` are both set.
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
