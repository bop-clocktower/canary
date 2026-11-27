# Plan: canary-ivy (#615)

**Spec:** [proposal.md](../proposal.md) **ADR:**
[0039](../../../knowledge/decisions/0039-canary-ivy-report-only.md) **Date:**
2026-11-27 **Route:** feature **Phases:** 1

Every task is test-first: write the failing test, run it red, implement, run it
green, run `prettier --write` on touched files, commit. Each new script stays
under the perf rules (function at most 50 lines, cyclomatic complexity at most
10, nesting at most 4, file at most 300 lines) and source stays ASCII.

## Tasks

| #   | Task                                                                                                                             | Files                                            | Tests (red first)                                                                                                           | Spec                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| T1  | Escaping helper `plain` / `md`                                                                                                   | `scripts/text.mjs`                               | ANSI, OSC, C0/C1, U+2028, bidi, newline stripping; Markdown escaping; code-point clamp; null/number input                   | D10                        |
| T2  | Test-file walk and setup-block extraction; identical-body grouping                                                               | `scripts/fixtures.mjs`                           | pytest fixture, `setUp`, `beforeEach`/`beforeAll`, PHP `setUp`; two-line floor; differing bodies; walk skips `node_modules` | D5, SC6                    |
| T3  | Coverage readers (neutral map, coverage.py contexts) and equal-set grouping with line ranges                                     | `scripts/coverage.mjs`                           | both formats agree; one-line difference not grouped; empty sets ignored; malformed file is an error                         | D2, D3, SC7                |
| T4  | History reader, per-test and per-file series, changepoint, where-time-went                                                       | `scripts/runtime.mjs`                            | step series grew_at; flat series absent; short series counted; timestamp order; malformed line error                        | D6, D7, SC8                |
| T5  | Report assembly and Markdown / JSON rendering, caps, caveat on every group, abstention line                                      | `scripts/report.mjs`                             | caveat per group; not-assessed rows printed; 50-entry cap; no p95/grade words                                               | D4, D9, D13, SC2, SC3, SC9 |
| T6  | CLI: `CLI_SPEC`, exit codes 0/1/2/3, `--out` with `cannot write artifact`, planted invariant + denylist scan, hostile-input test | `scripts/cli.mjs`, `test/canary-ivy-cli.test.ts` | SC1, SC4, SC5, SC10                                                                                                         | D8, D11, D12               |
| T7  | SKILL.md, plugin.json, entryPoints (both arrays), vitest include, format globs, README, naming registry, roadmap, CHANGELOG      | listed in spec Integration Points                | skills suite (skill-cli-conformance, plugin registration tests)                                                             | Integration Points         |

## Verification

From `ts/`: `npm run build`, `npm run typecheck`, `npm run format:check`,
`npm test`. From `agents/skills/`: `npm test`, `npm run typecheck`,
`npm run format:check`. From the repo root: blackhawk and savant `--strict` over
`ts/test agents/skills/test`, `node scripts/rehearse.mjs`, markdownlint on
touched Markdown. Ratchets measured against base `ea020e5e`:
`harness check-arch --json` (newViolations), `harness check-perf` with
`scripts/perf-ratchet.mjs`, `harness cleanup --findings-json` against
`.harness/entropy-baseline.json`, docs coverage via `scripts/docs-ratchet.mjs`.

## Review

Self-review of the full diff for correctness and security, inline (no
sub-agents): every input-derived string reaches output through `text.mjs`; no
deletion vocabulary in any message; exit codes match D8.
