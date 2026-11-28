# canary-hawk-dove — outcome labels for past gate findings (slice of #618)

**Issue:** [#618](https://github.com/bop-clocktower/canary/issues/618) (slice;
the tuner itself is deferred) **Route:** feature **Status:** proposed
**Related:**
[ADR 0025](../../knowledge/decisions/0025-adjudication-without-reactions.md)
(adjudication without reactions),
[ADR 0009](../../knowledge/decisions/0009-exit-3-reserved-for-abstained.md)
(exit 3 = abstained), `agents/skills/lib/scan-baseline.mjs` (line-free finding
identity, #1322)

## Spike: the labeling question

Issue #618 asks for a gate threshold auto-tuner. Its roadmap row is blocked on
one line: _no ground-truth outcome labels exist on past findings_. A tuner
trained on no labels produces a confidently wrong threshold, so the labeling
question comes first. This spike answers three sub-questions.

### Where outcome labels can come from

Four outcomes matter for a gate. **Real** (a true positive): the finding pointed
at something that needed fixing. **Noise** (a false positive): it did not.
**Intentional**: the finding was correct, and a person accepted the gap on
purpose. **Escape**: a defect the gate should have caught and did not.

| Source                                                                                  | Outcome      | Cost to a human                  | Verdict                                       |
| --------------------------------------------------------------------------------------- | ------------ | -------------------------------- | --------------------------------------------- |
| `canary:allow-untested fp: <why>` on a flagged unit (ADR 0025)                          | noise        | none new: already the convention | **derived** (`guardian-fp-suppression`)       |
| `canary:allow-untested <why>` with any other reason (ADR 0025)                          | intentional  | none new                         | **derived** (`guardian-reasoned-suppression`) |
| Coverage-verified finding gone from a later vouching run, file still in diff (ADR 0025) | real         | none                             | **derived** (`guardian-covered-later`)        |
| A later `fix:` commit touches the flagged path                                          | real         | none                             | **rejected** (see below)                      |
| Thumbs-up / thumbs-down reactions on the sticky comment                                 | real / noise | a ritual                         | **rejected**: 0 reactions on 290 stickies     |
| A person states the outcome, with evidence                                              | any          | one CLI step                     | **explicit** (`label`)                        |
| A person names a defect the gate missed, with evidence                                  | escape       | one CLI step                     | **explicit** (`escape`)                       |

The three derived rules are exactly the guardian signals
[ADR 0025](../../knowledge/decisions/0025-adjudication-without-reactions.md)
accepted and `ts/src/guardian/adjudication.ts` implements against sticky edit
history. This slice applies the same rules to recorded `pr-check --json` runs,
so the engine's derived precision and this ledger cannot disagree on what a
signal means. Nothing here asks a reviewer for a new habit.

**Rejected: "a later `fix:` commit touches the flagged path means real."** It
costs nothing and would label a lot, which is the problem. A `fix:` commit to a
file says the file had _a_ defect, not that it had _the_ gap the gate flagged. A
coverage finding on `cart.ts` followed by a `fix(cart): rounding` commit proves
nothing about whether the uncovered lines mattered, and a busy file collects
`fix:` commits for unrelated reasons. The rule would inflate "real" precisely on
high-churn files, which are the files a tuner most needs to get right. Its
false-label risk is high and it is not built.

### Which labels a human must supply

- **Every escape.** No gate can derive what it never saw. A person names the
  gate and the evidence (an issue, a commit, an incident) in one CLI step.
- **Noise outside the `fp:` convention.** If nobody writes `fp:`, a false
  positive looks intentional. That bias is disclosed, not corrected (ADR 0025:
  under-use biases precision upward).
- **Any finding a derived rule left unlabelled** (ambiguous: it disappeared with
  no coverage evidence, or was never resolved), if someone knows the answer.
- **Overrides.** A person who disagrees with a derived label appends an explicit
  one. The latest label for a finding wins; the derived one stays in the ledger
  for audit.

Explicit labelling is a single command
(`canary-hawk-dove label <finding-id> --outcome noise --by <who> --evidence <ref>`),
never a reaction, a PR label or a comment ritual (no-reactions finding, ADR
0025).

### How many labels before tuning means anything

**30 adjudicated labels (real + noise) per gate**, the same `PRECISION_FLOOR`
the guardian already uses (ADR 0025). The number is not arbitrary:

- At n = 30 the 95% margin on an observed proportion is at most 1.96 × √(0.25
  / 30) ≈ **±18 points** (worst case, p = 0.5). Below that the interval is wide
  enough that any two plausible thresholds are indistinguishable. At 30 the
  evidence can at least tell 50% from 80%.
- Reusing the guardian's floor means one gate never reads "enough data" in one
  report and "unknown" in the other.
- Escapes and intentional labels are reported but do not count toward the floor,
  matching ADR 0025 (TP + FP only). A miss rate has its own denominator problem
  (you cannot count what you missed), which is part of why tuning is deferred.

Below the floor the report **abstains** (exit 3, ADR 0009) and names how many
more labels each gate needs. At or above it, the report prints the observed
counts per gate and says tuning is not built yet. **It never prints a threshold
or a recommendation**, at any count.

## Scope of this slice

In:

1. `record`: take a gate's JSON output into an append-only ledger. Each finding
   gets a stable, line-free id derived from the scan-baseline identity (file,
   rule, anchor). Derived labels are appended as runs arrive.
2. `label`: one explicit outcome for a known finding id, with provenance. An
   unknown id is rejected, not stored.
3. `escape`: one explicit escape for a gate, with evidence and no finding id.
4. `report`: per-gate counts with the floor and abstention above.

Out (remaining for #618): threshold tuning or recommendation of any kind;
derived labels for gates other than the guardian; a scheduled workflow that
records guardian runs automatically; and a committed, durable home for this
repository's own ledger.

## Design

### Skill shape

A self-contained script skill at `agents/skills/claude-code/canary-hawk-dove/`
with `cli: scripts/cli.mjs`. Standard library only, plus the vendored
`agents/skills/lib/` helpers (`parse-args`, `is-main`, `scan-baseline`). No
module imports more than four others, so the perf coupling rule stays flat.

### Finding identity

`identityOf({file, rule, anchor})` from `lib/scan-baseline.mjs`, so a re-indent
or a moved line keeps its identity. The id is `hd1-` + the first 16 hex
characters of the SHA-256 of `gate \0 file \0 rule \0 anchor`. For the guardian,
`file` is the finding's `path`, `rule` its `kind` and `anchor` its `unit`. Any
other gate supplies the scan-baseline shape directly:
`{"findings": [{"file", "rule", "anchor"}]}`. Re-recording an already-known
finding adds a run reference, never a duplicate finding.

### Ledger

NDJSON at `.canary/hawk-dove/ledger.jsonl` (override with `--ledger`), one
record per line, each with `v: 1`:

- `finding`: `id`, `gate`, `file`, `rule`, `anchor`, `fidelity`.
- `run`: `run`, `gate`, `pr`, `at`, `source`, `vouches`, `base`, `head`, and
  `findings` (each `id`, `suppressed`, `reason`).
- `label`: `finding`, `gate`, `outcome`, `rule`, `by`, `at`, `evidence`, `note`.

`rule` is `explicit` for a human label, or the derived rule's name. `finding` is
`null` for an escape. The tool only ever appends; it never rewrites, truncates
or reorders a line. A malformed line is reported as "not read" and skipped,
never repaired.

### Derived rules (guardian only)

Evaluated when `record --gate guardian` takes in a run:

- **`guardian-fp-suppression` → noise.** The run reports the finding
  `suppressed` with a reason starting `fp:` (any case).
- **`guardian-reasoned-suppression` → intentional.** Suppressed with any other
  reason.
- **`guardian-covered-later` → real.** For runs recorded with the same `--pr`, a
  `coverage-verified` finding in the PR's first run is absent from the run just
  recorded. The new run must vouch (coverage status `verified`, no degraded
  notice, not abstained), and the finding's file must still be in
  `git diff --name-only <base> <head>` of the new run's provenance. If any of
  that cannot be established, no label is written (ambiguous, ADR 0025).

Each derived label is written once per (finding, rule), carries its rule name
and the run that produced it as evidence, and can be overridden by a later
explicit label.

### Report

| Exit | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| 0    | at least one gate reached the floor; counts printed           |
| 1    | `--out` could not be written                                  |
| 2    | usage error, unreadable input, or a rejected label            |
| 3    | abstained: no ledger, no labels, or no gate reached the floor |

Advisory: findings never set the exit code. The abstention line is mirrored to
stderr so a redirected report still says it. Markdown by default; `--json` emits
`schema_version: 1` with `checked` (labels read) and `abstained`.

## Security

- **One escaping helper** (`scripts/escape.mjs`) for every value that reaches
  Markdown, stdout or stderr: ANSI and control characters (including U+2028 and
  U+2029) stripped, Markdown metacharacters escaped, GFM autolinks neutralised
  (a U+200B zero-width space breaks every `://`, `www.` and `@`, which no GFM
  autolink scanner then accepts), and length clamped by code point.
- **JSON keys stay raw.** The JSON report is built from fixed keys; gate names
  are validated against `^[a-z][a-z0-9-]{0,39}$` before they can become a key.
- **No regex is built from input.**
- **git is called through argv only** (`execFileSync('git', [...])`), with
  revisions validated and a `--` separator, a timeout and an output cap.
- **Readers.** `--from` and the ledger must resolve inside the realpath of
  `--repo`. Every path segment is `lstat`ed, and a symlink is reported as
  `not read: symlink`. Anything that is not a regular file is rejected. `--from`
  must end in `.json`. Inputs over 5 MB, ledgers over 20 MB, and more than 5000
  findings per input or 5000 changed paths per diff are reported as "not read"
  rather than truncated silently.
- **Parse errors** name the input (bounded) and the byte position only. The
  parser's own message is never printed, because it can quote file bytes.
- **`--out`** follows the sibling convention: parent directories are created,
  and a failed write is a clean `cannot write` message with exit 1.
- **The ledger is append-only**, and a label naming an unknown finding id is
  rejected.

## Assumptions made

- The 30-label floor applies per gate, to real + noise only (ADR 0025).
- `PRECISION_FLOOR` cannot be imported across the package boundary (skills ship
  without the engine), so it is mirrored, and a parity test reads
  `ts/src/guardian/adjudication.ts` and fails if the two disagree.
- A run without `--pr` still feeds the suppression rules, but never
  `guardian-covered-later`, which needs a first and a later run for one PR.
- When labels for one finding disagree, the latest one wins.
- The default ledger path follows canary-katana's `.canary/` convention. That
  directory is gitignored here, so the SKILL.md says to commit the ledger or
  point `--ledger` at a tracked path. Choosing that home is left to the tuner
  follow-up.
- The registry status becomes `shipped`, because
  `ts/test/bop-name-registry.test.ts` requires it once the directory exists
  (precedent: #1779). The claim note says the tuner is deferred.

## Success criteria

1. `record` takes guardian and scan-baseline-shaped JSON in, assigns ids that
   survive a line move, and never duplicates a finding.
2. Each derived rule labels its case and leaves the ambiguous cases unlabelled.
3. `label` rejects an unknown id; `escape` needs gate, `--by` and `--evidence`.
4. The ledger's existing bytes are unchanged by every command.
5. `report` exits 3 below the floor with "needs N more" per gate, prints counts
   and the "tuning is not built" caveat at or above it, and never prints a
   threshold.
6. Every security item above has a test.
