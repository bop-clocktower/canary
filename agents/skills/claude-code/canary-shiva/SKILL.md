---
name: canary-shiva
description: >
  Predictive test ordering: runs the test files likeliest to fail first, from
  run history and the PR diff, so a failure surfaces in minute one of a long
  suite instead of hour three. Use when asked to "run the likeliest failures
  first", "order my tests", "speed up time to first failure", "set up canary
  order", or "did test ordering help". Ordering is an optimization, never a
  filter: every test still runs. NOT a test selector (it drops nothing), NOT
  canary-flake-hunter (diagnosis), NOT canary-savant (order dependence).
cli: canary order
requires: [node>=20, git]
---

# Canary Shiva

Lady Shiva reads a fighter and anticipates the next move. This skill reads a
suite's history and the change in front of it, and schedules the files most
likely to fail first. `canary order` computes the plan; this skill sets it up,
explains it, and reads the "did it help" report honestly.

## When to Use

- A suite takes long enough that finding the first failure late costs real time.
- A project records runs with `canary history record` (or is willing to).
- Someone asks whether ordering actually shortened time to first failure.

## When NOT to Use

- You want to run fewer tests: this never drops one. Use a test selector.
- A test fails only after another test: use `canary-savant`. Reordering can
  expose or hide order dependence, so fix that first.
- pytest or Playwright suites: no adapter yet (#1030 tracks pytest).

## Usage

```bash
canary order --help
```

That needs no history, no diff and no network.

## Setup (vitest)

1. Record runs so there is history:
   `canary history record <vitest.json> --suite <name>`.
2. Build a plan each run, then run vitest with it:

   ```bash
   git ls-files '*.test.ts' > files.txt
   canary order --suite <name> --files-from files.txt --base origin/main --out plan.json
   CANARY_ORDER_PLAN=plan.json npx vitest run --reporter=json --outputFile=vitest.json
   canary history record vitest.json --suite <name> --order-plan plan.json
   ```

3. In `vitest.config.ts`:
   `test: { sequence: { sequencer: CanaryOrderSequencer } }`, importing it from
   `canary-test-cli/vitest-sequencer`.

Canary's own `fleet-health` job in `.github/workflows/dogfood.yml` is the
reference wiring.

## Reading a plan

- `mode` is `history+diff` (5 or more recorded runs), `diff-only`, or
  `declaration`. Always relay `modeReason`: a cold-start order must never be
  presented as a learned one.
- Every ranked file carries its reasons (`failed 3 of last 20 runs`,
  `changed in diff`, `imports src/x.ts (changed)`). Quote them; do not invent a
  reason the plan does not state.
- `unranked` files had no signal and keep declaration order.

## Did it help?

Run `canary order --report --suite <name>`.

- `insufficient` until 20 recorded runs had a failure. Say so, with the counts.
  Never call ordering a success early.
- Runs with no failure are "not measurable". They are not wins.
- `lower`: median ordered TTFF beat the baseline over those 20 runs. The numbers
  are estimates from recorded durations summed serially, so state them as
  estimates.
- `not-lower`: ordering stays advisory, and the finding belongs on #460.

## Rationalizations to reject

| Rationalization                                     | Why it is wrong                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| "Only run the top-ranked files to save time."       | That is test selection. The plan is a permutation and every file must run.  |
| "Nothing failed this week, so ordering is working." | A run with no failure has no first failure; it is not measurable.           |
| "Mode is declaration but the order looks sensible." | Declaration mode is input order. Nothing was predicted.                     |
| "TTFF went from 40s to 5s, a real 8x speedup."      | TTFF is a serial estimate from recorded durations, not measured wall clock. |

## Related skills

- `canary-fleet-health`: flake and regression summary over the same history.
- `canary-savant`: order dependence, which reordering can expose.
- `canary-rewind`: replay a failure the ordered run surfaced.
- Guide: `docs/guides/order.md`
