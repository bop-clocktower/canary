# Plan: type-label backfill (#880)

Spec: `docs/changes/880-type-label-backfill/proposal.md`

1. RED: write `ts/test/backfill-type-labels.test.ts`, a subprocess contract test
   against fixture JSON with a stubbed `gh`. Run it and confirm it fails because
   the script is missing.
2. GREEN: write `scripts/lib/type-label-infer.mjs`, which holds the inference
   and plan logic.
3. GREEN: write `scripts/backfill-type-labels.mjs`, which handles flags, the
   `gh` read and write, output and exit codes.
4. Ratchets: add both files to both `entropy.entryPoints` arrays in
   `harness.config.json`. Probe the entropy, perf and arch ratchets locally.
5. Gates from `ts/`: build, typecheck, format:check and test.
6. Dry run against the live repo (read-only) and paste the output into the PR
   body.
