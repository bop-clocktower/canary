# Plan: canary-manhunter release quality dossier (#611)

**Spec:** [proposal](../proposal.md) · **Phases:** 1 (single phase, medium
complexity) · **Integration tier:** medium (new CLI surface + new skill)

TDD applies to every task: write the test, run it and watch it fail for the
right reason, implement, then plant a positive (mutate the implementation) to
prove the key assertion can fail.

## Tasks

### Task 1: Types, source reader, canonical JSON and digest

- **Files:** `ts/src/analysis/manhunter/types.ts`,
  `ts/src/analysis/manhunter/sources.ts`,
  `ts/src/analysis/manhunter/assemble.ts` (digest half),
  `ts/test/manhunter-digest.test.ts`
- **Tests first:** reading a missing file gives `missing`, an unreadable one
  (directory) gives `unreadable`, a present file gives bytes + sha256. The
  canonical JSON is independent of key order. The digest is stable across
  `generatedAt`, changes when a nested field changes, and `verifyDossier`
  returns `match` / `mismatch` / `malformed`.

### Task 2: Section builders (one per source)

- **Files:** `history.ts`, `guardian.ts`, `readiness.ts`, `ledger.ts`,
  `sweep.ts`, `escapes.ts` under `ts/src/analysis/manhunter/`;
  `ts/test/manhunter-sections.test.ts`
- **Tests first, per section:** fed on a synthetic source with a non-zero
  denominator; DARK with a reason on missing, malformed, self-abstained, and
  zero-denominator input; eyes items present for the anomalies the spec table
  lists; eyes capped at 10 with an "and N more" line.

### Task 3: Assembly and render

- **Files:** `assemble.ts`, `render.ts`; `ts/test/manhunter-assemble.test.ts`
- **Tests first:** verdict complete / incomplete / abstained (excluded-only
  counts as abstained); `--exclude` turns a section into EXCLUDED with its
  reason; dark sections head Worth your eyes; the markdown shows the verdict,
  the fed/dark/excluded counts, the digest, and every dark reason.

### Task 4: CLI

- **Files:** `ts/src/manhunter/manhunter-cli.ts`,
  `ts/src/commands/readiness/cli.ts`; `ts/test/manhunter-cli.test.ts`
- **Tests first:** exit 0 / 1 / 3 matching the verdict; `--out` and
  `--json-out` write files and print nothing else to stdout; an empty
  `--exclude` reason or an unknown section id exits 2; `verify` exits 0 / 1 / 2;
  the default input paths resolve under `--root`; `canary --help` lists
  `manhunter`.

### Task 5: Skill, docs, registrations, ratchets

- **Files:** `agents/skills/claude-code/canary-manhunter/{SKILL.md,skill.yaml}`,
  `docs/guides/release-dossier.md`, guides index, `agents/skills/README.md`,
  `docs/naming-registry.md`, `docs/roadmap.md`, `CHANGELOG.md`, and
  `harness.config.json` entry points only if entropy requires them.
- **Checks:** every roster/catalog test passes; each ratchet (entropy, perf
  delta, check-arch, check-docs) is measured against a detached merge-base
  worktree.

## Checkpoints

- After Task 3: the four gates are green from `ts/`.
- After Task 5: ratchets equal to or better than the merge base, then review.
