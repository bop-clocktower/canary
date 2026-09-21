# Plan — canary-misfit (#592)

Spec: `docs/changes/592-canary-misfit/proposal.md`. One PR. TDD: every task
writes its tests before its implementation.

| #   | Task                                                                                                                               | Verifies            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| T0  | Spike: seeded PRNG determinism in dependency-free node; confirm Playwright is absent from the toolchain (fixture ships unexecuted) | Risk 1, D5          |
| T1  | `scripts/profiles.mjs` — profile schema validation, named network envelopes, `decide()` seeded injection decision                  | Criteria 1, 2       |
| T2  | `scripts/verdict.mjs` — flow classification from a results file + an injection ledger; `unexercised` excluded from the denominator | Criteria 4, 5       |
| T3  | `scripts/report.mjs` — markdown + JSON report, seed and reproduce command on every report                                          | Criterion 3         |
| T4  | `scripts/cli.mjs` — shared `createParser` spec, advisory exit 0, `--strict` 1/3 contract, abstention line                          | Criteria 5, 6, 7    |
| T5  | `scripts/route_fixture/playwright-fixture.mjs` — `page.route` injector wiring + ledger writer (shipped, not executed here)         | Goal 1, D2          |
| T6  | `SKILL.md` — frontmatter (`cli:`, `requires:`), precondition note, invocation, composition-with-instrument as optional             | Precondition, D1/D2 |
| T7  | Suite `agents/skills/test/canary-misfit.test.ts` + a row in `test/gate-conformance.test.ts`                                        | Criterion 7         |
| T8  | Ratchet/config wiring: both `harness.config.json` `entryPoints` arrays, `agents/skills/package.json` format glob, vitest coverage  | CI ratchets         |
| T9  | Docs: `agents/skills/README.md`, root `README.md` skill table, `docs/naming-registry.md` reserved -> shipped, `docs/roadmap.md`    | Doc drift (rule 8)  |
| T10 | Gates from `agents/skills` (test/typecheck/format:check) and from `ts/` (build/typecheck/format:check/test), provenance, PR        | Done                |
