# canary-judomaster: deferred review follow-ups (chain, cwd, mocks, containment)

**Issue:** #1138 (slice) · **Route:** feature · **Slug:**
`1138-judomaster-review-followups` · **Builds on:**
`docs/changes/614-canary-judomaster/proposal.md` (#614, merged in #1139)

**Keywords:** stack-trace, exception-chain, root-cause, runner-cwd, npx-fetch,
vacuous-mock, path-containment

## Overview

The judomaster MVP (#1139) shipped with four review suggestions deferred to
issue #1138. Each is a place where the tool can mislead its user:

1. A chained exception (V8 `[cause]:`, CPython `raise ... from` / "During
   handling of the above exception") is flattened today. The brief names the
   wrapper and its frames, and the root cause sits unlabelled in the frame list.
2. `verify` spawns the runner from the process cwd, not `--root`, and the
   registry command for Vitest and Playwright is `npx --yes ...`, which fetches
   a runner from the network when none is installed.
3. A generated test that mocks the suspect module (`vi.mock`, `jest.mock`,
   `mock.patch`, `monkeypatch`) cannot exercise the defect. It can still go red
   for an unrelated reason and nothing says so.
4. Containment is a string-prefix check (`real.startsWith(root + sep)`). With
   `--root /` the prefix is `//`, so every frame reads `missing`.

The intake adapters (harness incident-response records, SARIF, pasted pen-test
findings) and the Java/Go/Ruby/.NET trace formats stay open in #1138. They are
non-goals here.

## Decisions made

Autonomous fleet lane: each decision takes the recommended option, recorded as
an assumption in `provenance.json`.

| #   | Question                                          | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Which error does the signature sit on in a chain? | Still the **reported** (outermost) error. That is the line the runner prints first and `verify` already anchors on it. The chain is added information, it does not move the signature.                                                                                                                                                                                                                                                                                                                                                                        |
| C2  | Does the suspect move to the root cause?          | No. The suspect stays the first in-repo frame (unchanged MVP behaviour). Each chain link gets its own in-repo frame, and the root cause's frame is named in the requirement.                                                                                                                                                                                                                                                                                                                                                                                  |
| C3  | How are boundaries represented?                   | `ParsedTrace.chain?` and `RegressionBrief.chain?`: one entry per cause, `{ errorType, message, relation: 'cause' \| 'context', start }`. `start` indexes into the existing flat `frames` list. The field is absent for an unchained trace, so the MVP's JSON is byte-identical for it. Schema stays `canary-judomaster-brief/1` (additive optional field).                                                                                                                                                                                                    |
| C4  | Auto-fetch the runner?                            | **No.** `verify` runs with `npx --no` (the `--yes` / `-y` flag is replaced). A missing runner is `unverified — could not reproduce` with a message naming it and saying `verify` does not fetch runners. Nothing in the MVP depends on fetching: the registry is shared, so the rewrite is an executor option that only `verify` sets; `canary run` and MCP `run_tests` keep their behaviour.                                                                                                                                                                 |
| C5  | Where does the runner run?                        | `cwd = --root` (default stays the process cwd). The test path is already an absolute realpath, so only config/rootdir discovery changes.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C6  | Mocking the suspect: warning or verdict change?   | Warning only. `VerifyResult.warnings?: string[]`, rendered under the verdict and present in `--json`. The verdict and exit code are unchanged. It needs the brief's suspect, so without `--brief` the check does not run and the output does not mention it.                                                                                                                                                                                                                                                                                                  |
| C7  | What counts as mocking the suspect?               | JS/TS: `vi.mock` / `vi.doMock` / `jest.mock` / `jest.doMock` whose string specifier resolves (relative to the test) to the suspect path, extensions ignored, or a bare / `@/` / `~/` specifier that is a path suffix of it. Python: `patch` / `mock.patch` / `mocker.patch` / `monkeypatch.setattr` / `monkeypatch.delattr` with a dotted string target inside the suspect module (any dotted suffix of 2+ segments, or the whole module path). Object forms (`patch.object(total, ...)`, `monkeypatch.setattr(total, ...)`) match on the module's stem name. |
| C8  | Containment check                                 | One helper, `isWithin(base, candidate)`, built on `path.relative()`: not empty, not `..` or `../...`, not absolute. It replaces both prefix checks (frame resolution and `tests/generated` containment).                                                                                                                                                                                                                                                                                                                                                      |

Approaches considered for C3: (A) split `frames` into per-error lists, which
changes MVP output and suspect selection for every chained trace; (B) annotate
each frame with a link index, which adds a field to every frame of every brief;
(C) a side list of boundaries indexing into `frames` (chosen). C keeps the
unchained brief identical and keeps one ordering for the frame list.

## Technical design

- `ts/src/analysis/judomaster/types.ts`: `ChainLink`, `ParsedTrace.chain?`,
  `RegressionBrief.chain?` (each link plus its own in-repo frame).
- `parse.ts`: V8 `[cause]: <ErrorLine>` lines open a link (relation `cause`);
  the `... N lines matching cause stack trace ...` elision is ignored. CPython
  splits on the two separator sentences; the reported error is the last printed
  block, and links run outward-in to the root cause (the first printed block).
  If any block has frames but no error line, the chain is dropped and the trace
  parses exactly as before.
- `brief.ts`: per-link in-repo frame; when a chain exists the requirement adds
  one sentence naming the root cause and where it was raised.
- `render.ts`: `## Exception chain (reported first)` section with the root cause
  marked, and `--- caused by` / `--- while handling` boundary lines in the frame
  list. Verify renders `WARNING:` lines.
- `resolve.ts`: `isWithin()`; `verify.ts` uses it too.
- `resolve.ts` (not `verify.ts`, which would cross the 300-line perf threshold):
  `mockedSuspectWarnings(testSource, testRelDir, suspectPath, suspectFn?)`
  returning warning strings. A whole-module mock or a patch of the suspect
  function is the strong warning; a partial mock or another name inside the
  module is a soft "check it is a dependency" warning (review amendment).
- `verify.ts`: a separate `npxCanceled()` after `couldNotRun` recognises npm's
  own `npx canceled due to missing packages` stderr line on a non-zero exit and
  names the runner.
- `core/executor.ts`: `execute(file, framework, timeout, opts?)` with `opts.cwd`
  and `opts.fetch` (default `true`, existing callers unchanged).
- `judomaster-verify-cli.ts`: passes `{ cwd: root, fetch: false }` and the
  warnings.

## Integration points

- **Entry points:** none new. `canary judomaster brief` and `verify` gain
  output; `CanaryTestExecutor.execute` gains an optional options argument.
- **Registrations required:** none.
- **Documentation updates:**
  `agents/skills/claude-code/canary-judomaster/SKILL.md`,
  `docs/guides/incident-to-regression-test.md` (the cwd / `npx --yes` paragraph
  is now wrong), `CHANGELOG.md` (Unreleased).
- **Architectural decisions:** none rise to an ADR (small, local changes).
- **Knowledge impact:** none beyond the guide.

## Success criteria

- When a V8 trace carries `[cause]:`, the brief lists the chain with the root
  cause marked, and the frame list shows a boundary before the cause's frames.
- When a CPython trace has "The above exception was the direct cause..." or
  "During handling of the above exception...", the chain is listed with the
  matching relation, and the reported error is still the signature.
- An unchained trace produces the same brief JSON as before (no `chain` key),
  except that a Node frame line ending in `{` (an error with own properties,
  such as a system error's `code`) is now read as a frame instead of dropped.
- `verify` spawns the runner with `cwd` equal to `--root`, and with `npx --no`
  in place of `npx --yes`.
- When npx refuses because the runner is missing, the verdict is
  `unverified — could not reproduce` (exit 3) and the reason names the runner.
- When the generated test mocks the suspect module in any of the C7 forms,
  `verify` prints a warning naming the mock and the suspect; the verdict and
  exit code are unchanged. A mock of a different module produces no warning.
- `resolveFrames(frames, '/')` resolves an absolute in-repo frame; a frame under
  `/x/repo-other` never resolves against root `/x/repo`.

## Implementation order

1. Containment helper (item 4), test-first.
2. Runner cwd and no-fetch (item 2): executor option, verify wiring, npx-cancel
   classification.
3. Mock-the-suspect warning (item 3).
4. Exception-chain boundaries (item 1): parser, brief, renderer.
5. Docs: SKILL.md, guide, CHANGELOG; ratchets (arch allowance if module-size
   grows).
