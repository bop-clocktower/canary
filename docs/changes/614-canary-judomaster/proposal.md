# canary-judomaster: stack trace to a regression test that was watched failing

**Issue:** #614 · **Route:** feature · **Slug:** `614-canary-judomaster`

**Keywords:** stack-trace, regression-test, incident, frame-resolution,
reproduction, vacuity, tests-generated, canary-write-test

## Overview

An escaped defect should leave behind a test that would have caught it. Today
that conversion is manual, and the usual shortcut produces a regression test
that passes against the bug it was written for (the failure mode on #486). A
test that was never seen failing is indistinguishable from a vacuous one.

`canary-judomaster` turns a production failure into one candidate regression
test and then grades that test by running it against the current code.

1. `canary judomaster brief <trace>` parses a pasted stack trace, resolves its
   frames to source files in the repository, and emits a regression brief. The
   brief names the suspect frame, the error signature, and a requirement string
   for the existing authoring path (`/canary-write-test`, `canary-test-author`).
2. The skill hands that requirement to the existing authoring path. The test is
   written under `tests/generated/regression/`. Judomaster writes no test code
   of its own.
3. `canary judomaster verify <test> --brief <brief.json>` runs the generated
   test and classifies the result. A test counts as `reproduced` only when it
   fails and the failure output carries the incident's error signature. A test
   that passes on the first run gets a vacuity red flag. A test that could not
   be run is labelled `unverified — could not reproduce`.

Promotion into a committed suite stays with `canary-promote-test`.

**Strategy grounding.** `STRATEGY.md#key-metrics` names the escaped-defect ratio
as the headline metric. This feature turns each escape into permanent coverage.
`STRATEGY.md#our-approach` calls for fidelity-labelled evidence over verdicts
and a deterministic Tier-0 engine with an optional agent layer on top. The brief
and verify commands are deterministic and import no LLM. Test authoring is the
optional agent tier, reached by composition.

## Goals

- G1. A pasted stack trace alone is enough input. Slack quote markers, code
  fences, and ANSI colour are tolerated. This is the MVP, not a fallback.
- G2. Frames resolve to real files in this repository even when the trace was
  captured on another machine (`/app/src/...`, `/home/ci/work/repo/src/...`).
- G3. Every generated test gets a verdict from a real run, and a pass is never
  reported as success.
- G4. Authoring is composed from the existing pipeline, never forked.

## Non-goals

- Structured incident intake: harness `harness-incident-response` postmortem
  records, SARIF security findings (issue comment 2), or pen-test findings.
  These are follow-up intake adapters on the same engine.
- Screenshots and prose-only Slack threads. With no frames there is nothing to
  resolve, so `brief` abstains and says so.
- Java, Go, Ruby, and .NET trace formats. The MVP covers V8/Node (JS/TS) and
  CPython tracebacks. Any other format abstains and is named.
- Proving the test passes once the defect is fixed. There is no fixed code yet.
  That first green is the re-test artifact `canary-promote-test` and #855 would
  consume.
- Automatic promotion, automatic commits, and generating more than one candidate
  test per run.
- An LLM call inside the CLI.

## Decisions made

| #   | Decision                                                                                                                                                                                                                                                                                                                    | Rationale                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Two deterministic subcommands, `brief` and `verify`. Authoring sits between them in the skill.                                                                                                                                                                                                                              | Authoring already lives in session (`agents/canary-test-author.md`, `commands/canary-write-test.md`), and there is no provider layer since v3.0 (`agents/skills/claude-code/canary-generate-test/SKILL.md`). Composing keeps the engine LLM-free (G4). |
| D2  | `reproduced` requires BOTH a non-zero exit AND the error signature in the run output. The signature is the first line of the error message. When that line is empty, the error type is used and the match is labelled `type-only`.                                                                                          | A test can fail for the wrong reason: an import error, a typo, or a missing fixture. "It went red" is not "it caught the defect". The issue calls step 3 the acceptance criterion.                                                                     |
| D3  | A pass on the first run is `not-reproduced` with a vacuity red flag, and exits 1.                                                                                                                                                                                                                                           | Binding constraint from the lane brief. It mirrors canary-cassandra's framing.                                                                                                                                                                         |
| D4  | Collection errors (vitest "No test files found", pytest exit 5, playwright "No tests found"), timeouts (124), spawn errors, and an unknown framework are all `unverified — could not reproduce`, exit 3 (`EXIT_ABSTAINED`).                                                                                                 | A config failure must never read as a reproduction or as a pass. It follows the no-silent-abstention convention (`ts/src/core/gate-result.ts:37`).                                                                                                     |
| D5  | A non-zero exit without the signature is `failed-other-reason`, exit 1, labelled unverified.                                                                                                                                                                                                                                | The run was red, but not for the incident's reason.                                                                                                                                                                                                    |
| D6  | `verify` refuses any test outside `<root>/tests/generated/` (exit 2), after realpath containment.                                                                                                                                                                                                                           | Generated tests land in `tests/generated/` and are promoted by `canary-promote-test`. `verify` spawns a runner, so an unconfined path would be arbitrary execution. The MCP `run_tests` makes the same argument (`ts/src/mcp-server.ts:611`).          |
| D7  | Frame resolution tries the path as given (inside root) first. Otherwise it matches the longest path suffix that exists under the root. `node_modules`, `site-packages`, `node:` internals, and `<anonymous>` frames are named as `external` and not resolved. A line past the end of the file resolves with a `stale` flag. | Traces come from other machines (G2). Source drift is common after a deploy, and it should be visible rather than silently dropped.                                                                                                                    |
| D8  | The engine lives in `ts/src/analysis/judomaster/`. The CLI lives in `ts/src/judomaster/judomaster-cli.ts` and is mounted through `READINESS_COMMANDS`.                                                                                                                                                                      | Follows the manhunter and rewind precedent: the filename binds the `cli` layer, and no existing module grows. Nothing goes under `ts/src/history` (#1074).                                                                                             |
| D9  | Framework is inferred from the extension: `.py` gives pytest; `.spec.*` or `.e2e.*` gives playwright; other `.ts/.js/.mts/.mjs` gives vitest. `--framework` overrides it. Execution goes through `deps.makeExecutor()`, which is `CanaryTestExecutor` and the framework registry.                                           | Reuses the existing registry and executor instead of a new runner.                                                                                                                                                                                     |
| D10 | Closing keyword is `Refs #614`, not `Closes`.                                                                                                                                                                                                                                                                               | The issue asks for postmortem-record intake "where one exists". This PR ships only the stack-trace path. Structured intake is a named follow-up.                                                                                                       |

### Approaches considered

- **A (chosen).** Deterministic `brief` and `verify` with authoring composed by
  the skill. The gate is reproducible and testable without an LLM. It costs one
  extra hop in the skill.
- **B.** A skill-only workflow with no CLI, where the agent parses the trace and
  judges the run. It is cheap to build, but the reproduced/not verdict becomes
  agent judgment. That is the exact place a vacuous test gets called "caught".
  Rejected because D2 and D3 would not be enforceable.
- **C.** A CLI that also generates the test from templates. Templates cannot
  construct inputs that trigger a specific defect, so the test would be vacuous
  by construction. It would also fork the authoring pipeline. Rejected under G4.

### Amendments after review

The harness-code-review pass found that a bare substring match could call the
wrong run `reproduced`. The shipped behaviour tightens D2, D4, D7 and D9:

- **A1 (D2).** The brief's signature carries the error type. A message signature
  must appear on an error line (type, with any namespace, `Uncaught` prefix or
  Node `[ERR_CODE]`, then `: message`). A type-only signature must be a specific
  type on its own error line. A bare `Error` or `Exception` is too generic and
  is `unverified` until `--expect` gives the message. `--expect` has no type, so
  it needs at least 8 characters.
- **A2 (D2).** If the test or a sibling file under `tests/generated/` quotes the
  signature text (escaped quotes included), the run is `failed-other-reason`,
  because a failing assertion prints its own source.
- **A3 (D4).** A signal death (negative exit code) is `unverified`. Pytest exit
  2 stays `unverified`, and its reason says it may be an import-time defect.
  Every non-reproduced report ends with the runner's output tail.
- **A4 (parse, D7).** The signature is the error line that owns the frames:
  nearest above the first V8 frame, or first after the last CPython frame.
  `dist-packages` and `lib/pythonX` frames are external. A suffix match keeps at
  least two path segments.
- **A5 (D9).** The framework comes from `--framework`, then the brief, then the
  extension, because `.spec.ts` is ambiguous.

## Technical design

### Types (`analysis/judomaster/types.ts`)

```ts
type TraceFormat = 'v8' | 'python';
interface RawFrame {
  file: string;
  line: number;
  column?: number;
  fn?: string;
}
interface ParsedTrace {
  format: TraceFormat;
  errorType: string;
  message: string;
  frames: RawFrame[];
} // innermost first
type FrameStatus = 'resolved' | 'stale' | 'external' | 'missing';
interface ResolvedFrame extends RawFrame {
  status: FrameStatus;
  path?: string;
  excerpt?: string[];
}
interface RegressionBrief {
  schema: 'canary-judomaster-brief/1';
  format: TraceFormat;
  errorType: string;
  message: string;
  signature: { text: string; kind: 'message' | 'type-only' };
  suspect: ResolvedFrame | null; // innermost resolved/stale frame
  frames: ResolvedFrame[];
  framework: string;
  outputPath: string; // tests/generated/regression/<slug>.<ext>
  requirement: string; // the /canary-write-test prompt
}
type VerifyVerdict =
  'reproduced' | 'not-reproduced' | 'failed-other-reason' | 'unverified';
```

### Modules

- `parse.ts`: `normalizeTrace` strips ANSI, leading `>` quote markers, and code
  fences. `parseTrace` handles V8 `at fn (path:line:col)`, `at path:line:col`,
  and `file://` URLs, plus CPython `File "path", line N, in fn`. It returns
  `ParsedTrace | null`.
- `resolve.ts`: `resolveFrames(frames, root)` implements D7 and reads a ±2 line
  excerpt.
- `brief.ts`: `buildBrief(trace, frames)` builds the signature, suspect,
  framework, output path, and requirement.
- `verify.ts`: `classifyRun(exec, signature)` is a pure function that implements
  D2 to D5. `inferFramework(path)` implements D9.
- `render.ts`: markdown renderers for the brief and the verify report.

### CLI

```text
canary judomaster brief [trace]    # file path, or stdin when omitted or "-"
    --root <dir>  --json  --json-out <path>
    exit 0 brief emitted; 3 no trace recognised or no in-repo frame; 2 unreadable input
canary judomaster verify <test>
    --brief <brief.json> | --expect <text>   --framework <name>  --timeout <s>  --root <dir>  --json
    exit 0 reproduced; 1 not-reproduced / failed-other-reason; 3 unverified; 2 usage
```

With neither `--brief` nor `--expect`, a failing run can only ever be
`failed-other-reason`, because there is no signature to confirm against. This is
stated in the output.

### Skill

`agents/skills/claude-code/canary-judomaster/` holds `SKILL.md` and
`skill.yaml`, with `cli: canary judomaster` and `requires: [node>=20]`. The
phases are INTAKE (paste, then `brief`), AUTHOR (the `canary-test-author` agent
via `/canary-write-test`, with the brief's `requirement` and `outputPath`),
VERIFY (`verify --brief`), and REPORT (relay the verdict verbatim; never soften
`unverified` or `not-reproduced`). `canary-promote-test` is the next step, and
only after `reproduced`.

## Integration Points

### Entry Points

- New CLI command `canary judomaster` with the subcommands `brief` and `verify`.
- New skill `canary-judomaster`.

### Registrations Required

- Append `judomaster` to `READINESS_COMMANDS`
  (`ts/src/commands/readiness/cli.ts`) and to `EXPECTED_COMMANDS`
  (`ts/test/cli-command-registry.test.ts`).
- `agents/skills/README.md`: tree entry, count, and description.
- `docs/naming-registry.md`: `canary-judomaster` goes from reserved to shipped.
- Arch allowance `.harness/arch/allowances/feat-614-canary-judomaster.json` plus
  a baseline floor refresh, if module-size grows (it will).
- Entropy: no new entryPoints are expected. Everything new is imported through
  the CLI registry. Add entries append-only only if the ratchet names a file,
  and never raise `maxFindings`.

### Documentation Updates

- `docs/guides/incident-to-regression-test.md` plus an entry in
  `docs/guides/index.md`.
- A `CHANGELOG.md` Unreleased entry.
- The `docs/roadmap.md` row gets its spec and plan links and status.

### Architectural Decisions

None warrant a standalone ADR. D2 (signature-confirmed reproduction) is specific
to this feature and is recorded here.

### Knowledge Impact

The concept "reproduction verdict: reproduced / not-reproduced /
failed-other-reason / unverified" and the rule "a regression test is evidence
only once watched failing for the incident's reason".

## Success Criteria

1. When a V8 or CPython trace is piped to `canary judomaster brief`, the system
   shall emit a brief naming the innermost in-repo frame as the suspect, even
   when the trace's absolute paths come from another machine.
2. If the input has no recognisable frames, or no frame resolves inside the
   root, then `brief` shall exit 3 and name the reason, never exit 0.
3. When the generated test fails and its output contains the signature, `verify`
   shall report `reproduced` and exit 0.
4. When the generated test passes, `verify` shall report `not-reproduced` with a
   vacuity red flag and exit 1.
5. When the run fails without the signature, `verify` shall report
   `failed-other-reason`, labelled unverified, and exit 1.
6. When the runner cannot collect or run the test (no tests found, timeout,
   spawn error, unknown framework), `verify` shall report
   `unverified — could not reproduce` and exit 3.
7. If the test path is outside `<root>/tests/generated/`, `verify` shall exit 2
   without spawning anything.
8. All fixtures are synthetic, and the four gates plus the CI ratchets are
   green.

## Implementation Order

1. Parser and resolver (types, `parse.ts`, `resolve.ts`) with unit tests over
   synthetic V8 and Python traces, including messy pastes.
2. `buildBrief` and `classifyRun` with `inferFramework`, as pure functions with
   unit tests covering every verdict.
3. The CLI (`brief`, `verify`), the registry wiring, and CLI tests with an
   injected executor.
4. The skill, guide, README, naming registry, changelog, and roadmap.
5. Ratchets: arch allowance and floor, entropy and dead-exports check, perf.
