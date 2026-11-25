---
status: proposed
date: 2026-11-25
issue: 608
keywords:
  - exploratory-testing
  - state-corruption
  - abuse-patterns
  - scenario-matrix
  - playwright-codegen
  - state-probes
  - manifest-confirm
  - convergence
  - pre-launch
inputs:
  - issue #608 and its roadmap row (docs/roadmap.md:67)
  - brainstorming session 2026-11-25 (decisions D1–D7 below)
  - STRATEGY.md#tracks (Pre-release confidence)
---

# canary-cry — pre-launch "try to break it" sweep of ordinary user flows

## Overview

`canary-cry` is a timeboxed adversarial sweep of **ordinary user flows** ahead
of a launch, a client onboarding, or a demo — so a sales demo never has to
explain away a bug. It does not fuzz function inputs. It abuses flows the way
real people do: an impatient double- or triple-submit on a degraded network,
abandoning a multi-form flow after it already wrote partial rows, a second user
on a shared machine signing in over stale session/cache/autofill state, a
duplicated tab, a token that expires mid-flow, and an optimistic UI that shows
failure after the server already succeeded.

The success criterion is **state corruption** — the platform left in a bad state
— not a rendering defect. Every result says what broke, **how canary-cry
knows**, and how to replay it.

It advances the **Pre-release confidence** track (`STRATEGY.md#tracks`:
"adversarial exploration ahead of launches, client onboardings, and demos") and
feeds the escaped-defect ratio (`STRATEGY.md#key-metrics`: "caught pre-release
by a canary gate or exploratory sweep").

### Goals

- **G1.** Always emit a ranked **scenario matrix** from `flows.json` × the
  abuse-pattern catalog, with zero infra. Same input → byte-identical output
  (deterministic, no network, no agent).
- **G2.** Given an allowlisted non-prod target, **generate and run** one
  Playwright script per scenario and report `corrupted` / `symptom` / `clean` /
  `abstain` per scenario, each with its evidence fidelity.
- **G3.** Every finding is **replayable**: the generated spec, the runtime, the
  seed, the flow/pattern ids, and before/after probe values.
- **G4.** Live runs are **gated**: target allowlist, absolute prod refusal, a
  manifest bound to `--confirm <sha>`, browser egress lockdown.
- **G5.** Runs are **bounded and resumable**: an amplitude budget, K=2
  barren-round convergence, an intensity ceiling, optional `--max-wall`,
  checkpoints.
- **G6.** **Degrade loudly**: missing target Playwright, zero probes, or a wall
  stop each produce an explicit `ABSTAINED` / `PARTIAL` line, never a quiet
  clean.

### Non-goals

- Function-level / input fuzzing — property-based testing is a separate roadmap
  row (`docs/roadmap.md:101`).
- Target-directed bug pursuit — reserved for `canary-huntress`
  (`docs/naming-registry.md`).
- Load/performance testing (k6) and visual regression.
- Intercepting **server-side** side effects (emails, webhooks, payments). The
  manifest states the limit on every run; v1 does not solve it.
- Any prod target in v1.
- A shared `agents/skills/lib/contracts/` contract or QA-site integration
  (deferred; additive later because the output format is already versioned).

### Assumptions

- **Runtime:** Node.js ≥ 20 (`requires: [node>=20]`, as every JS skill).
- **Playwright location:** `cry run` is invoked from the project whose
  `node_modules` resolves `@playwright/test` and its installed browsers; the run
  dir lives under that project's `.canary/`, so the generated specs resolve the
  same install. If it does not resolve, the run abstains (see Verdicts).
- **One run per target + accounts at a time.** Concurrent runs against the same
  target with the same accounts would contaminate each other's before/after
  probes. Not enforced in v1 — a local lockfile would not protect a second
  machine; SKILL.md states it.
- **Reachability:** the target `baseURL` is reachable from the machine running
  `cry`; reachability is checked, not assumed (see Failure modes).
- **Probes are read-only.** A probe that mutates state invalidates its own
  before/after comparison; SKILL.md states this and the manifest shows every
  probe so the approver can see it (D6).
- **Accumulated state.** Scenarios run serially against state left by earlier
  scenarios; each uses fresh `{{unique.*}}` data. `delta` expectations tolerate
  accumulation; `equals` expectations scoped to a shared account may not, and
  SKILL.md recommends `delta` for account-scoped invariants.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                | Rationale                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Flows come from a declared `.canary/cry/flows.json`. The agent layer may **draft** it (from e2e specs, docs, or a crawl); the human confirms it. The deterministic engine reads only the file.                                                                                                          | The file is the reproducible contract; the agent only lowers authoring cost and never decides alone what gets attacked.                                                                                                                                |
| D2  | Generated `@playwright/test` scripts drive the app, executed by the **target's** Playwright. Playwright MCP is used only for post-run triage of a finding and can never produce one.                                                                                                                    | The script _is_ the repro (issue risk 3); feeds `canary-test-reporter` unchanged; canary adds no runtime dependency. **Deviation from the issue text**, which says "drives the app (Playwright MCP)".                                                  |
| D3  | Fidelity-labeled verdicts: a probe breach → `corrupted` (state-verified); a UI signal only → `symptom` (observed); no probe → `abstain`. A run in which every scenario abstained reports `ABSTAINED`, never "no corruption found".                                                                      | `STRATEGY.md#our-approach`: state how you know, degrade loudly. A zero denominator is not a pass.                                                                                                                                                      |
| D4  | Two-step gate: `run --live <t>` prints the manifest and its `manifest-sha` and makes **no target request**; `--confirm <sha>` executes. Prod refusal is absolute in v1 (no override). Browser egress to non-allowlisted hosts is aborted. The server-side limit is printed in every manifest.           | The hash binds approval to exactly what was shown; works for agents and CI where a TTY prompt cannot. **Deviation from the issue text**: "refuse prod by default" becomes absolute — demo hardening is non-prod by definition (YAGNI on the override). |
| D5  | `--amplitude whisper\|shout\|scream` is a deterministic **scenario budget**, not a wall-clock budget. Scream stops at K=2 consecutive barren rounds or the intensity ceiling (3). Optional `--max-wall` stops loudly with `PARTIAL` and a `--resume` path. Hour estimates are printed as guidance only. | Coverage stays deterministic across machines; bounds the token/wall-clock bomb (issue risk 2). **Deviation from the issue text**: scream is "bounded by convergence and ceiling", not "unbounded".                                                     |
| D6  | Every probe command in `flows.json` appears **verbatim** in the manifest, so the confirmed sha covers it.                                                                                                                                                                                               | An agent-drafted file can carry shell probes; approving them must be explicit, never implicit.                                                                                                                                                         |
| D7  | A self-contained skill CLI (`scripts/cli.mjs`), following `canary-savant` / `canary-shadow`. No `ts/src` change, no MCP tool, no `canary` subcommand.                                                                                                                                                   | Proven pattern; no ratchet churn on `ts/src` (cli.ts at its import ceiling); a shared contract can be promoted later additively.                                                                                                                       |

## Technical Design

### Inputs

Both files live in the **adopter's** repo and are meant to be committed. Neither
ever holds a secret value — accounts are referenced by environment-variable
**name**.

`.canary/cry/flows.json` (D1):

```jsonc
{
  "version": 1,
  "flows": [
    {
      "id": "checkout",
      "risk": 5, // 1–5, declared by the human
      "criticalArea": "src/checkout", // optional join to critical-areas.json
      "steps": [
        { "id": "open", "action": "goto", "url": "/cart" },
        {
          "id": "card",
          "action": "fill",
          "selector": "[name=card]",
          "value": "{{fixture.card}}",
        },
        {
          "id": "pay",
          "action": "click",
          "selector": "button[type=submit]",
          "writes": true,
          "awaitResponse": "POST /api/orders",
        },
      ],
      "invariants": [
        {
          "id": "one-order",
          "probe": {
            "http": {
              "method": "GET",
              "path": "/api/orders?user={{account.A.id}}",
            },
          },
          // or { "shell": { "argv": ["psql", "-tAc", "select count(*) from orders"] } }
          "expect": { "jsonPath": "$.length", "delta": 1 }, // or { "equals": <value> }
        },
      ],
      "symptoms": { "selectors": [".error-banner"] }, // optional extra UI signals
    },
  ],
}
```

- Step `action` is one of `goto | fill | click | select | press | waitFor`.
- `writes: true` marks a step that mutates server state; patterns key off it.
- `http` probes run through Playwright's `APIRequestContext` against the
  target's `baseURL`, so they obey the same host allowlist.
- `shell` probes are an **argv array** executed with `execFile` — never a shell
  string, so there is no shell interpolation of template values.
- `delta` is evaluated as `after − before` for one logical completion of the
  flow; a pattern that legitimately completes the flow once must yield exactly
  the declared delta.
- Template values: `{{account.<K>.<field>}}` (resolved from the env var named in
  `targets.json`), `{{fixture.<name>}}` (a flows-file `fixtures` map), and
  `{{unique.<kind>}}` (seed-derived unique test data).

`.canary/cry/targets.json` (D4):

```jsonc
{
  "version": 1,
  "prodHosts": ["*.example.com"], // always refused
  "targets": {
    "staging": {
      "baseURL": "https://staging.example.test",
      "environment": "staging", // local | dev | staging | preview — anything else refused
      "hosts": ["staging.example.test"], // browser + probe egress allowlist
      "accounts": {
        "A": { "env": "CRY_ACCOUNT_A" },
        "B": { "env": "CRY_ACCOUNT_B" },
      },
      "auth": {
        "signIn": "login",
        "signOut": "logout",
        "sessionKeys": ["cookie:session"],
      },
    },
  },
}
```

Each account env var holds a JSON object
(`{"email": …, "password": …, "id": …}`) read at run time only; its value is
never written to any run artifact. `auth.signIn` / `auth.signOut` name flows in
`flows.json`.

### Abuse-pattern catalog (`scripts/patterns.mjs`, data only)

| id                  | Weight | Applies to                                        | Intensity 1 → 2 → 3 (ceiling)                         | Abuse                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ------ | ------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `multi-submit` ★    | 5      | a step with `writes`                              | 2× @ no throttle → 3× @ 400 ms → 5× @ 3 s             | Fire the write step N times concurrently under `route()` latency.                                                                                                                                                                                                                                                            |
| `abandon-midflow` ★ | 4      | a `writes` step that is not the last step         | back → reload → `context.close()`                     | Abandon after write _k_, re-enter, complete the flow.                                                                                                                                                                                                                                                                        |
| `stale-optimistic`  | 4      | a step with `awaitResponse`                       | delay past UI timeout → fake 500 → drop               | Let the request reach the server (`route.fetch()`), then present a failure to the client, so the flow retries.                                                                                                                                                                                                               |
| `duplicate-tab`     | 3      | a `writes` step                                   | 2 → 3 → 3 tabs racing                                 | Several pages in one context, each advanced to the write.                                                                                                                                                                                                                                                                    |
| `token-expiry`      | 3      | flows on a target with `auth.sessionKeys`         | before the write → between writes → before every step | Clear the session keys mid-flow and continue.                                                                                                                                                                                                                                                                                |
| `shared-machine`    | 5      | targets declaring accounts `A` and `B` and `auth` | sign-out → sign-out + back → no sign-out              | A runs the flow; B signs in on the same context (cache, storage, autofill) and runs it; A's invariants are checked for both accounts, and a `cross-account-leak` symptom fires when B's page contains any value from A's account JSON — matched in memory, recorded by field name (`account.A.email`) only, never the value. |

★ = the _core_ set used by `whisper`. Each pattern also carries a fixed `weight`
used for ranking; the values above are the P1 values in `patterns.mjs`, and
`SKILL.md`'s pattern table is tested against them.

### Matrix (`scripts/matrix.mjs`, pure)

- **Score:** `flow.risk × pattern.weight`, `+2` when
  `.canary/critical-areas.json` has an area whose `path` lies under the flow's
  `criticalArea` with `risk_score ≥ 0.7` — the same high-risk cut
  canary-failure-impact and canary-katana use. The ranking source is printed
  (`ranking: declared` or `ranking: declared+critical-areas`). Ties break on id.
- **Budgets (D5):**

  | Amplitude | Radius      | Patterns | Rounds (intensity)                              | Indicative time    |
  | --------- | ----------- | -------- | ----------------------------------------------- | ------------------ |
  | `whisper` | top 3 flows | core     | i1                                              | ~30–60 min         |
  | `shout`   | top 8 flows | all      | i1, i2                                          | ~2–4 h             |
  | `scream`  | all flows   | all      | i1 → i3, stop after 2 consecutive barren rounds | bounded by ceiling |

  Indicative times are computed from scenario count in the manifest and are
  guidance, never the contract.

- **Scenario id:** `<flow>:<pattern>:i<n>:s<step>`.
- **Target-scoped patterns:** `token-expiry` and `shared-machine` need a target,
  so they are scheduled only with `--target <name>`. A budget pattern that
  cannot be scheduled is never silently dropped: it goes on the matrix's
  `unscheduled` list as `{pattern, reason}`, where `reason` is `no --target` or
  `target does not declare <what is missing>` (for example `auth.sessionKeys`,
  or accounts `A` and `B` and `auth`). The text output prints one
  `target-scoped patterns not scheduled (<reason>): <patterns>` line per reason.
  The matrix's `patterns` field lists only the patterns that applied. Patterns
  the `whisper` budget excludes (non-core) are the budget, not an omission, and
  are not listed as unscheduled.
- **Seed:** `--seed <int>` (validated like `canary-savant`'s — integer within
  ±(2^53 − 1), else exit 2). It feeds only `{{unique.*}}` test data, never
  scenario selection.
- Same `flows.json`, amplitude, and seed → byte-identical `matrix.json`.

### Gate and manifest (`scripts/gate.mjs`, `scripts/manifest.mjs`)

- `run --live <t>` validates both files and applies the target rules: an
  unlisted target, an `environment` outside the allowed set, or a `baseURL` /
  `hosts` entry matching `prodHosts` → **exit 4**, zero target requests.
- It then builds `manifest.json`: every scenario in the worst-case budget, every
  write step, every probe **verbatim** (D6), egress hosts, account env var
  **names**, amplitude, seed, and the fixed line _"server-side side effects
  (email, webhooks, payments) are NOT intercepted by canary-cry."_
- `manifest-sha` = sha256 of the canonical (sorted-key) manifest JSON. Nothing
  reaches the target until `--confirm <sha>` equals a **freshly rebuilt**
  manifest's sha; mismatch → exit 4.
- Without `--confirm`, `run --live` writes only the local run dir.
- **As shipped in P2:**
  - The run dir is `runs/<run-id>/` beside the flows file, which is
    `.canary/cry/runs/` with the default paths.
  - The manifest carries each driven flow in full (plus the target's
    `auth.signIn` / `auth.signOut` flows) and the `fixtures` map, so every value
    a run would type into the target is covered by the sha.
  - Overlap with `prodHosts` errs toward refusing. A `*.x` pattern also covers
    `x`. Ports and trailing dots are ignored. A wildcard `hosts` entry is
    refused when it could reach a prod host.
  - The gate runs before any account env var is read.
  - Until P3 there is no executor, so a **matching** `--confirm` exits 2
    `not yet supported` and sends nothing. Exit 4 stays reserved for a safety
    refusal.

### Codegen and runtime (`scripts/codegen.mjs`, `scripts/runtime/cry-runtime.mjs`)

- Writes `.canary/cry/runs/<run-id>/` (`run-id` = UTC timestamp + first 8 of the
  sha): `manifest.json`, `matrix.json`, `playwright.config.mjs` (JSON reporter,
  `workers: 1` because scenarios share accounts, `retries: 0`), a copy of
  `cry-runtime.mjs`, and one thin `specs/<scenario>.spec.mjs` per scenario:
  `test(id, ({ browser }) => runScenario(<inline scenario JSON>))`.
- The runtime, per scenario: installs the egress lockdown (non-allowlisted
  requests aborted and recorded); takes **before** probes; runs the flow with
  the pattern injected; takes **after** probes; collects UI signals —
  `pageerror`, `console.error`, responses ≥ 500 from target hosts, declared
  `symptoms.selectors`.
- Execution is `npx playwright test -c <run>/playwright.config.mjs` resolved in
  the **target project**. If `@playwright/test` does not resolve there, the run
  reports `ABSTAINED: no @playwright/test in target` (the matrix is still
  emitted).
- **The repro is the spec + runtime + seed**; each spec re-runs standalone.
- **As shipped in P3:**
  - A matching `--confirm` now executes; P2's exit 2 placeholder is gone. The
    executor (`scripts/execute.mjs`) is loaded by one lazy dynamic import from
    `cli.mjs`, so the static closure of `validate`, `matrix` and the pre-confirm
    gate stays offline (SC6). It works from the confirmed manifest alone, never
    from the input files.
  - The runtime is `scripts/runtime/` (six modules, `cry-runtime.mjs` the
    entry). Codegen copies the directory and `scripts/verdict.mjs` into the run
    dir in the same relative layout, so each spec's imports resolve in place.
    Each scenario writes `observations/<scenario>.json`; the verdict is judged
    inside the browser run, so a standalone re-run reaches the same fingerprint.
  - The target's Playwright CLI is resolved from the run dir
    (`@playwright/test/cli`) and launched with the running Node: the
    `npx playwright test -c` of this section, minus any chance of npx fetching a
    package the project does not have.
  - Probes run in **observer** contexts signed in on their own (as A; as A and B
    for `shared-machine`, whose B-side invariant ids read `<id>@B`), so a
    pattern that clears or swaps the session cannot blind its own comparison.
  - When the target declares `auth`, every scenario signs in as A first, except
    one whose flow is the sign-in flow itself.
  - `duplicate-tab` completes the flow in the first tab only: the race is the
    abuse, and one completion is what the delta describes.
  - A cross-account leak compares account A's values of 3 or more characters
    that B does not share, against B's page text and form field values. Every
    string the runtime records is redacted against the account values.
  - `{{unique.email}}` is `cry.<hash>@cry.invalid`; any other kind is
    `cry-<kind>-<hash>`, the hash derived from seed, scenario id and kind.
  - All six patterns are implemented at intensity 1. `whisper` schedules only
    the core two, and `run` executes only `whisper` until P4, so the other four
    are reachable from `run` only once P4 lifts the `shout`/`scream` refusal.
    The cry-e2e suite drives their intensity-1 round through the same executor.
    An intensity above 1 is refused (exit 2, and by the runtime itself), never
    run as intensity 1.
  - Verdict precedence, first match wins: `flow-broken`, `corrupted`,
    `probe-failed`, `symptom`, `no-probes`, `clean`. A symptom can stand on a
    flow with no invariants. A step that fails after the abuse point is a
    `step-failed` UI signal. A scheduled scenario with no observation abstains
    as `no-observation`, and one whose runtime threw as `runtime-error`.
  - Known limit: `token-expiry` at intensity 1 reports `corrupted` whenever the
    app correctly refuses the unauthenticated write, because `delta` means
    exactly one completion. Settling that is left to a later decision.

### Verdicts and convergence (`scripts/verdict.mjs`)

| Per scenario                        | When                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `corrupted` (state-verified)        | ≥ 1 invariant `expect` breached                                             |
| `symptom` (observed)                | no breach, ≥ 1 UI signal                                                    |
| `clean`                             | ≥ 1 invariant checked, no breach, no signal                                 |
| `abstain: no-probes`                | the flow declares no invariants                                             |
| `abstain: flow-broken@<step>`       | a step **before** the abuse point failed — a stale flow file, not a finding |
| `abstain: probe-failed@<invariant>` | a probe errored (see Failure modes)                                         |

- A run in which every scenario abstained reports `ABSTAINED` with the reasons
  counted.
- **Fingerprint** = flow + pattern + invariant id (or UI-signal kind); used for
  dedup and for barren-round detection (a round is barren when it adds no new
  fingerprint).
- A checkpoint is written after each scenario (`checkpoint.json`).
  `--resume <run-id> --confirm <sha>` re-verifies the sha against the rebuilt
  manifest (mismatch → exit 4) and skips completed ids. `--max-wall <duration>`
  elapsing → checkpoint, then `PARTIAL: n/m — resume with --resume <run-id>`.

### Failure modes

Every one of these follows the house rule that cannot-verify is a finding, never
a quiet clean:

| Condition                                                                                        | Behavior                                                                  |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `flows.json` / `targets.json` missing or unparseable                                             | exit 2, `flows file not found: <path>` / the JSON path at fault           |
| Matrix has zero scenarios (empty `flows`, or no pattern applies to any step)                     | `ABSTAINED: zero scenarios` (exit 3 under `--strict`)                     |
| An account env var is unset or not a JSON object                                                 | exit 2 naming the env var **name**, before any target request             |
| `--max-wall` / `--seed` malformed; `--resume` names an unknown run-id                            | exit 2                                                                    |
| Target unreachable at the post-confirm preflight (`GET baseURL`)                                 | `ABSTAINED: target unreachable` with the status or error, no scenario run |
| A probe errors — HTTP non-2xx or timeout, shell non-zero exit or 30 s timeout, `jsonPath` absent | that scenario → `abstain: probe-failed@<invariant>`, never `clean`        |
| Playwright exits without a `results.json`                                                        | `ABSTAINED: playwright crashed` with the last 20 stderr lines             |

### Outputs (`scripts/report.mjs`)

- `findings.json` — `"format": "canary.cry-findings/1"` (versioned inside the
  skill, D7): run metadata, per-scenario verdicts with fidelity, fingerprints,
  before/after probe values, blocked egress hosts, repro paths.
- `report.md` — verdicts ranked by fidelity then score, each with its replay
  command.
- Playwright's `results.json` is kept in the run dir, consumable unchanged by
  `canary-test-reporter`.

### CLI and exit codes

```text
cry validate  [--flows <p>] [--targets <p>]
cry matrix    [--flows <p>] [--targets <p>] [--target <t>] [--critical-areas <p>]
              [--amplitude <a>] [--seed <n>] [--json] [--strict]     # deterministic, no network
cry run --live <t> [--amplitude <a>] [--seed <n>] [--max-wall <d>]   # manifest + sha; no target request
cry run --live <t> ... --confirm <sha>                               # executes
cry run --resume <run-id> --confirm <sha>
cry report <run-id> [--json] [--strict]
```

| Code | Meaning                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Advisory run (the default), or `--strict` with no `corrupted`                                                                                                                                       |
| `1`  | `--strict` and ≥ 1 `corrupted`. From P1, `1` also means an unexpected exception (the `cli.mjs` catch-all); separating the two is [issue 1716](https://github.com/bop-clocktower/canary/issues/1716) |
| `2`  | Usage or schema error                                                                                                                                                                               |
| `3`  | `--strict` and the run `ABSTAINED`                                                                                                                                                                  |
| `4`  | Gate refusal — prod/unlisted target, environment not allowed, or sha mismatch. New canary-wide code, established by ADR 0046 beside ADR 0009's `3`                                                  |

`symptom` never fails `--strict`; only state-verified `corrupted` does.

### Capability axes (AGENTS.md vocabulary, ADR 0015)

- `validate`, `matrix`, `report`: deterministic, no network, no agent.
- `run`: non-deterministic (a live app), network, no agent.
- SKILL.md agent layer: agent; never produces a finding (D2).

### File layout

```text
agents/skills/claude-code/canary-cry/
  SKILL.md
  scripts/cli.mjs
  scripts/{schema,schema-core,schema-targets,patterns,matrix}.mjs   # P1
  scripts/{manifest,gate,codegen,verdict,report}.mjs                # P2–P5
  scripts/runtime/cry-runtime.mjs                                   # P3
  scripts/flows.example.json
  scripts/targets.example.json
agents/skills/test/canary-cry-*.test.ts
agents/skills/test/fixtures/cry-app/          # local fixture app with a planted double-submit bug
.github/workflows/cry-e2e.yml                 # advisory, path-filtered, real Chromium
```

Module map, as shipped:

- Offline, deterministic (Tier-0 closure):
  - [cli.mjs](../../../agents/skills/claude-code/canary-cry/scripts/cli.mjs):
    argument parsing and wiring for every command.
  - [schema.mjs](../../../agents/skills/claude-code/canary-cry/scripts/schema.mjs),
    [schema-core.mjs](../../../agents/skills/claude-code/canary-cry/scripts/schema-core.mjs),
    [schema-targets.mjs](../../../agents/skills/claude-code/canary-cry/scripts/schema-targets.mjs):
    the flows and targets schemas.
  - [patterns.mjs](../../../agents/skills/claude-code/canary-cry/scripts/patterns.mjs)
    and
    [matrix.mjs](../../../agents/skills/claude-code/canary-cry/scripts/matrix.mjs):
    the abuse-pattern catalog and the ranked matrix.
  - [gate.mjs](../../../agents/skills/claude-code/canary-cry/scripts/gate.mjs)
    and
    [manifest.mjs](../../../agents/skills/claude-code/canary-cry/scripts/manifest.mjs):
    the target refusal, the manifest and its sha.
  - [render.mjs](../../../agents/skills/claude-code/canary-cry/scripts/render.mjs):
    all text output.
- The executor, loaded by one lazy `import()` after the sha matches:
  - [execute.mjs](../../../agents/skills/claude-code/canary-cry/scripts/execute.mjs):
    orchestrates a confirmed run.
  - [codegen.mjs](../../../agents/skills/claude-code/canary-cry/scripts/codegen.mjs):
    the Playwright config and one spec per scenario.
  - [rundir.mjs](../../../agents/skills/claude-code/canary-cry/scripts/rundir.mjs):
    run-dir file I/O.
  - [playwright.mjs](../../../agents/skills/claude-code/canary-cry/scripts/playwright.mjs):
    resolves the target's `@playwright/test`, runs the preflight, and spawns
    Playwright.
  - [verdict.mjs](../../../agents/skills/claude-code/canary-cry/scripts/verdict.mjs)
    and
    [findings.mjs](../../../agents/skills/claude-code/canary-cry/scripts/findings.mjs):
    the per-scenario verdicts and `findings.json`.
- The runtime, copied into every run dir and loaded by the generated specs:
  - [cry-runtime.mjs](../../../agents/skills/claude-code/canary-cry/scripts/runtime/cry-runtime.mjs):
    the entry point.
  - [session.mjs](../../../agents/skills/claude-code/canary-cry/scripts/runtime/session.mjs):
    accounts, sign-in, and the cross-account leak check.
  - [abuse.mjs](../../../agents/skills/claude-code/canary-cry/scripts/runtime/abuse.mjs):
    the six patterns.
  - [steps.mjs](../../../agents/skills/claude-code/canary-cry/scripts/runtime/steps.mjs):
    flow steps.
  - [guard.mjs](../../../agents/skills/claude-code/canary-cry/scripts/runtime/guard.mjs):
    the egress lockdown and the UI signals.
  - [probes.mjs](../../../agents/skills/claude-code/canary-cry/scripts/runtime/probes.mjs):
    the state probes.

## Integration Points

### Entry Points

- New skill `agents/skills/claude-code/canary-cry/` (`cli: scripts/cli.mjs`,
  `requires: [node>=20]`), listed as `canary:canary-cry`, run via
  `canary skills run canary-cry -- <subcommand>`.
- No `commands/canary-cry.md` (recent skills such as savant and blackhawk ship
  none). No `ts/src` change, MCP tool, or `canary` subcommand (D7).

### Registrations Required

- `.claude-plugin/plugin.json` `skills` — add the skill path
  (`ts/test/plugin-skills.test.ts` fails on an unclassified skill).
- `harness.config.json` — add `canary-cry/scripts/cli.mjs` to both
  `entropy.entryPoints` and `performance.entryPoints` (P1). P3 adds
  `scripts/runtime/cry-runtime.mjs` to both blocks: the runtime is loaded only
  by generated specs and would otherwise read as dead code.
- `agents/skills/package.json` `format:check` — add
  `claude-code/canary-cry/scripts/**/*.{mjs,json}` (the examples are formatted
  too).
- `agents/skills/package.json` devDependencies — `@playwright/test` (exact pin),
  used only by the `cry-e2e` job.
- `docs/naming-registry.md:85` — `reserved` → `shipped` when the skill ships
  (`ts/test/bop-name-registry.test.ts`).
- `.canary/` is already gitignored (`.gitignore:6`); run dirs are never
  committed in this repo.

### Documentation Updates

- `AGENTS.md` Skills section — a canary-cry bullet; one line under "Tier-0 and
  the three capability axes" stating the axes above.
- `README.md` skills table.
- `docs/roadmap.md:67` — `planned` now, `done` at P5.
- `SKILL.md` — every subcommand, every exit code, a worked example, and the
  server-side side-effect limit stated prominently.
- `CHANGELOG.md` through the release flow.

### Architectural Decisions

- **D2 + D4 → ADR 0046**, _Live-target skills: confirmed-manifest gate and
  no-replay-no-finding._ canary-cry is the first canary skill that writes to an
  external system; the sha-bound confirm, absolute prod refusal, and "an agent
  action cannot produce a finding" set precedent for any later live skill
  (including `canary-huntress`).
- D1, D3, D5, D6, D7 stay in this spec — canary-cry-specific or already house
  patterns.

### Knowledge Impact

- Concepts: **abuse pattern** (distinct from an edge case and from a property),
  **state probe / invariant**, the `corrupted` › `symptom` › `abstain` fidelity
  ladder, **barren round**.
- Relationships: canary-cry _composes_ canary-edge-case-discovery,
  canary-critical-areas, canary-failure-impact, canary-company-knowledge (agent
  layer); _feeds_ canary-test-reporter (`results.json`); is _distinct from_
  canary-huntress (directed pursuit vs broad sweep).

## Success Criteria

Matrix:

- **SC1.** When `cry matrix` runs twice with the same `flows.json`, amplitude,
  and seed, the system shall emit byte-identical `matrix.json`. _(unit)_
- **SC2.** When amplitude is `whisper`, the matrix shall contain exactly the top
  3 flows by score × {`multi-submit`, `abandon-midflow`} × i1; `shout` and
  `scream` shall match the budget table exactly. _(unit, 10-flow fixture)_
- **SC3.** The system shall not schedule a pattern against a step it does not
  apply to. _(unit)_
- **SC4.** When `critical-areas.json` is present, ranking shall use it and print
  `ranking: declared+critical-areas`; when absent, `ranking: declared`. _(unit)_
- **SC5.** If `flows.json` or `targets.json` fails validation, then the system
  shall exit 2 naming the failing JSON path and shall not emit a matrix.
  _(unit)_
- **SC6.** The `validate`, `matrix`, and `report` code paths shall import no
  network or agent module. _(import-graph test, like
  `ts/test/guardian-agent-tier.test.ts`)_

Gate:

- **SC7.** If the `--live` target is unlisted, declares a disallowed
  `environment`, or has a `baseURL`/host matching `prodHosts`, then the system
  shall exit 4 and make zero target requests. _(unit, one per reason, request
  spy)_
- **SC8.** When `run --live` is invoked without `--confirm`, the system shall
  print the manifest and `manifest-sha`, write only the local run dir, and make
  zero target requests. _(unit + spy)_
- **SC9.** If `--confirm <sha>` does not equal the rebuilt manifest's sha, then
  the system shall exit 4; changing any flow, target, probe, amplitude, or seed
  shall change the sha. _(unit, field-by-field mutation)_
- **SC10.** The manifest shall list every probe verbatim, every write step, the
  egress hosts, account env var names, and the server-side limit line, and shall
  never contain an account env var's value. _(unit, planted secret)_

Live run:

- **SC11.** When the fixture app has the planted double-submit bug, a
  `multi-submit` scenario shall report `corrupted` with before/after probe
  values; against the fixed fixture it shall report `clean`. _(cry-e2e, real
  Chromium)_
- **SC12.** When a scenario reports `corrupted`, re-running its emitted spec
  standalone shall reproduce the same fingerprint. _(cry-e2e)_
- **SC13.** If the page requests a host outside the target's `hosts`, then the
  runtime shall abort it and record it in `findings.json`. _(cry-e2e)_
- **SC14.** If a step before the abuse point fails, then the scenario shall
  report `abstain: flow-broken@<step>`, never `corrupted` or `symptom`.
  _(cry-e2e, stale selector)_
- **SC15.** If no scenario was probed, or `@playwright/test` does not resolve in
  the target, then the run shall report `ABSTAINED` with the reason, and
  `--strict` shall exit 3. _(unit)_
- **SC16.** Under `--strict`, a run with only `symptom` verdicts shall exit 0;
  with ≥ 1 `corrupted` it shall exit 1. _(unit)_

Bounds:

- **SC17.** When a `scream` run has 2 consecutive rounds with no new
  fingerprint, it shall stop and print `converged after round <n>`; it shall
  never exceed intensity 3. _(unit, injected verdict sequences)_
- **SC18.** When `--max-wall` elapses, the system shall checkpoint and print
  `PARTIAL: n/m — resume with --resume <run-id>`; a resume shall skip completed
  ids; a resume whose rebuilt manifest differs shall exit 4. _(unit, injected
  clock)_

Registration and docs:

- **SC19.** `plugin-skills.test.ts`, `bop-name-registry.test.ts`, the entropy
  check, and `format:check` shall pass with the skill registered. _(existing
  gates)_
- **SC20.** ADR 0046 exists and is linked from this spec; `SKILL.md` contains a
  section for each of the five subcommands, the exit-code table rows `0`–`4`,
  and the literal server-side limit line. _(unit test reading SKILL.md +
  `harness check-docs`)_

Failure modes:

- **SC21.** If a probe errors, then that scenario shall report
  `abstain: probe-failed@<invariant>` and never `clean`. _(unit, HTTP 500 /
  shell exit 1 / missing jsonPath)_
- **SC22.** If the preflight `GET baseURL` fails, then the run shall report
  `ABSTAINED: target unreachable` and execute zero scenarios. _(unit, closed
  port)_
- **SC23.** If an account env var is unset or not a JSON object, then the system
  shall exit 2 naming the variable, before any target request. _(unit + spy)_
- **SC24.** If the matrix has zero scenarios, then the run shall report
  `ABSTAINED: zero scenarios`. _(unit)_
- **SC25.** When a `shared-machine` scenario renders any value from account A's
  JSON while signed in as B, the scenario shall report a `cross-account-leak`
  symptom naming the field (`account.A.<field>`), and no run artifact shall
  contain the value itself. _(cry-e2e, fixture leaks A's email; artifact grep)_

## Implementation Order

One PR per phase; each leaves `main` green. The gate (P2) lands before any code
that can reach a target (P3).

| Phase  | Delivers                                                                                                                                                                                                                                             | SCs                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **P0** | This spec + ADR 0046; roadmap row → `planned`                                                                                                                                                                                                        | —                           |
| **P1** | `schema`, `patterns`, `matrix`; `cry validate` / `cry matrix`; examples; plugin + entropy + format registrations. Flip `docs/naming-registry.md:85` to `shipped` — `bop-name-registry.test.ts` fails on a present directory still marked `reserved`. | SC1–6, SC19 (partial), SC24 |
| **P2** | `gate`, `manifest`; `run --live` prints manifest + sha; `--confirm` refuses everything (execution does not exist yet)                                                                                                                                | SC7–10, SC23                |
| **P3** | `codegen`, `runtime`, `verdict` (single round, all six patterns at i1); fixture app; `cry-e2e` workflow (advisory, path-filtered — never a required check while filtered)                                                                            | SC11–16, SC21–22, SC25      |
| **P4** | Rounds i2/i3, convergence, `--max-wall`, checkpoints, `--resume`. Until P4, `run` with `shout`/`scream` exits 2 `not yet supported` rather than silently running `whisper`; `matrix` supports all three amplitudes from P1.                          | SC17–18                     |
| **P5** | `report`; full SKILL.md agent layer (draft/confirm `flows.json`, skill composition, gate pause between plan and `--confirm`, MCP triage); AGENTS.md, README, roadmap `done`                                                                          | SC19–20                     |

P3 is the sizing risk. Its natural split, if needed: runtime + verdict for the
two core patterns first, the other four second.
