---
name: canary-cry
description:
  Pre-launch "try to break it" sweep of ordinary user flows, run ahead of a
  launch, a client onboarding or a demo so a sales demo never has to explain
  away a bug. It abuses flows the way real people do (an impatient double-submit
  on a slow network, abandoning a multi-form flow after it wrote partial rows, a
  second user on a shared machine, a duplicated tab, a token that expires
  mid-flow) and judges by state corruption, not by rendering. This release ships
  the deterministic half. `validate` checks the declared .canary/cry/flows.json
  and targets.json and names the JSON path of every error; `matrix` emits the
  ranked scenario matrix (flows x abuse patterns, cut to a whisper, shout or
  scream budget) with no network and no agent; `run --live` gates a target
  (non-prod only, no override) and prints the hash-bound manifest a live run
  must be confirmed against. Execution against the target arrives in a later
  phase. NOT input fuzzing and NOT targeted bug pursuit (that is
  canary-huntress).
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Cry

A demo that dies on a double-click was never tested the way a nervous buyer
clicks. canary-cry sweeps **ordinary user flows** with the abuse real people
commit, and its success criterion is **state corruption**: the platform left in
a bad state, not a pixel out of place.

This phase ships the **Tier-0 half** by the definition in
[ADR 0015](../../../../docs/knowledge/decisions/0015-skill-capability-vocabulary.md):
`validate` and `matrix` are deterministic, need no network and call no agent. It
also ships the first half of the live tier: `run --live` applies the
confirmed-manifest gate of
[ADR 0046](../../../../docs/knowledge/decisions/0046-live-target-skills-confirmed-manifest-no-replay-no-finding.md)
and prints the manifest a run must be confirmed against. The executor that
actually drives the target, and `report`, arrive in later phases; until then
nothing is ever sent, and `report` exits 2 with `not yet supported` rather than
doing something smaller under the same name. The full design is
[the canary-cry spec](../../../../docs/changes/canary-cry/proposal.md).

This limit holds for every live run and is printed in every manifest:
server-side side effects (email, webhooks, payments) are NOT intercepted by
canary-cry.

## Quick start

```bash
canary skills run canary-cry -- --help
```

<!-- canary:illustrative -->

```bash
canary skills run canary-cry -- validate
canary skills run canary-cry -- matrix --amplitude whisper
canary skills run canary-cry -- matrix --target staging --amplitude shout --json
canary skills run canary-cry -- run --live staging
```

Start from the examples in this skill:
[`flows.example.json`](scripts/flows.example.json) and
[`targets.example.json`](scripts/targets.example.json). Copy them to
`.canary/cry/` in the project under test. Both files are meant to be committed,
and neither ever holds a secret.

## Inputs

`.canary/cry/flows.json` declares the flows to attack. The agent layer may draft
it later; the human confirms it, and the engine reads only the file.

- A flow has an `id`, a `risk` from 1 to 5, optional `criticalArea` (a path
  joined to `.canary/critical-areas.json`), `steps`, optional `invariants`, and
  optional `symptoms.selectors`.
- A step `action` is one of `goto`, `fill`, `click`, `select`, `press`,
  `waitFor`. `writes: true` marks a step that mutates server state;
  `awaitResponse: "POST /api/orders"` names the response it waits on. Patterns
  key off both.
- An invariant pairs a **read-only** `probe` with an `expect`. A probe is either
  `http` (`method` and a `/path` against the target's `baseURL`) or `shell` (an
  `argv` array, run with `execFile`, never a shell string). `expect` is
  `{ "jsonPath"?: "$...", "delta": n }` or `{ "equals": value }`. A probe that
  writes invalidates its own before/after comparison.
- Template values: `{{account.<K>.<field>}}`, `{{fixture.<name>}}` (from the
  top-level `fixtures` map) and `{{unique.<kind>}}`.
- Ids are lowercase letters, digits and `-`. A `:` is never legal: it separates
  the fields of a scenario id.

`.canary/cry/targets.json` declares where a live run may go: `prodHosts` (always
refused) and named `targets`, each with `baseURL`, `environment`, `hosts`,
optional `accounts` (each an env-var **name**, never a value) and optional
`auth` (`signIn` and `signOut` flow ids, and `sessionKeys` such as
`cookie:session`).

