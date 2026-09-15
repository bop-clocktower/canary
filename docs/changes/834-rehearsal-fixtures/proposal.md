# Rehearsal fixtures: a silent detector fails CI (#834)

**Status:** proposed · **ADR:** 0018 (accepted) · **Route:** feature

## Problem

Canary's four deterministic detectors (`canary-savant`, `canary-blackhawk`,
`canary-katana`, `canary-cassandra`) and three ratchets (entropy, perf,
duration) report green by reporting zero or a number. Nothing proves any of them
still fires, so a detector that goes quiet reads as a pass.

## Decision summary

- One planted defect per target, under `rehearsal/<id>/`, each with a
  `rehearsal.json` manifest naming the target and the ground truth it must
  report.
- `scripts/rehearse.mjs` runs a probe per manifest and prints
  `n fired of n expected`, where `n` is the fixed required-target list, never
  the number of fixtures found.
- Exit 0 only when every required target fired. A probe that examined zero
  items, a target with no fixture, an unknown target, or a probe error all
  exit 1. No manifests at all exit 3 (abstention), which CI treats as a failure.
- Wired blocking in `harness-quality.yml` → `skills-validate`, after the engine
  build, because `canary-cassandra` delegates to `ts/dist`.

## Fixtures

| Fixture                         | Target             | Planted defect                                           | Fires when                                   |
| ------------------------------- | ------------------ | -------------------------------------------------------- | -------------------------------------------- |
| `savant-order-dependence`       | `canary-savant`    | module-level array written by one test, read by the next | a finding with `SV001-module-mutable-global` |
| `blackhawk-wall-clock`          | `canary-blackhawk` | `Date.now()` in a test                                   | a finding with `BH001-wall-clock`            |
| `cassandra-vacuous-assertion`   | `canary-cassandra` | `expect(total).toBe(total)`                              | a finding with `VAC-001`                     |
| `katana-last-coverage-deletion` | `canary-katana`    | diff removing the only test of a 0.92-risk area          | a `last-coverage-removed` finding            |
| `entropy-over-ceiling`          | entropy ratchet    | cleanup report 6 against a ceiling of 5                  | exit 1 with a measured count                 |
| `perf-over-ceiling`             | perf ratchet       | check-perf report 6 against a ceiling of 5               | exit 1 with a measured count                 |
| `duration-slow-test`            | duration ratchet   | one of 12 tracked tests 30x slower than recorded         | `compare()` names the planted test           |

Every probe also reports what it examined (files scanned, tests checked,
deletions captured, the parsed count, tracked tests compared). Zero fails.

## Success criteria

1. `node scripts/rehearse.mjs` prints `7 fired of 7 expected` and exits 0 on
   this tree.
2. Neutering any one target (removing a rule, emptying a fixture) makes it exit
   non-zero and name the target.
3. An empty fixture root prints `0 fired of 7 expected` and exits 3.
4. The step is blocking in CI (no `continue-on-error`, no `|| true`), asserted
   by `ts/test/rehearse.test.ts`.
5. Fixtures do not move the entropy, perf or arch counts: fixture code files are
   `*.test.mjs` (already in `entropy.excludePatterns`), the rest are JSON, text
   and diff data, and `rehearsal/` sits outside every arch layer. No
   `rehearsal/**` exclude is added: `ts/test/entropy-exclude-patterns.test.ts`
   forbids a repo-rooted exclude over tracked files, because it would shrink the
   CI denominator.

## Assumptions (defaults taken, no questions asked)

- **Ratchets are rehearsed at the ratchet script, not the upstream analyzer.**
  The entropy and perf fixtures feed a synthetic report and a fixture baseline
  to the real ratchet script. Rehearsing `harness cleanup` /
  `harness check-perf` themselves needs the network-installed CLI and would
  couple the gate to a floating major; the ratchet-drift half of that risk is
  already guarded by the `--cli-version` abstention (#744). Named here so it is
  not mistaken for analyzer coverage.
- **The duration ratchet is probed through its exported `compare()`**, because
  its CLI hard-codes the repo baseline path. Adding a `--baseline` flag was out
  of scope for this PR.
- **Fixture directory is `rehearsal/` at the repo root**, not under a
  `fixtures/` or `test/` directory: blackhawk and savant skip `fixtures/` (so
  they could never see the plant), and the strict dogfood steps scan `ts/test`
  and `agents/skills/test` (so a plant there would fail them).
- **CI placement is the existing `skills-validate` job**, not a new required
  check, so the ruleset's required contexts do not change.

## Non-goals

- Scoring agent recovery (upstream `harness-rehearse` scoring).
- Rehearsing the upstream harness analyzers directly.
