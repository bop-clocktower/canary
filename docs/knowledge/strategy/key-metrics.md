---
type: business_rule
domain: strategy
source: STRATEGY.md
---

# Key metrics

- Escaped-defect ratio: defects found post-release vs. caught pre-release by a
  canary gate or exploratory sweep; issue-tracker labels reconciled against
  guardian findings and test-reporter run artifacts. Requires an incident-data
  join canary does not hold today — tracked manually at first.
- Coverage-verified finding share: percentage of guardian findings backed by
  real coverage evidence rather than heuristic inference; read from
  `canary guardian pr-check` output.
- Time to first trustworthy gate: elapsed time from install to a passing
  guardian gate; derived from canary-ci-ready scoring.