Unknown keys are errors in both files, so a typo such as `write` for `writes`
fails at the desk. A `"//"` key is a comment and is allowed in any object.

## `validate`

```text
canary-cry validate [--flows PATH] [--targets PATH]
```

Checks both files and cross-checks that `auth.signIn` and `auth.signOut` name
declared flows. Every error names the file and the JSON path at fault, and the
command exits 2:

```text
canary-cry: error: .canary/cry/flows.json: $.flows[0].steps[2].action: must be one of goto, fill, click, select, press, waitFor
```

`validate` checks **shape only**. Whether an `environment` may run and whether a
host is production are the live gate's rules (exit 4, ADR 0046), not schema
errors.

## `matrix`

```text
canary-cry matrix [--flows PATH] [--target NAME] [--targets PATH]
                  [--critical-areas PATH] [--amplitude A] [--seed N]
                  [--json] [--strict]
```

The ranked scenario matrix: every declared flow crossed with the abuse-pattern
catalog, ranked and cut to a budget.

- **Score** is `flow.risk x pattern.weight`, plus 2 when
  `.canary/critical-areas.json` has an area at or under the flow's
  `criticalArea` with `risk_score >= 0.7`. A flow ranks by its best scenario; a
  flow no pattern applies to is not ranked. Ties break on id.
- The first line prints the ranking source: `ranking: declared`, or
  `ranking: declared+critical-areas` when the critical-areas file is read. The
  default path is used when present. A path named with `--critical-areas` must
  exist, and a file that is present but malformed is an exit-2 error, never a
  guessed boost.
- **Scenario id** is `<flow>:<pattern>:i<n>:s<step>`, with the step's id.
- `--seed N` (default 0) is recorded in the matrix and feeds only `{{unique.*}}`
  test data at run time. It never selects a scenario.
- `--target NAME` reads `targets.json` and schedules the two target-scoped
  patterns. Without it they are listed on a
  `target-scoped patterns not scheduled (no --target)` line, never silently
  dropped. A named target that lacks what a pattern needs gets the same line
  naming the gap, such as `(target does not declare auth.sessionKeys)`. The
  matrix's `patterns` field lists only the patterns that applied. Patterns the
  whisper budget leaves out are the budget, not an omission, and are not listed;
  a listed pattern never changes the exit code.
- `--json` prints the canonical `canary.cry-matrix/1` document. The same flows,
  amplitude, seed, target and critical areas give byte-identical output.
- A matrix with no scenario prints `ABSTAINED: zero scenarios`. That is an
  abstention, not a pass: `--strict` turns it into exit 3.

| Amplitude | Radius      | Patterns | Rounds (intensity) |
| --------- | ----------- | -------- | ------------------ |
| `whisper` | top 3 flows | core     | i1                 |
| `shout`   | top 8 flows | all      | i1, i2             |
| `scream`  | all flows   | all      | i1, i2, i3         |

`scream` lists every round up to the ceiling. Stopping early after two barren
rounds is a property of a live run, not of the matrix.

## `run`

```text
canary-cry run --live NAME [--flows PATH] [--targets PATH] [--seed N]
               [--confirm SHA] [--strict]
```

The two-step gate in front of any live run
([ADR 0046](../../../../docs/knowledge/decisions/0046-live-target-skills-confirmed-manifest-no-replay-no-finding.md)).
Checks run in this order, and each one stops the run:

1. **Inputs.** Both files must validate (exit 2).
2. **Target gate** (exit 4, `canary-cry: refused: ...`). The target must be
   listed in `targets.json`, declare an `environment` of `local`, `dev`,
   `staging` or `preview` (exactly), and neither its `baseURL` host nor any
   `hosts` entry may overlap a `prodHosts` pattern. Overlap errs toward
   refusing: `*.example.com` also covers `example.com`, a port or trailing dot
   does not hide a host, and a wildcard `hosts` entry is refused when it could
   reach a prod host. There is no override flag. This check runs before any
   credential is read.

   A host pattern, in `prodHosts` or `hosts`, is an exact host (optionally with
   a port) or `*.<domain>`. Anything else (`api-*.example.com`, a scheme, a
   path) is a schema error (exit 2) caught by `validate`, because the gate would
   read an unsupported wildcard literally and it would never match.

