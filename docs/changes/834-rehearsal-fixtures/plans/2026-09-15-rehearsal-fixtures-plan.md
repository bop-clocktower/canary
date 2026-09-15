# Plan: rehearsal fixtures (#834)

Spec: [../proposal.md](../proposal.md) · ADR 0018

## Tasks

1. **Fixtures.** Create `rehearsal/<id>/` for the seven targets, each with a
   `rehearsal.json` manifest (`id`, `target`, `plantedDefect`, `expect`).
   Synthetic names only (widgets, sprockets); nothing copied from a real diff.
   Verify each detector fires by hand before writing the gate.
2. **Test first.** `ts/test/rehearse.test.ts`: required-target list, one fixture
   per target, each offline probe fires, `tally` denominator and failure rules
   (silent, zero-examined, missing fixture, empty), probes that error do not
   count as firing, CLI abstention on an empty root, CI wiring. Run it and see
   it red (module missing).
3. **Implement.** `scripts/rehearse.mjs`: `REQUIRED_TARGETS`, `loadManifests`,
   `runProbe`, `tally`, CLI `--root`. Small functions per probe to stay under
   the perf complexity thresholds.
4. **Wire CI.** Blocking step in `harness-quality.yml` `skills-validate` after
   the engine build.
5. **Ratchet paydown (F7).** Append `scripts/rehearse.mjs` to both
   `entropy.entryPoints` and `performance.entryPoints` (same position, end of
   list). Keep fixture code as `*.test.mjs` so the existing excludes cover it (a
   repo-rooted `rehearsal/**` exclude is forbidden over tracked files). Never
   raise `maxFindings`/`maxViolations`.
6. **Hygiene.** `node scripts/check_removed_symbols.mjs` (file denylist plus
   authorship scan). Prettier on changed files.
7. **Gates** from `ts/`: build, typecheck, format:check, test.
8. **Ship.** Commit (Conventional Commits, no trailer), push, PR "Fixes #834",
   watch CI, address guardian comments. Do not merge.
