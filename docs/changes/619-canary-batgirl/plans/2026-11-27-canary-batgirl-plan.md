# canary-batgirl plan (#619)

Spec: `docs/changes/619-canary-batgirl/proposal.md`. Every task is test-first:
write the failing test, watch it fail, implement, watch it pass, commit. One
commit per task. Gates for each task: the skills suite (`agents/skills`,
`npm test`), its typecheck and format check.

Constraints carried from the lane brief: `cli.mjs` at five imports or fewer;
functions under the perf limits (complexity 10, nesting 4, 50 lines); no change
to any baseline, allowance or limit, only the two `entryPoints` arrays.

## Tasks

1. **Escaping helper and bounded reads.** `scripts/text.mjs` (`plain`, `md`),
   `scripts/read.mjs` (`readText`, `readJson`, `listJson`, `LIMITS`). Tests:
   ANSI, control characters, line breaks, Markdown metacharacters, clamp;
   missing, oversized, unparseable and over-count inputs. Spec SC 6, 7.
2. **Dimension model and evidence dimensions.** `scripts/dimension.mjs`,
   `scripts/evidence.mjs` (escaped-defects, coverage-verified-share,
   closure-exercise). Tests per rule in the spec, including the duplicate
   closure report. Spec SC 2, 4.
3. **Suite and mainline dimensions.** `scripts/suite.mjs`
   (unexplained-switch-offs, vacuous-tests), `scripts/mainline.mjs`
   (red-mainline-commits). Tests per rule, dilution cases. Spec SC 2, 4.
4. **Scorecard, rendering and CLI.** `scripts/scorecard.mjs`,
   `scripts/render.mjs`, `scripts/output.mjs`, `scripts/inputs.mjs`,
   `scripts/cli.mjs`, `SKILL.md`. Tests: abstention exit 3, named-missing exit
   1, `--out` success and failure, JSON shape, Markdown sweep line and gap
   ledger. Spec SC 1, 8, 10.
5. **Goodhart invariant and abuse tests.** The planted assertion-free and
   vacuous change, author absence, hostile text end to end, no `RegExp` built
   from input. Spec SC 3, 5, 6, 9.
6. **Registrations and docs.** plugin.json, harness.config.json entry points,
   skills package format glob, vitest coverage include, naming registry, roadmap
   row, skills README, CHANGELOG.
7. **Verification and provenance.** ts gates (build, typecheck, format check,
   test), skills suite, blackhawk and savant strict runs, perf, arch and entropy
   measured against the merge base, self-review of the full diff,
   `provenance.json`.