3. **Accounts** (exit 2). Every account the target declares must name an env var
   that holds a JSON object. The error names the variable, never its value.
4. **Matrix.** Zero scenarios prints `ABSTAINED: zero scenarios` and writes
   nothing (exit 3 under `--strict`).

Without `--confirm`, `run --live` writes `manifest.json` to
`runs/<UTC stamp>-<sha8>/` beside the flows file (`.canary/cry/runs/` by
default), prints the manifest and its `manifest-sha`, and sends **no request**
to the target. The manifest lists every scheduled scenario, the flows it drives
in full (plus the target's sign-in and sign-out flows), the fixtures, every
write step, every probe **verbatim** (a shell probe's argv included), the egress
hosts, the account env var **names**, the amplitude and seed, and the
server-side limit line. `manifest-sha` is the sha256 of its sorted-key JSON.

With `--confirm SHA`, the manifest is **rebuilt from the files** (never read
back from the run dir) and its sha compared. A mismatch is exit 4: something
that would run has changed since the manifest was read, so re-run without
`--confirm` and read the new one. In this phase a matching sha still sends
nothing: there is no executor yet, so it exits 2 `not yet supported` and says
nothing was sent.

`run` executes `--amplitude whisper` only for now; `shout` and `scream` exit 2
`not yet supported` (the `matrix` command accepts all three).

## Abuse patterns

| Pattern            | Core | Weight | Applies to                                                  | Intensity 1 / 2 / 3                                   |
| ------------------ | ---- | ------ | ----------------------------------------------------------- | ----------------------------------------------------- |
| `multi-submit`     | yes  | 5      | each step with `writes`                                     | 2x @ no throttle / 3x @ 400 ms / 5x @ 3 s             |
| `abandon-midflow`  | yes  | 4      | each `writes` step that is not the last step                | back / reload / context.close()                       |
| `stale-optimistic` | no   | 4      | each step with `awaitResponse`                              | delay past UI timeout / fake 500 / drop               |
| `duplicate-tab`    | no   | 3      | each step with `writes`                                     | 2 / 3 / 3 tabs racing                                 |
| `token-expiry`     | no   | 3      | the first `writes` step, on a target with session keys      | before the write / between writes / before every step |
| `shared-machine`   | no   | 5      | the last step, on a target with accounts A and B and `auth` | sign-out / sign-out + back / no sign-out              |

## Exit codes

| Code | Meaning                                                                                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success. Advisory by default: an abstained matrix still exits 0 without `--strict`.                                                                                                                                                                         |
| `2`  | Usage or input error: an unknown flag or command, `report` or a not-yet-runnable amplitude (not yet supported), a file not found or not valid JSON, a schema error, an unset or non-object account env var, or a confirmed `run` this phase cannot execute. |
| `3`  | `--strict` and the matrix abstained (zero scenarios).                                                                                                                                                                                                       |
| `4`  | Refused by a safety gate (ADR 0046): an unlisted target, a disallowed environment, a `prodHosts` match, or a `manifest-sha` mismatch. Exit 4 means nothing else.                                                                                            |

Exit 1 today means only an unexpected exception (a crash, not a finding). Exit 1
for `--strict` and a state-verified corruption arrives with the executor; giving
the crash its own code is
[issue 1716](https://github.com/bop-clocktower/canary/issues/1716).

## Limits in this phase

- No live execution and no report: a confirmed `run` and `report` exit 2
  `not yet supported`, and nothing is ever sent to a target.
- `{{unique.<kind>}}` is checked for syntax only; the kinds are fixed with the
  runtime that generates them.
- Account references in flows (`{{account.<K>.<field>}}`) are not yet checked
  against a target's accounts or against the fields in an account's env var. The
  gate checks only that each declared account's env var holds a JSON object;
  resolving the references belongs to the executor that fills them.
