# Plan: remove the retired "oracle" wording from ts/src comments (#965)

## Scope

- IN: comments in `ts/src` that say "the oracle" or "Python oracle", meaning the
  deleted Python engine.
- OUT: identifiers, runtime string literals, "Faithful TypeScript port" headers
  (#970), and tests under `ts/test` (count reported only).

## Measurement

- Before: `git grep -n -i oracle -- ts/src` returned 27 lines.
- After: 4 lines, all deliberately kept:
  - `core/company-knowledge.ts:872` is the runtime string
    `'Oracle: eyes on every test.'`. Changing it would change user-visible
    output, so it is left alone and reported as a follow-up.
  - `core/company-knowledge.ts:871` is the comment describing that string. It
    stays until the string is decided.
  - `core/permission-matrix.ts:21,79` use "existence oracle", a security term
    for a probe that shows whether a resource exists. That is not the retired
    brand name.

## Tasks

1. Rewrite each of the 23 brand-sense comments on the same line, so the line
   count stays the same. Where exact Python behaviour still applies, the comment
   now names "Python" or "the reference output" instead.
2. Run prettier on the changed files. Confirm the diff touches only comment
   lines.
3. Run the gates from `ts/`: build, typecheck, format:check, test.
4. Run `harness check-arch --json` and confirm there are no regressions.
5. Commit provenance, push, and open a PR with `Refs #965`, because the runtime
   string is left for a follow-up.
