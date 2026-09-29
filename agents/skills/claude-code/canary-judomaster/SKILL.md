---
name: canary-judomaster
description: >
  Incident to regression test. Turns a pasted V8/Node or CPython stack trace
  into a regression brief (`canary judomaster brief`), hands the brief's
  requirement to the existing authoring path (`/canary-write-test`), then grades
  the generated test by running it (`canary judomaster verify`). A test counts
  as `reproduced` only when it fails AND its output carries the incident's error
  signature; a first-run pass is `not-reproduced` with a vacuity red flag. Use
  for "turn this stack trace into a regression test", "this bug escaped, make
  sure it can't again", or "write a test for this production error". NOT for
  Java/Go/Ruby/.NET traces (they abstain), NOT a test author itself (it composes
  canary-test-author), NOT promotion (that is canary-promote-test).
cli: canary judomaster
requires: [node>=20]
---

# Canary Judomaster

An escaped defect should leave behind a test that would have caught it. The
usual shortcut produces a regression test that passes against the very bug it
was written for, and a test nobody watched failing is indistinguishable from a
vacuous one. Judomaster makes the watching mechanical.

The commands parse, resolve and grade; this skill runs them, composes the
existing authoring path between them, and relays the verdict without softening
it.

## When to Use

- Someone pastes a stack trace from production, CI or a bug report and wants a
  regression test for it.
- An escape needs permanent coverage before the fix lands.

## When NOT to Use

- There is no stack trace, only a screenshot or a prose Slack thread: `brief`
  abstains, and there is nothing to resolve.
- The trace is Java, Go, Ruby or .NET: those formats abstain and are named.
- You want to prove the fix works: there is no fixed code yet. That first green
  run belongs to `canary-promote-test`.

## Usage

```bash
canary judomaster --help
```

That needs no inputs. `brief` reads a trace file (or stdin); `verify` runs one
test under `tests/generated/`.

## Workflow

1. **INTAKE.** Save the pasted trace (Slack `>` quotes, code fences and ANSI
   colour are fine) and build the brief from the repository root:

   ```bash
   canary judomaster brief trace.txt --json-out brief.json
   ```

   Exit `3` means no V8/CPython trace was recognised, or no frame resolves
   inside the repository. Relay the printed reason and stop; do not guess a
   suspect. Exit `2` means the input could not be read.

2. **AUTHOR.** Hand the brief's `requirement` to `/canary-write-test` (the
   `canary-test-author` agent), and tell it to write exactly one test to the
   brief's `outputPath` under `tests/generated/regression/`. Judomaster writes
   no test code of its own. The test must call the code and assert the correct
   behaviour; it must not quote the error text, because `verify` will not accept
   a signature match on text the test prints itself.

3. **VERIFY.** Run the generated test against the current code:

   ```bash
   canary judomaster verify <outputPath> --brief brief.json
   ```

   `verify` refuses any path outside `tests/generated/` (exit 2) without running
   anything.

4. **REPORT.** Relay the verdict verbatim:

   | Verdict                            | Exit | Meaning                                                        |
   | ---------------------------------- | ---- | -------------------------------------------------------------- |
   | `reproduced`                       | 0    | Failed, and the output carries the incident signature.         |
   | `not-reproduced`                   | 1    | Passed first time: VACUITY RED FLAG. The test catches nothing. |
   | `failed-other-reason`              | 1    | Red, but not for the incident's reason. Unverified.            |
   | `unverified — could not reproduce` | 3    | Could not collect or run it (timeout, spawn, unknown runner).  |

   Only after `reproduced` is the next step `canary-promote-test`. For any other
   verdict, fix the test (or the brief) and verify again.

## Rationalizations to reject

| Rationalization                              | Why it is wrong                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| "It passed, so the regression is covered."   | A first-run pass means the test never touched the defect.                   |
| "It went red, so it caught the bug."         | Red for an import error or a typo is `failed-other-reason`, unverified.     |
| "The runner timed out, call it reproduced."  | A run that did not finish proves nothing; it is `unverified`.               |
| "Drop `--brief` so any failure counts."      | With no signature, a failure can only ever be `failed-other-reason`.        |
| "Quote the error in the test so it matches." | A match on the test's own text proves nothing; it is `failed-other-reason`. |
| "Promote it now and check it later."         | Promotion comes after `reproduced`, never before.                           |

## Related skills

- `canary-generate-test` — the authoring pipeline this composes.
- `canary-promote-test` — moves a reproduced test into the committed suite.
- Guide: `docs/guides/incident-to-regression-test.md`
