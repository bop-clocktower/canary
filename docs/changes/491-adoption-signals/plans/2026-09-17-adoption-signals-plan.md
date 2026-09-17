# Plan: adoption signals report (#491)

Spec: `docs/changes/491-adoption-signals/proposal.md`. Rigor: fast (single
phase, 5 tasks). Integration tier: small (one CLI subcommand, one guide).

## Task 1: pure signal computation (TDD)

- Files: `ts/src/adoption/signals.ts`, `ts/test/adoption-signals.test.ts`
- Test first: synthetic, de-identified records; each of signals 2-6 measured
  with a denominator; empty record set yields `abstained` for every
  record-derived signal; a record with total 0 counts toward the distribution.

## Task 2: record loading + workflow presence (TDD)

- Files: `ts/src/adoption/load.ts`, same test file
- Test first: non-JSON and foreign-source files land in `skipped` with a reason;
  missing dir yields zero records (not a throw); a workflow file naming
  `guardian pr-check` is `present`; none is `present: false`; the disabled state
  is never reported.

## Task 3: local git merge-state resolver (TDD)

- Files: `ts/src/adoption/merge-state.ts`, same test file
- Test first: squash subject `(#12)` and `Merge pull request #12` resolve
  merged; `(#123)` does not match `#12`; non-PR refs and a failed git call are
  `unresolved`. Runner injected; no network module imported by
  `ts/src/adoption/` (asserted by reading the sources).

## Task 4: CLI + renderer + registry (TDD)

- Files: `ts/src/adoption/adoption-cli.ts`, `ts/src/commands/readiness/cli.ts`,
  `ts/test/adoption-cli.test.ts`
- Test first: text output names every signal with its denominator or `abstained`
  / `not measured`; `--json` carries `egress: "none"` and no health aggregate;
  exit 0 on empty dir.

## Task 5: docs + gates

- `docs/guides/adoption-signals.md`, links from `docs/guides/pr-guardian.md` and
  `docs/guides/index.md`.
- Gates from `ts/`: build, typecheck, format:check, test. Check entropy /
  dead-export / perf / arch ratchets on push.
