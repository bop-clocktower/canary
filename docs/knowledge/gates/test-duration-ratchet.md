---
type: business_rule
domain: gates
source: authored
related:
  - docs/knowledge/gates/false-green-detection.md
  - docs/knowledge/decisions/0012-entropy-ratchet.md
---

# Test duration ratchet

Why `scripts/test-duration-ratchet.mjs` normalises against a control group
instead of asserting on absolute durations, and the two designs that were
measured and rejected before it. Each cost a measurement; none should be retried
without new evidence.

## What it is for

Issue #760 raised `testTimeout` to 30s in both vitest projects so that contended
tests stop being reported as failures. Nothing in either suite runs over **~3.1s
idle**, so that is also a ~10x window in which a real slowdown is invisible: a
regression taking a 3s test to 18s passes silently. #760 asks for the raise to
be **paired with a recorded expected duration**. This gate is that pairing.

## Why the obvious implementation does not work

The quantity being measured is the quantity #760 is about. Under load these
tests take a large, roughly **constant additive** penalty — a 215ms test was
recorded at 9600ms — so a fixed duration ceiling is flaky for precisely the
reason the timeouts were. And a gate that fails intermittently teaches people to
re-run until green, which is how a real failure gets waved through.

## The mechanism: the tracked tests are their own control group

Load raises every slow test together; a regression raises one. So each run
derives its own **load factor** — the median ratio of observed to recorded
across all tracked tests — and every test is judged against a ceiling scaled by
it. Measured on real reports from `agents/skills`:

| scenario                 | median ratio | worst | ceiling | result   |
| ------------------------ | -----------: | ----: | ------: | -------- |
| idle run                 |         1.00 |  1.73 |    2.50 | pass     |
| genuinely contended run  |         1.38 |  2.60 |    3.45 | pass     |
| 4x regression, idle      |         1.00 |   4.0 |    2.50 | **fail** |
| 4x regression, contended |         1.41 |   5.3 |    3.52 | **fail** |

Row 2 is the point: **2.60 would have tripped a fixed 2.5x ceiling.** Row 4 is
the other half — a regression during a contended run is still caught.

A single regressed test barely moves a median over dozens of entries. That
asymmetry is the whole design.

## The factor may only ever loosen

Clamped at 1. **Found by CI, not by the tests**, which had only exercised
factors at or above 1. A macOS-recorded baseline against an ubuntu runner
produced a load factor of **0.08** — Linux spawns a process roughly an order of
magnitude faster than macOS, and these tests are spawn-bound — so the ceiling
became `0.21x recorded` and eight tests were reported as regressions **for
running faster than baseline**. The normalisation was unbounded downward.

Two guards came out of that: the clamp, and `MIN_LOAD_FACTOR` — below 0.5 the
run is a different _class_ of machine rather than an idle one, the baseline does
not describe it, and the gate abstains rather than compare.

## The baseline is machine-class-specific

It records `nodeVersion` and abstains on a mismatch, the same way
`.harness/perf-baseline.json` abstains on a CLI mismatch. But the runtime stamp
is not sufficient on its own: the same node on macOS and on an ubuntu runner are
different instruments for a spawn-bound suite.

**Re-record the baseline where the gate runs.** The `agents/skills` CI job
uploads `test-durations-agents-skills` as an artifact for exactly this; download
it and run the ratchet with `--update`.

## The floor is set from the runner, not the laptop

`FLOOR_MS` is **75ms**. At the original 250ms only **three** tests clear the
floor on an ubuntu runner — Linux spawns roughly an order of magnitude faster
than macOS and this suite is spawn-bound — which is below `MIN_CONTROL_GROUP`.
The gate would then have abstained on every CI run forever while exiting 0. A
gate that always abstains verifies nothing, which is the failure mode one level
up from the one it was built to catch.

Measured on a real CI run (927 tests, max 1392ms):

| floor | tracked |
| ----: | ------: |
| 250ms |       3 |
| 100ms |      15 |
|  75ms |      38 |
|  50ms |      54 |

75ms keeps a comfortable margin over the 10-test minimum without dropping so low
that per-test jitter dominates.

**Unmeasured:** run-to-run variance on the runner itself. The baseline comes
from a single CI run. If the gate proves flaky in practice the floor should rise
before the tolerance does — a wider tolerance hides real regressions, a higher
floor only narrows what is watched.

## Two designs measured and rejected

Recorded so they are not retried.

**1. Normalising against the whole suite's median duration.** Refuted on real
data. That median is **0.4ms**, because hundreds of tests are pure in-process
work that never takes the spawn penalty, so it barely moves while slow tests do.
Ratios drifted 0.98–1.52x where raw durations drifted 0.87–1.34x — normalising
against the wrong control group made it _worse_. The fix was to use the tracked
slow tests as the control group, which is the population that actually pays the
penalty.

**2. A `node -e 0` spawn probe as an instrument**, abstaining when the machine
looks busy — the shape `.harness/perf-baseline.json` uses for a floating CLI.
Rejected because it **could not be validated** on the hardware to hand: under 8
concurrent spawn loops the probe reported p90 **42.5ms** against **44.1ms**
idle. No signal.

That second one generalises beyond this gate. Shipping an instrument that cannot
be shown to measure the thing it claims to is the failure this repo keeps
finding in its own gates — and it is the mistake already made once on #760
itself, where a spawn-count explanation was published citing a test that spawns
nothing.

## Abstentions

Exit 3, never a pass: no reports, zero tests collected, a missing or empty
baseline, a different node version, fewer than `MIN_CONTROL_GROUP` (10) tracked
tests present, or a load factor outside `[0.5, 5]`. A tracked test absent from
the run is reported as **unverified**, not counted as passing.

CI treats exit 3 as a warning naming what was _not_ checked, so an abstention
can never read as a green tick.
