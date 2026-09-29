# canary judomaster — incident to regression test

Turn an escaped defect into one regression test, and only call it a regression
test once it has been watched failing for the incident's reason.

`canary judomaster` (#614) has two deterministic subcommands. `brief` turns a
pasted stack trace into a regression brief. `verify` runs the generated test
against the current code and grades it. Test authoring sits between them and
reuses the existing path (`/canary-write-test`, the `canary-test-author` agent);
judomaster writes no test code and calls no LLM. The spec is
[docs/changes/614-canary-judomaster/proposal.md](../changes/614-canary-judomaster/proposal.md).

## 1. Paste the trace

A stack trace alone is enough. Slack `>` quote markers, code fences and ANSI
colour are stripped before parsing. Two formats are recognised:

- V8 / Node (JavaScript and TypeScript): `at fn (path:line:col)`,
  `at path:line:col`, and `file://` URLs.
- CPython: `File "path", line N, in fn`.

Paths captured on another machine (`/app/src/...`, `/home/ci/work/repo/...`)
resolve by the longest path suffix that exists under `--root`. Dependency and
runtime frames (`node_modules`, `site-packages`, `node:` internals,
`<anonymous>`) are listed as `external`; a line past the end of the file is
listed as `stale` rather than dropped.

## 2. Build the brief

```bash
canary judomaster brief trace.txt --json-out brief.json
pbpaste | canary judomaster brief -
```

| Option              | Meaning                                         |
| ------------------- | ----------------------------------------------- |
| `[trace]`           | trace file; stdin when omitted or `-`           |
| `--root <dir>`      | repository root frames resolve against (cwd)    |
| `--json`            | print the brief as JSON instead of markdown     |
| `--json-out <file>` | also write the JSON brief (what `verify` reads) |

The brief names the suspect (the innermost frame that resolves in the
repository), the error signature (the first line of the error message, or the
error type when the message is empty, labelled `type-only`), the framework, the
output path under `tests/generated/regression/`, and a requirement string for
the author.

Exit `0` brief emitted; `3` no V8/CPython trace recognised, or no frame resolves
inside the root (the reason is printed); `2` the input could not be read.

## 3. Author the test

Hand the brief's `requirement` to `/canary-write-test` and have it write exactly
one test to the brief's `outputPath`. The canary-judomaster skill does this hop
for you.

## 4. Verify it

```bash
canary judomaster verify tests/generated/regression/total-typeerror.test.ts \
  --brief brief.json
```

| Option               | Meaning                                           |
| -------------------- | ------------------------------------------------- |
| `--brief <file>`     | brief JSON supplying the signature                |
| `--expect <text>`    | message text to confirm against, 8+ characters    |
| `--framework <name>` | override the brief's or the extension's framework |
| `--timeout <s>`      | run timeout in seconds (default 60)               |
| `--root <dir>`       | repository root (cwd)                             |
| `--json`             | print the verify result as JSON                   |

The framework comes from `--framework`, then the brief, then the extension:
`.py` is pytest, `.spec.*` or `.e2e.*` is Playwright, and other
`.ts/.js/.mts/.mjs` files are Vitest. The run goes through canary's framework
registry and test executor from the current directory, so run `verify` from the
repository root where the runner finds the project's config. For Vitest and
Playwright the registry command is `npx --yes ...`, which can download the
runner if the project does not have it installed.

The runner's own config still decides what it collects. If the project's Vitest
`include` does not cover `tests/generated/`, the run collects no tests and the
verdict is `unverified — could not reproduce`, never a pass.

`verify` refuses any test whose real path is outside `<root>/tests/generated/`
(exit 2) and runs nothing. It spawns a test runner, so an unconfined path would
be arbitrary execution.

## Verdicts

| Verdict                            | Exit | When                                                          |
| ---------------------------------- | ---- | ------------------------------------------------------------- |
| `reproduced`                       | 0    | the test failed and an error line carries the signature       |
| `not-reproduced`                   | 1    | the test passed on its first run (vacuity red flag)           |
| `failed-other-reason`              | 1    | the test failed, but not with the signature; unverified       |
| `unverified — could not reproduce` | 3    | nothing collected, timeout, signal, spawn error, no framework |

### The vacuity rule

A regression test written for a defect that still exists must fail. If it passes
on its first run it cannot tell the bug from the fix, so `verify` prints
`VACUITY RED FLAG: the test passed against the code it was written to catch` and
exits 1. Never report that as success.

A red run is not enough either: a test can fail on an import error, a typo or a
missing fixture. That is `failed-other-reason`. With neither `--brief` nor
`--expect` there is no signature to confirm against, so a failing run can only
ever be `failed-other-reason`, and the output says so.

The signature is matched on an error line, not anywhere in the output: the error
type from the brief (with any namespace, an `Uncaught` prefix or a Node
`[ERR_CODE]`), then the message. A code frame, console output or a diff that
happens to contain the message does not count, and neither does the message
under a different error type. A type-only signature (the trace had no message)
must be a specific type; a bare `Error` or `Exception` is too generic, so it is
`unverified` until you pass `--expect` with the message.

The signature has to come from the code under test, not from the test. A failing
assertion prints its own source, so a test that quotes the incident's error text
would match whatever actually made it fail. When the test file contains the
signature text (escaped quotes included), or a helper beside it under
`tests/generated/` does, `verify` reports `failed-other-reason` and asks for an
assertion on the correct behaviour instead. For every verdict except
`reproduced`, the report ends with the last lines of runner output so you can
see what the runner said.

Only after `reproduced` is the test ready for `canary-promote-test`.

## Non-goals

- Other trace formats (Java, Go, Ruby, .NET) abstain with exit 3 and say so.
- Screenshots and prose-only threads: with no frames there is nothing to
  resolve.
- Structured incident intake (postmortem records, SARIF findings) is a named
  follow-up on the same engine.
- Proving the fix works: there is no fixed code yet.
- Automatic promotion, automatic commits, or more than one candidate test per
  run.
