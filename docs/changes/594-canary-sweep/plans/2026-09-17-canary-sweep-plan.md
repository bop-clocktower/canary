# Plan: canary-sweep (#594)

Spec: [`../proposal.md`](../proposal.md). Route: feature. Single phase — one
self-contained skill, no engine surface.

## Shape

A new bundled executable skill, identical in layout to `canary-screech` /
`canary-strix`:

```text
agents/skills/claude-code/canary-sweep/
├── SKILL.md              # frontmatter declares cli: scripts/cli.mjs
└── scripts/
    ├── cli.mjs           # arg parsing (shared parser), IO, exit contract
    ├── ingest.mjs        # axe JSON -> normalised nodes + denominators
    ├── component.mjs     # D1/D2 attribution
    ├── wcag.mjs          # D3 tag mapping + D4 snippet table
    └── report.mjs        # Markdown + JSON rendering
```

Tests: `agents/skills/test/canary-sweep.test.ts` (vitest, from
`agents/skills/`). Coverage thresholds in `vitest.config.ts` are 90/90/85/90 on
included files, so every branch below needs a case.

## Tasks

| #   | Task                                                                                                       | Verified by                                            |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | Write the failing test file first: dedup, unattributed, abstention, clean-with-denominator, WCAG, routes   | `npm test` red, module absent                          |
| 2   | `ingest.mjs` — accept object / array / `{results}`; file or directory; count pages + rule evaluations      | ingest cases green                                     |
| 3   | `component.mjs` — attribute priority, `target`-path attribute selectors, unattributed                      | attribution cases green                                |
| 4   | `wcag.mjs` — `wcagNNN` → `N.N.N`, level from `wcag2a`/`wcag21aa`/…, no-tag label, snippet table + fallback | mapping cases green                                    |
| 5   | `report.mjs` — grouping by `component × rule`, occurrence and page counts, Markdown + JSON                 | report cases green                                     |
| 6   | `cli.mjs` — `CLI_SPEC` via shared parser, `--strict` exit contract, abstention line, `process.exitCode`    | `skill-cli-conformance.test.ts` (auto-discovers) green |
| 7   | Register the abstention row in `agents/skills/test/gate-conformance.test.ts`                               | gate-conformance green                                 |
| 8   | `SKILL.md` — frontmatter, invocation, output, honesty section                                              | conformance `cli:` discovery green                     |
| 9   | Repo registration (below)                                                                                  | gates + ratchets green                                 |

## Registration checklist (the parts local gates miss)

- `harness.config.json` — add
  `agents/skills/claude-code/canary-sweep/scripts/cli.mjs` to **both**
  `entryPoints` arrays (entropy ratchet). Never raise `maxFindings`.
- `agents/skills/package.json` — add the scripts glob to `format:check`.
- `agents/skills/vitest.config.ts` — add the scripts glob to coverage `include`.
- `agents/skills/README.md` — tree entry + description bullet + the "ships a
  Node entry" sentence.
- `docs/naming-registry.md` — flip `canary-sweep` from `reserved` to `shipped`.

## Test matrix

Fixtures are hand-authored, de-identified, generic (`SiteHeader`, `/pricing`).
No real axe output from any real site is copied in — the leak gate scans
fixtures too.

| Case                                       | Asserts                                            |
| ------------------------------------------ | -------------------------------------------------- |
| one component, one rule, 40 nodes, 2 pages | one finding, `occurrences: 40`, both pages listed  |
| two components, same rule                  | two findings, not merged                           |
| nodes with no marker                       | `unattributed_nodes` count; no invented component  |
| mixed marked + unmarked                    | both paths in one report                           |
| `--component-attr` override                | priority list respected                            |
| ancestor marker only in `target`           | D2 selector-path read                              |
| zero documents                             | ABSTAINED, exit 3 under `--strict`                 |
| documents with all four arrays empty       | ABSTAINED with denominator                         |
| clean scan with real `passes`              | clean line carries pages + rule evaluations        |
| rule with no WCAG tag                      | "no WCAG criterion" label                          |
| unknown rule id                            | axe `help`/`helpUrl` fallback, no invented snippet |
| `--routes` with a missing route            | unscanned route named and counted                  |
| malformed JSON                             | exit 1 with the file named                         |

## Gates

From `agents/skills/`: `npm run typecheck`, `npm run format:check`, `npm test`.
From `ts/`:
`npm run build && npm run typecheck && npm run format:check && npm test`
(unchanged by this work, run to prove it). Then the entropy ratchet, and
`canary-blackhawk`/`canary-savant` strict scans over `agents/skills/test`, which
CI runs on the new test file.

## Risks

- **Coverage floor.** New `.mjs` under the coverage `include` glob must clear
  90%. Mitigated by writing the test matrix before the modules.
- **Snippet table size.** Twenty entries of prose in `wcag.mjs` inflate the
  module; kept as a flat data object so complexity stays at 1.
