# Plan: deflake the `instrumentedTrees` scale test with a complexity ratio

Issue: [#1402](https://github.com/bop-clocktower/canary/issues/1402) · Route:
cicd (flake) · Pipeline: `harness:debugging` → `harness:tdd` · Date: 2026-10-21
· Base: `origin/main` @ `4608f963`

---

## 1. INVESTIGATE — what actually failed

`ts/test/guardian-instrumented-trees-scale.test.ts` asserted
`expect(performance.now() - started).toBeLessThan(1000)` for one cold
`instrumentedTrees` call over 100k report entries. The required `guardian` job
runs that test inside `npm --prefix ts test` (`vitest run --coverage`, v8
coverage, `.github/workflows/guardian.yml`, step "Produce a coverage report for
the guardian"). It went red at 1059 ms on #1396, a dependency-only PR, after
passing on the same PR one cycle earlier.

Root cause: the assertion measured absolute runner speed, not the property it
guards. One cold, un-warmed sample on a shared runner, under coverage
instrumentation, with the rest of the suite's workers contending, has no fixed
relationship to a millisecond budget. The code under test was never at fault.

Cost profile, measured locally (Node 22.23.2, linear implementation): the call
is ~21 ms at 10k entries and ~220 ms at 100k. Most of it is `anchorPrefix`
calling `existsSync` once per sample when none of the paths exist, so the cost
is syscall-bound and sensitive to machine load, which is exactly why a fixed
bound was noisy.

## 2. ANALYZE — what the test is for

PR #1341 fixed a quadratic grouping (a spread that rebuilt each group's array on
every entry). The test exists to fail if that shape comes back. Anything that
separates linear from quadratic without depending on absolute speed meets the
need.

## 3. DECISION — the fork (human-answered, binding)

Option (a) from #1402, chosen at the CONFIRM gate: replace the absolute bound
with a complexity-ratio assertion. Time `instrumentedTrees` on 10k and 100k
entries of the same shape and require `time(100k) / time(10k) <= 15`. Linear is
about 10x, quadratic about 100x. No absolute millisecond bound remains.

Not chosen: a load-factor-scaled ceiling (still an absolute bound, just a moving
one), or skipping the timing under coverage (hides the guard from the required
check that runs it).

## 4. FIX — measurement design

- Build both indexes up front, so construction cost is outside the timing.
- Warm up: one untimed call per size.
- Seven repetitions, interleaved small/large, keeping the minimum per size. The
  minimum discards GC pauses and scheduling hiccups. Interleaving puts any
  stretch of contention on both sizes instead of only the one that was being
  sampled at the time.
- Assert `ratio <= 15` with a message that prints both timings and the ratio.

A first draft timed all small repetitions, then all large ones (not interleaved,
five repetitions). It failed 2 of 10 plain local runs with ratios 17.3 and 16.9
while peer worktrees were loading the machine (load average ~5 on 10 cores). The
large side alone was inflated: 376 ms against the usual ~225 ms. The interleaved
version is what ships.

## 5. VERIFY — evidence

Mutation probe (TDD red; NOT committed). In `anchoredGroups`, the linear `push`
was swapped for the historical quadratic spread:

```ts
groups.set(top, [...(groups.get(top) ?? []), [raw, clean]]); // PROBE
```

| Run                                        | Result | Ratio  | small / large    |
| ------------------------------------------ | ------ | ------ | ---------------- |
| Probe, non-interleaved draft, plain        | FAIL   | 174.2x | 54.4 / 9480.1 ms |
| Probe, final test, plain vitest            | FAIL   | 165.9x | 59.5 / 9877.1 ms |
| Probe, final test, `vitest run --coverage` | FAIL   | 164.9x | 60.0 / 9896.0 ms |

The probe was reverted with `git checkout` and `git status` confirmed it was
gone before anything was committed.

Real implementation (final test):

| Configuration                                               | Runs | Pass | Ratio range   |
| ----------------------------------------------------------- | ---- | ---- | ------------- |
| Plain `vitest run <file>`                                   | 10   | 10   | 10.33–10.85x  |
| `vitest run --coverage <file>` (guardian's coverage config) | 12   | 12   | 10.06–10.57x  |
| Full `npm test` (the exact guardian step, all 335 files)    | 2    | 2    | 10.33, 11.07x |

The worst observed linear ratio (11.07x under full-suite contention) leaves
about 35% headroom under the bound. The best observed quadratic ratio (164.9x)
is 11x over it.

## 6. Assumptions and defaults taken

- Repetitions = 7, warm-up = 1 per size. The minimum is the estimator, as the
  fork allows (min or median).
- Threshold 15, as given in the fork.
- The 120 s per-test timeout is kept. A quadratic regression takes about 80 s
  locally, so on a slower runner it could hit the timeout before the assertion.
  Either way the test is red.
- Test-only change: no production code changes, so no CHANGELOG entry.
- The debug session file is written to `.harness/debug/`, which
  `.harness/.gitignore` ignores, so it stays local to the machine.
