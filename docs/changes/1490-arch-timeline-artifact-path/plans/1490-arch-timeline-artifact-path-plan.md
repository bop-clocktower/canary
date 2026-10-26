# #1490: arch-timeline artifact path

Pipeline: `harness:workflow-audit` (scoped to the upload/download artifact
pairing in `arch-snapshot.yml` and `harness-security.yml`), then `harness:tdd`.

## Audit finding

```text
[ERROR] artifact-path-pairing  .github/workflows/arch-snapshot.yml:93-98
  upload-artifact@v7 uploads the single path .harness/arch/timeline.json. The
  artifact is rooted at the least common ancestor, so the entry is
  `timeline.json`. The push job read "$SRC/.harness/arch/timeline.json",
  which never exists.
  Effect: the push job has failed on every run since #1461 (7eb89e27), so no
  architecture snapshot reaches chore/arch-timeline.
  Patch: read "$SRC/timeline.json" and copy it to .harness/arch/timeline.json.
  Keep the regular-file and symlink guard (applied).

[WARNING] artifact-path-pairing  .github/workflows/harness-security.yml:115-117
  The two uploaded paths share only the repo root as their common ancestor,
  so each keeps its repo path. The ledger job's restore loop depends on that.
  Removing either path changes the layout.
  Patch: pin the upload list and the restore pairing in a test (applied).
```

The other audit checks found nothing in either workflow:

- M1: neither workflow has a `paths:` filter.
- M2: both workflows declare `contents: read`. Write access is granted only to
  the job that pushes.
- M3: both use first-party actions only.
- M4: both have concurrency groups. Neither pushed branch triggers its own
  workflow.
- J1: the only interpolation is `runner.temp`.

## Root cause (confirmed)

`actions/upload-artifact` uses the least common ancestor of all uploaded paths
as the artifact root. For one file, that ancestor is the file's own directory.
Artifact 12659041789 from failing run 40340731570 was downloaded into an empty
scratch directory. `unzip -l` listed one entry: `timeline.json` (1604 bytes).
The restore step looked under the repo path, so its guard failed with
`artifact entry .harness/arch/timeline.json is missing or not a regular file`.

The existing behaviour test hid the bug. `ts/test/ledger-push-jobs.test.ts`
seeded the fake artifact at the repo-relative path (`join(src, p)`), which is
the same wrong layout the workflow assumed.

## Fix

- `arch-snapshot.yml`, step "Restore the captured timeline": read
  `$SRC/timeline.json` and copy it to `.harness/arch/timeline.json`. The `-f`
  and `! -L` guard and `cp --` stay exactly as strict as before.
- `harness-security.yml`: a comment only. No behaviour change. It records that
  the restore loop depends on the two-path common ancestor being the repo root.

## Tests (red, then green)

- `ts/test/workflow-hygiene.test.ts`, new `#1490` blocks:
  - `artifactLayout()` models the least-common-ancestor rule. Unit cases cover
    one path, two paths with the repo root as ancestor, two paths with a deeper
    ancestor, and a top-level file.
  - Per hand-off (`arch-snapshot.yml` / `arch-timeline`, `harness-security.yml`
    / `security-ledger`):
    - The upload list equals the pinned list.
    - The pinned entries equal `artifactLayout(upload)`.
    - The restore step's `SRC` equals the download `path`.
    - The real restore script runs under bash against the modeled layout and
      writes every destination.
  - Red: the arch case failed with the exact CI error. Green after the fix.
- `ts/test/ledger-push-jobs.test.ts`: each case gets an `entries` field, and the
  fake artifact is seeded at the real layout. The arch cases went red ("pushes
  the downloaded output", "pushes nothing when unchanged") before the fix and
  green after. The symlink and missing-entry cases now target the real entry, so
  they still prove the guard.

## Verification

- `npm run build`, `npm run typecheck`, `npm run format:check`, `npm test` from
  `ts/`.
- actionlint on both workflows.
- One `workflow_dispatch` of `arch-snapshot.yml` on the branch (F2a).
