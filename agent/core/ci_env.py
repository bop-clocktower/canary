# agent/core/ci_env.py

"""CI environment detection for Oracle headless optimizations."""

import os

# Most platforms set CI=true; GitLab sets CI_SERVER; Bitbucket sets BITBUCKET_BUILD_NUMBER.
_CI_VARS = (
    "CI",
    "GITHUB_ACTIONS",
    "CIRCLECI",
    "TRAVIS",
    "CI_SERVER",
    "BITBUCKET_BUILD_NUMBER",
    "JENKINS_URL",
    "TEAMCITY_VERSION",
)


def is_ci() -> bool:
    """Return True when a recognized CI environment variable is set and non-empty."""
    return any(os.environ.get(v) for v in _CI_VARS)
