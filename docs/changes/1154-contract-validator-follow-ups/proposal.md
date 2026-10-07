# Contract validator follow-ups (#1154)

**Keywords:** canary-contracts, validator, real-dates, repo-relative, non-blank,
utf-8-bom, denominator, canary.site/1

## Overview

The code review of #1153 (phase 1 of #1151) left five suggestions against the
zero-dependency QA contract validator in `agents/skills/lib/contracts/`. Each
one is a document the validator accepts, or a count it reports, that misstates
what was checked:

- **S2** `2026-02-30T00:00:00Z` passes `real-dates`: `Date.parse` rolls an
  impossible day of month over into the next month instead of returning NaN
  (`rules.mjs` `realDates`).
- **S3** `../outside.spec.ts` and `~/x.spec.ts` pass as repo-relative `file`
  values. The `repoPath` pattern in `run.v1.schema.json` refuses only a leading
  `/` and a drive letter.
- **S4** `" "` passes everywhere a non-empty string is required, because
  `minLength: 1` counts whitespace.
- **S7** A file saved with a UTF-8 byte-order mark is reported as
  `not parseable JSON: Unexpected token`, which does not say why.
- **S8** A site feed's `checked` count is `1 + runs + assessments`; the
  `flaky[]` and `register[]` rows are validated but not counted.

Goal: close all five in the validator only. The three `*.v1.schema.json` files,
the document shape and the exit codes do not change.

