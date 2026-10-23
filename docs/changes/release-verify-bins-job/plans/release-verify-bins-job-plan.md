# Release: bin verification as its own job (#1439, ADR 0042)

Pipeline: `harness:workflow-audit` (scoped to `.github/workflows/release.yml`),
then TDD.

## Workflow audit of release.yml (before the fix)

```text
WORKFLOW AUDIT: bop-clocktower/canary (release.yml only)
Workflows audited: 1   Findings: 1 error, 1 warning, 2 info
Gates that never fire: none (tag trigger, no paths: filters to resolve: 0 globs)
Documented-but-unwired gates: ADR 0042 job graph (decided, not implemented)
```

- [ERROR] gate-coupling `release.yml:87-131` / `:135`. The bin check was a step
  inside `publish`, ahead of "Create GitHub Release", so any exit 1 or exit 3
  skipped the Release. `advance-latest` had only `needs: publish`. Patch: the
  fix below.
- [WARNING] permissions-broad `release.yml:8-10`. `contents: write` and
  `id-token: write` sat at workflow level, so any new job would inherit both.
  Patch: workflow default `contents: read`; job-level grants.
- [INFO] pinning `release.yml:127`. `softprops/action-gh-release@v3` is a
  third-party action on a mutable tag. The repo convention is major tags for
  every action, so this matches convention. Not changed (out of scope).
- [INFO] concurrency. No `concurrency:` group. Two stable tags pushed close
  together could race on the force-pushed `latest` tag. Requires a human
  decision; not changed (out of scope).
- J1 injection: `github.ref_name` reaches `run:` only through `env:`. Clean.

## Root cause

ADR 0042 was accepted on 2026-10-21 as a decision only. `release.yml` still had
the check as a step in `publish`, so a slow registry (exit 3) or a missing bin
(exit 1) skipped the GitHub Release for a version that was already installable.

## Fix

- New `verify-bins` job, `needs: publish`, `permissions: contents: read`. The
  step logic is unchanged (20 x 30 s poll, exit 3 on not-visible, exit 1 on a
  missing bin). It now reads `NAME`/`VERSION` from `publish`'s job outputs (a
  new `pkg` step), and abstains with exit 3 if those are empty.
- Every outcome writes to `$GITHUB_STEP_SUMMARY`: "verified", "FAILED (exit 1)"
  with the missing bins, or "abstained (exit 3)" saying the bins were **NOT
  verified** and `latest` will not advance.
- The GitHub Release stays a step in `publish`, after the npm publish (ADR 0042
  assumption). It never depends on `verify-bins`.
- `advance-latest`: `needs: [publish, verify-bins]`. Its `if:` has no status
  function, so `success()` is implied and a failed/abstained check skips it.
- Permissions per job: workflow `contents: read`; `publish` keeps
  `contents: write` + `id-token: write` (trusted publishing unchanged);
  `verify-bins` `contents: read`; `advance-latest` `contents: write`.

## Tests added (`ts/test/release-workflow.test.ts`)

Written first; 15 failed against the old workflow, all 23 pass after.

- The bin check exists in exactly one job, `verify-bins`.
- `verify-bins` needs `publish`.
- The job holding the GitHub Release step does not (transitively) need
  `verify-bins`, and still follows the publish.
- `advance-latest` needs both; its `if:` carries no `always()`/`failure()`/
  `cancelled()`.
- No `continue-on-error` on `verify-bins` or its steps; no `exit 0` in the check
  script.
- `verify-bins` permissions are exactly `{contents: read}`; no workflow-level
  write or OIDC grant.
- `publish` exposes `name`/`version` outputs and the check reads them.
- Running the real step body against a fake `npm`: abstention writes "NOT
  verified" to the step summary; empty version abstains with exit 3 and no
  registry probe; a missing bin exits 1 and names it in the summary; a pass
  records "verified". The three #1331 poll-window tests still pass.

## Assumptions and defaults taken

- The Release stays inside `publish` rather than its own job. ADR 0042 lists
  this as its default, and moving it would change a step that cannot be
  exercised without cutting a tag. Splitting it out would let `publish` drop
  `contents: write`; noted as a follow-up option, not done.
- `verify-bins` runs for pre-release tags too (as the step did); only
  `advance-latest` keeps its stable-only `if:`.
- Verification is the needs-graph test, actionlint 1.7.12 (with shellcheck), and
  PR CI only. No tag was cut and the release workflow was not triggered, per the
  human's decision. The live job graph is therefore unexercised until the next
  `v*` tag.
