# #1428: setup-node reads `.nvmrc` in every workflow

Stacked on #1427 (PR #1450, branch `fix/1427-ledger-concurrency`), because both
changes extend `ts/test/workflow-hygiene.test.ts`.

## Root cause

`harness:workflow-audit` inventory of `.github/workflows/*.yml` found 28
`actions/setup-node` steps. Seven of them, in five workflows, pass a literal
`node-version: '20'`:

| Workflow                   | Job(s)                                        |
| -------------------------- | --------------------------------------------- |
| `batwoman.yml`             | `audit`                                       |
| `docs-lint.yml`            | `markdownlint`, `fences`, `mermaid`           |
| `harness-architecture.yml` | `deps-and-validate`                           |
| `harness-quality.yml`      | `validate` (other jobs already used `.nvmrc`) |
| `leak-gate.yml`            | `removed-symbols`                             |

`.nvmrc` pins `22.23.2`. The harness CLI declares a Node engine above 20 and
warns `EBADENGINE` there; #1401 traced a required-check flake to
`harness validate` failing with no output on Node 20. A literal pin cannot
follow `.nvmrc`, so every bump re-opens the gap and nothing goes red.

## Fix

Each of the seven steps now reads `node-version-file: .nvmrc`, the pattern #1423
set for `harness-security.yml`. Every job checks out the repository before
`setup-node`, so `.nvmrc` is present (`leak-gate.yml` checks out the base ref,
which also carries `.nvmrc`).

## Tests added (TDD)

New `describe('#1428 setup-node takes its version from .nvmrc')` in
`ts/test/workflow-hygiene.test.ts`:

- an allow-list classifier table (`matrix.*` and `steps.<id>.outputs.*` allowed;
  `'20'`, `22.x`, `${{ '20' }}`, `${{ env.NODE }}` rejected);
- a denominator check (at least 20 setup-node steps found), so a parsing
  regression cannot pass vacuously;
- the invariant: every setup-node step uses `node-version-file: .nvmrc`, or an
  allowed expression.

Seen red first on exactly the seven steps above; green after the fix.

## Assumptions and defaults

- **Expression allow-list, not just `matrix.*`.** No workflow has a Node matrix
  today. `dogfood.yml:236` passes `${{ steps.floor.outputs.unsupported }}`: it
  deliberately installs a Node below the npm package's declared engine floor to
  prove the runtime guard fires. That is a justified non-`.nvmrc` runtime, so
  step outputs are allowed alongside `matrix.*`. Any other expression (e.g.
  `env.*`, a quoted literal) is rejected, because it would be a literal pin by
  another name.
- A step with no `node-version` must name `.nvmrc` exactly; a different
  `node-version-file` would be a second source of truth.
- `docs/plans/2026-07-22-ts-migration-pilot-analysis-plan.md` mentions
  "setup-node 20". It is a dated historical plan and is left as written.
