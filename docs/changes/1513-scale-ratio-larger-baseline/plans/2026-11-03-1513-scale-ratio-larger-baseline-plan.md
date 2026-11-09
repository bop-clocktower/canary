# Plan: steady the `instrumentedTrees` scale ratio with larger sizes

Issue: [#1513](https://github.com/bop-clocktower/canary/issues/1513) · Route:
cicd (flake) · Pipeline: `harness:debugging` · Date: 2026-11-03 · Base:
`origin/main` @ `16a8ad2e` · Earlier work on this test:
[plan for #1402](../../instrumented-trees-scale-ratio/plans/2026-10-21-instrumented-trees-scale-ratio-plan.md)

---

## 1. INVESTIGATE: what failed

`ts/test/guardian-instrumented-trees-scale.test.ts`, "grows linearly", failed
and then passed on the same SHA on two required checks. Both ran
`vitest run --coverage`, the whole suite at once.

| Run                                                                              | Job                 | Large / small      | Ratio | Test file time |
| -------------------------------------------------------------------------------- | ------------------- | ------------------ | ----- | -------------- |
| [40739930622](https://github.com/bop-clocktower/canary/actions/runs/40739930622) | `TS engine (pilot)` | 554.4 ms / 35.4 ms | 15.6x | 5526 ms        |
| [40754830337](https://github.com/bop-clocktower/canary/actions/runs/40754830337) | `guardian`          | 672.0 ms / 43.4 ms | 15.5x | 6497 ms        |

`harness cleanup` reports 106 entropy findings, the repo's known count. None of
those shown touch `report-anchor.ts`. The code under test is linear: one `push`
per entry, one `existsSync` per sample in `anchorPrefix`, one pass in
`commonDir`.

## 2. ANALYZE: the premise, tested

The issue blamed noise on a small baseline. The CI numbers show more than that:
the small side costs 3.5 µs per entry and the large side 5.5 µs. So the question
was whether this is real superlinear cost (cache, GC, dictionary mode), which
larger sizes would make worse, or an artifact of the estimator.

The probe uses the test's own estimator (one warm-up per size, 7 interleaved
repetitions, minimum per size) in a fresh vitest process under v8 coverage, with
the same coverage `include` as CI. The two size pairs alternate so that ambient
load from peer sessions lands on both. Machine: 10-core laptop, Node 22.23.2.

| Condition                        | Sizes    | n   | Min   | Median | p95   | Max   | Over 15x | Small (median) | Large (median) |
| -------------------------------- | -------- | --- | ----- | ------ | ----- | ----- | -------- | -------------- | -------------- |
| Coverage, ambient                | 10k/100k | 25  | 10.26 | 10.43  | 10.56 | 10.60 | 0        | 21.2 ms        | 221.5 ms       |
| Coverage, ambient                | 30k/300k | 25  | 10.23 | 10.32  | 10.47 | 10.48 | 0        | 66.8 ms        | 689.9 ms       |
| Coverage, 1 busy loop per core   | 10k/100k | 25  | 8.79  | 12.13  | 13.90 | 14.12 | 0        | 29.9 ms        | 363.0 ms       |
| Coverage, 1 busy loop per core   | 30k/300k | 25  | 9.87  | 11.25  | 11.87 | 12.27 | 0        | 103.0 ms       | 1174.6 ms      |
| Coverage, 3 busy loops per core  | 10k/100k | 10  | 10.77 | 13.78  | 23.14 | 23.14 | 4        | 76.6 ms        | 1111.7 ms      |
| Coverage, 3 busy loops per core  | 30k/300k | 9   | 10.04 | 11.16  | 12.59 | 12.59 | 0        | 323.0 ms       | 3563.8 ms      |
| Coverage, during real `npm test` | 10k/100k | 8   | 9.32  | 11.44  | 14.60 | 14.60 | 0        | 28.7 ms        | 301.5 ms       |
| Coverage, during real `npm test` | 30k/300k | 8   | 9.78  | 10.28  | 12.76 | 12.76 | 0        | 71.3 ms        | 697.2 ms       |
| No coverage, ambient             | 10k/100k | 10  | 10.38 | 10.47  | 10.54 | 10.54 | 0        | 20.3 ms        | 212.2 ms       |
| No coverage, ambient             | 30k/300k | 10  | 10.28 | 10.34  | 10.45 | 10.45 | 0        | 64.7 ms        | 668.8 ms       |

Limits of this data:

- The 3-per-core batch was stopped early on purpose, because it was starving
  peer sessions. That is why n is 10 and 9.
- The full-suite batch is small because the suite only runs for about 35 s
  locally. Its p95 is effectively its max.
- These are a laptop's numbers, not a CI runner's. Peer sessions were also
  running, so "ambient" is not idle.
- p95 is nearest-rank.

## 3. HYPOTHESIZE: root cause

There is no superlinearity of its own at these sizes. Unloaded, the larger pair
is slightly closer to 10x than the smaller one (10.32 against 10.43).

The excess appears only under contention, and it is an interaction with the
minimum. A short sample can land in a quiet scheduler slice, while a long one
has to absorb the average contention. So the minimum deflates the small side
more than the large side and the ratio rises. Slowdown against the same pair's
ambient median shows this:

| Condition       | Sizes    | Small slowdown | Large slowdown | Large / small |
| --------------- | -------- | -------------- | -------------- | ------------- |
| 1 busy per core | 10k/100k | 1.41x          | 1.64x          | 1.16          |
| 1 busy per core | 30k/300k | 1.54x          | 1.70x          | 1.10          |
| 3 busy per core | 10k/100k | 3.61x          | 5.02x          | 1.39          |
| 3 busy per core | 30k/300k | 4.84x          | 5.17x          | 1.07          |

The human's premise holds, with one refinement: the small baseline is too short,
but what it does is get lucky rather than get noisy. This mechanism fits the
data and predicted the direction of the result. It was not isolated as a single
variable, and nothing here measured a CI runner's scheduler directly.

The failure was also reproduced, which the earlier runs had not done: 4 of 10
over 15x (max 23.1x) at the old sizes when oversubscribed.

## 4. FIX

Fork answered by the human, binding: raise both sizes about 3x, keep the factor
of 10, keep `MAX_RATIO = 15`. The test now uses `SMALL = 30_000`,
`LARGE = 300_000`, and its doc comment records why. No product code changes.

## 5. VERIFY

**Runtime cost.** Test file wall clock is vitest's reported `Duration` for that
file alone, 3 runs each, with the machine under peer load.

| Measure                | 10k/100k           | 30k/300k           | Delta                               |
| ---------------------- | ------------------ | ------------------ | ----------------------------------- |
| Test file, no coverage | 2.05-2.08 s        | 6.34-6.55 s        | about +4.4 s                        |
| Test file, coverage    | 2.58-2.61 s        | 7.03-7.08 s        | about +4.5 s                        |
| Full `npm test`        | 28.6, 33.9, 36.9 s | 32.0, 37.6, 36.8 s | about +2.4 s mean, inside the noise |

CI was not measured at the new sizes. The old sizes took 5.5-6.5 s on the two
failed CI jobs, so 3.1x that is an estimate of 17-20 s for the file, or +12-14 s
on one worker. CI's suite took about 60-65 s on those jobs. Against the 10-15 s
the human was told, the added cost fits that range and the file's total time is
slightly above it. Both CI figures come from two failed runs, which may have
been slower than a typical run.

**Quadratic plant (not committed).** In `anchoredGroups`, the `push` was swapped
for the historical spread,
`groups.set(top, [...(groups.get(top) ?? []), [raw, clean]])`, and the real test
ran under `vitest run --coverage`.

| Sizes    | Result | How it went red                    | Ratio  | Large / small          | Test time |
| -------- | ------ | ---------------------------------- | ------ | ---------------------- | --------- |
| 10k/100k | FAIL   | Ratio assertion                    | 158.9x | 9696.2 ms / 61.0 ms    | 83.4 s    |
| 30k/300k | FAIL   | Ratio assertion, not 120 s timeout | 114.7x | 107569.5 ms / 937.7 ms | 874.7 s   |

The plant was reverted with `git checkout` and `git status` confirmed it gone.
114.7x is still 7.6x over the bound, and the failure message names the sizes,
both timings and the ratio.

**The cost a regression now pays.** The red arrives after about 14.6 minutes
locally instead of 1.4. Scaling by the same 2.6-3.1x CI factor is an estimate of
38-45 minutes on CI, up from about 4; that was not measured. The 120 s timeout
does not shorten this: the loop is synchronous, it blocks the worker that
vitest's timer needs, and the run took 7x the timeout and still reported the
assertion. The `guardian` and `TS engine (pilot)` jobs set no `timeout-minutes`,
so GitHub's 6-hour default applies and the check does finish red. This is only
paid by a PR that actually reintroduces the quadratic, and merge stays blocked
for the whole wait. It was judged acceptable and raised to the human on the PR,
because the 10x slower red is a new cost that nobody chose.

## 6. Doc drift and testing gaps

- The sizes appear only in this test and in the #1402 plan and provenance, which
  are dated records of that fix and stay as written.
- Test-only change, so no CHANGELOG entry, matching the #1402 fix.
- The ratio is not a stored number and no baseline depends on it.
- `guardian mutation` has no wired runner today (`ts/src/guardian/mutation.ts`),
  so the slower test adds nothing to that job's 10-minute budget.

## 7. Assumptions and defaults taken

- "Around 30k and 300k" means exactly 30,000 and 300,000.
- One busy loop per core, using `yes`, stands in for CI contention as the brief
  suggested. It is CPU-heavy and I/O-light, and the code under test is
  `existsSync`-heavy, which is why the full-suite batch was added as a check.
- The debug session is written to `.harness/debug/`, which is ignored by git, so
  it stays local to the machine.
