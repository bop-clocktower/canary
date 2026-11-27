# Plan: canary-dev-pipeline (#666)

**Spec:** [proposal](../proposal.md) · **Date:** 2026-11-27 · **Executor:** the
roadmap-fleet lane, inline (no sub-agents)

Each task is test-first: write the failing test, watch it fail, implement, watch
it pass, run `prettier --write` on the touched files, and commit once. Every
script file stays under 300 lines, and every function stays at complexity 10 or
less, 50 lines or less, and nesting 4 or less, so the perf ratchet does not
grow.

## Task 1 — escaping module

- Test: `agents/skills/test/canary-dev-pipeline.test.ts`, `escape` block.
  `clean` strips ANSI CSI and OSC sequences, C0/C1 control characters and
  newlines, and clamps to a maximum length with an ASCII ellipsis. `md` escapes
  Markdown metacharacters after cleaning. `cleanDeep` cleans every string in a
  JSON value. `escapeRegExp` escapes every regex metacharacter.
- Implement `scripts/escape.mjs`.
- Commit:
  `feat(dev-pipeline): shared escaping for every value the brief prints`.

## Task 2 — target resolution

- Tests (temp git repositories, `git` via argv):
  - With no arguments, the target is changed, staged, unstaged and untracked
    files against the merge base with `main`.
  - A clean branch gives an empty target.
  - Outside a repository, the target is empty with the reason "not a git
    repository".
  - Without a default branch, the target falls back to uncommitted changes, with
    a note.
  - Deleted files are counted and not listed.
  - Explicit paths override the diff: a file, a directory walk, a missing path,
    and a path outside the repository.
  - A newline in a file name stays one entry.
  - A repository path with shell metacharacters is used literally.
  - The 200-file clamp.
- Implement `scripts/target.mjs`.
- Commit: `feat(dev-pipeline): resolve the working diff or explicit paths`.

## Task 3 — members and the budget loop

- Tests:
  - risk: map absent gives `not-checked`; a malformed map gives `not-checked`; a
    present map gives changed rows sorted by risk.
  - ties: an imported source is tied, an orphan is a gap.
  - isolation and temporal: findings on changed tests, with paths relative to
    the repository.
  - The budget loop: an exhausted budget gives `budget` rows; a throwing member
    gives `error`.
- Implement `scripts/members.mjs`.
- Commit: `feat(dev-pipeline): compose risk, ties, savant and blackhawk`.

## Task 4 — render, CLI, SKILL.md

- Tests through `main`:
  - Zero arguments over a diff exits 0 and renders every section.
  - An empty diff exits 3, with the abstained line on stdout and stderr.
  - `--json` follows the spec shape.
  - `--out` writes the brief; an unwritable path exits 1 with
    `cannot write artifact`.
  - Findings never change the exit code.
  - Suggestions name edge cases for gaps and failure impact for risk 0.7 or
    above.
  - Escaping applies end to end.
  - The 200-file run finishes within the 5000 ms budget.
  - No `new RegExp(` appears outside `escape.mjs`.
- Implement `scripts/render.mjs` and `scripts/cli.mjs`, plus `SKILL.md`. The
  SKILL.md is what the conformance suite discovers.
- Commit: `feat(dev-pipeline): advisory brief CLI and skill`.

## Task 5 — registrations and docs

- Add the registrations: `.claude-plugin/plugin.json`,
  `docs/naming-registry.md`, `harness.config.json` (both `entryPoints` arrays,
  `scripts/cli.mjs` only), the `agents/skills/package.json` format glob, the
  `vitest.config.ts` coverage include, and a gate-conformance row (exit 3 by
  default).
- Update the docs: `agents/skills/README.md`, the boundary lines in
  `canary-test-pipeline` and `canary-pr-guardian`, and `CHANGELOG.md`.
- Commit: `feat(dev-pipeline): register the skill and document the boundary`.

## Task 6 — verify and provenance

- Run the gates from `ts/` (build, typecheck, format:check, test) and from
  `agents/skills/` (typecheck, format:check, test).
- Run the dogfood scans (blackhawk and savant `--strict`).
- Measure perf, arch and entropy against the base in clean worktrees.
- Self-review the full diff, then commit `provenance.json` and record it with
  harness waypoint.