Out of scope: the phase-2 cross-record invariants listed under "Deferred to
phase 2" in `docs/specs/canary-site-feed-contract.md`; `canary-starling`'s
producer code (lane #1200 is editing it concurrently).

## Decisions made

Taken autonomously with the recommended default; recorded as assumptions in
`provenance.json`.

| #   | Decision                                                                                                                                                                                                                                                                                                                         | Rationale                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **S2:** `real-dates` reads the timestamp's own fields and requires a real calendar date and clock: month 1–12, a day that exists in that month (leap years included), hour ≤ 23, minute and second ≤ 59, offset hour ≤ 23 and offset minute ≤ 59. `Date.parse` is no longer the judge.                                           | `Date.parse` silently normalizes `02-30` to `03-02`, so a reader would date the record two days late with no error. A leap second (`:60`) is refused, as `Date.parse` already refused it.                                                                                                                     |
| D2  | **S3:** a new rule, `repo-relative`, on every `file` (`results[]`, `collected[]`, site `flaky[]`, `register[]`). It refuses a path whose first segment is `~` or `~user`, a path that starts with `\` (Windows root or UNC), and a path whose `..` segments climb above the repository root. `/` and `\` both separate segments. | ADR 0029 makes `file` the join key, in the form `git ls-files` prints. A path the pattern cannot express (it would need path normalization) belongs in `rules.mjs`, per that module's header. `a/../b` stays legal: it does not escape, and refusing it is a style rule nobody asked for.                     |
| D3  | **S4:** the interpreter's `minLength` refuses a whitespace-only string when the minimum is ≥ 1, with the message `must not be blank`. Documented as the contract rule `non-blank`.                                                                                                                                               | One change covers every non-empty field, including ones a later minor adds, with no field list to drift. The alternative, a per-field rule in `rules.mjs`, lists about 30 paths across four record kinds. The divergence from stock JSON Schema `minLength` is stated in `schema-check.mjs` and in the specs. |
| D4  | **S7:** strip one leading U+FEFF before `JSON.parse` in `validateText`.                                                                                                                                                                                                                                                          | The issue prefers stripping, and no ADR or contract doc says refuse. A BOM does not change the JSON's meaning. Stripping in `validateText` covers the CLI (file and stdin) and API callers alike. Only one leading BOM is stripped; a BOM anywhere else is still a parse error.                               |
| D5  | **S8:** a site feed's `checked` is `1 + runs + assessments + flaky + register`. `scopes[]` and `suites[]` stay uncounted.                                                                                                                                                                                                        | `flaky[]` and `register[]` rows carry their own rules (`real-dates`, `register-no-author`, the new `repo-relative`), so they are validated records. `scopes[]` and `suites[]` entries are keys that records refer to, not records. The issue names only `flaky[]` and `register[]`.                           |
| D6  | All five are validator-only tightenings. No schema file changes.                                                                                                                                                                                                                                                                 | ADR 0035 and the additive rule (ADR 0030): a schema's documented shape does not change within a major. Each item refuses values the specs already describe as invalid ("real instant", "repo-relative", "non-empty"), or changes a count. Nothing is a new field.                                             |

Approaches considered for S4 (the only item with a real fork):

- **A) Interpreter `minLength` refuses blank (chosen).** Low complexity, no
  field list. Tradeoff: canary's `minLength` is stricter than stock JSON Schema,
  so a producer validating with another library could pass a value canary
  refuses. That is already true of every `rules.mjs` rule.
- **B) Named `non-blank` rule over an explicit field list.** Keeps the
  interpreter's keyword semantics stock. Tradeoff: about 30 paths, nested in
  four record kinds, that must be kept in step with three schemas by hand. A
  field added later would be silently uncovered.

## Technical design

- `rules.mjs`
  - `realDates` keeps its signature and paths. Its predicate becomes
    `isRealInstant(value)`: the timestamp pattern is captured, and each field is
    range-checked; the day is checked against
    `new Date(Date.UTC(y, m, 0)).getUTCDate()`. A string that does not match the
    pattern is left to the schema's `pattern` error, as before.
  - New `repoRelative(...paths)` rule factory, added to the run rules for
    `results[i].file` and `collected[i].file`, and to the site rules for
    `flaky[i].file` and `register[i].file`. It skips non-strings, so a
    wrong-typed value is reported once, by the schema. The message names why:
    `escapes the repository root (ADR 0029)`,
    `is home-relative (~), not repo-relative (ADR 0029)`, or
    `is absolute (\), not repo-relative (ADR 0029)`.
- `schema-check.mjs` — `checkMinLength` reports `must not be blank` when
  `min >= 1`, the length is satisfied and `value.trim() === ''`.
- `document.mjs`
  - `validateText` strips a single leading `﻿`.
  - `countRecords` adds `flaky` and `register` lengths.

## Integration points

- **Entry points:** none new. `validate.mjs` (CLI), `validateDocument` and
  `validateText` (API) change behavior only.
- **Registrations required:** none. No new module, so no `entropy.entryPoints`
  change.
- **Documentation updates:** `docs/specs/canary-run-contract.md` (rules
  `real-dates` wording, `repo-relative`, `non-blank`, BOM),
  `docs/specs/canary-site-feed-contract.md` (`checked` formula, nested
  `repo-relative`), `docs/specs/canary-assessment-contract.md` (`non-blank`).
- **Architectural decisions:** none. D3 is recorded in this spec and the specs.
  It is not an ADR, because ADR 0035 already places rules the subset cannot
  express in the validator.
- **Knowledge impact:** none beyond the spec docs.

## Success criteria

1. When a timestamp names an impossible calendar date (`2026-02-30`,
   `2025-02-29`, `2026-04-31`) or clock (`T24:00:00`, `:60`, offset `+24:00`),
   the validator refuses it at that field's path. `2024-02-29` is accepted.
2. When a `file` escapes the repo root (`../x`, `a/../../x`, `..\\x`), is
   home-relative (`~/x`, `~`, `~bob/x`), or starts with `\`, the validator
   refuses it at that file's path, in a run and in a site feed's
   runs/flaky/register. `a/../b.spec.ts` and `..foo/x` are accepted.
3. When a required non-empty string is whitespace-only (`title: "  "`), the
   validator refuses it with `must not be blank`. A nullable field that is
   `null` is still accepted.
4. When the input starts with a UTF-8 BOM, `validateText` validates the document
   as if there were no BOM. The CLI does the same for a file and for stdin.
5. A site feed's `checked` equals `1 + runs + assessments + flaky + register`
   (the valid fixture: 6).
6. The schema files are byte-identical before and after.

## Implementation order

### Phase 1: Validator tightenings

<!-- complexity: low -->

One phase, five test-first tasks, each red then green: S8, S7, S2, S4, S3. Then
a spec-doc update task and the gates. Lowest risk goes first, so the riskiest
change (S3, which could refuse producer output) lands last against a green tree.
