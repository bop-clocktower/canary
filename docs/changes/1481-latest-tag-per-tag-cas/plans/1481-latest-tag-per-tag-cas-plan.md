# Plan: per-tag `latest-tag` group and a compare-and-swap push (#1481)

Refs #1481. Follow-up to #1427 / PR #1450. Fork F3 was answered `a`: key the
group per tag, and make the floating-tag push a compare-and-swap.

## Workflow audit (harness-workflow-audit, scoped to `release.yml`)

- Triggers: `push` of `v*` tags only. No `paths:` filters, so M1 has nothing to
  resolve.
- Permissions: top-level `contents: read`. `advance-latest` grants
  `contents: write`, and it does push. M2 is clean.
- Injection (J1): `github.ref_name` reaches the step only through `env:`. In the
  new `concurrency.group` expression it is not shell, so J1 is clean.
- **M4.5 (the #1481 finding), warning, `release.yml` advance-latest
  `concurrency`.** One shared `latest-tag` group plus GitHub's
  one-pending-run-per-group rule let a third close release cancel the second's
  pending advance. Keying the group per tag fixes that, but it drops the
  serialisation of the force push, so two runs could both pass the guard. Patch:
  below.
- Info, out of scope: `softprops/action-gh-release@v3` is a third-party action
  on a mutable tag (M3). This is not touched here. It is flagged for whoever
  owns action pinning.

## Root cause

The highest-stable-tag guard (#1427) is a check-then-act on remote state.
`latest` is only safe if nothing moves it between the check and the push. A
shared concurrency group gave that property, but it cost cancelled pending runs.
Per tag, nothing gives it, and an unconditional `git push --force` is
last-writer-wins:

```text
run A (v1.0.0)                      run B (v1.1.0)
fetch tags (no v1.1.0), guard ok
                                    tag v1.1.0, guard ok, push latest=v1.1.0
push --force latest=v1.0.0  <-- latest moves backwards
```

## Fix

`release.yml` `advance-latest`:

1. `concurrency.group: latest-tag-${{ github.ref_name }}`, still
   `cancel-in-progress: false`.
2. The step reads `LEASE` with `git ls-remote origin refs/tags/latest`
   (exact-matched on the ref name with `awk`) **before** `git fetch --tags` and
   the guard. Empty means the tag does not exist yet, so the lease means "must
   not exist". The read has to come first. If the fetch ran first, a newer
   release could be tagged and move `latest` between the fetch and the read. The
   lease would then match the new value and approve a guard that ran on stale
   tags.
3. Push with
   `git push --force-with-lease="refs/tags/latest:${LEASE}" origin refs/tags/latest`.
   This uses the full ref, so the name cannot resolve to a branch.
4. On rejection: retry the whole read, rank, push sequence **once**. In the race
   above, run A's push is rejected. Its retry sees v1.1.0 and stands down with
   the usual `::notice::`. If run B is the one rejected, its retry still ranks
   it highest, and it pushes over run A. A second rejection prints `::error::`,
   adds a step-summary line, and exits 1. It never passes silently.

Why retry once rather than fail on the first rejection: both are correct, but
fail-first can leave the _newer_ release red, with `latest` on the older one,
until a human re-runs it. One retry heals the common two-run race. More than one
retry would only matter if three runs raced within seconds, and that case fails
loudly instead. This is a compare-and-swap loop on remote state, not a timing
workaround: every attempt re-reads and re-validates.

## Tests added (TDD: 6 red before the fix, all green after)

`ts/test/release-advance-latest.test.ts`:

- Static: the group equals `latest-tag-${{ github.ref_name }}` with
  `cancel-in-progress: false`. The push uses
  `--force-with-lease=refs/tags/latest:$VAR` against `origin refs/tags/latest`.
  `VAR` is assigned from `git ls-remote origin refs/tags/latest` before the tag
  fetch, the guard and the push. No push line has a bare `--force`, `-f`,
  `+refspec` or an unvalued `--force-with-lease`.
- Git-level rehearsal against a temp bare repo: an empty lease creates the tag
  and is rejected once the tag exists, a stale SHA lease is rejected and leaves
  `latest` unchanged, and the correct lease succeeds.
- Step rehearsal with a racing second run (a `git` shim on PATH moves origin's
  `latest` just before the step pushes):
  - A newer release moves `latest` mid-step. Its advance wins, and the older
    run's retry logs the notice. Before the fix, `latest` went back to v1.0.0.
    This was the red failure.
  - `latest` keeps moving. The step exits non-zero with `::error::`, and
    `latest` is not overwritten.

The existing #1427 tests (ordering, older-release no-op, newer tag after
checkout) still pass unchanged, apart from the push-step locator.

## Docs

- `AGENTS.md`'s force-push paragraph now describes the per-tag group and the
  compare-and-swap.
- `CHANGELOG.md` gets a new Unreleased/Fixed entry. The #1427 entry no longer
  says the shared group "stays".
- ADR 0042/0044 cite stale `release.yml` line numbers but make no claim about
  the group, so they are left as records.

## Remediation actions / assumptions made

- **The first live exercise is a real release.** CI can only lint the workflow
  (actionlint 1.7.12, the version CI pins) and run the step script against local
  bare remotes. Nobody pushes or moves a real `latest` or `v*` tag to test this.
  Watch the next stable release's `advance-latest` log for `Moved latest →`.
- Assumed the `actions/checkout` persisted credentials let `git ls-remote` read
  origin. They already let `git fetch` and `git push` do so in the same step.
- Assumed GitHub runs the step with `bash -eo pipefail`, its default. A failed
  `git ls-remote` then fails the step instead of producing an empty "must not
  exist" lease. Even an empty lease would fail safe: the push is rejected once
  the tag exists.
- Retry count fixed at 1 (two attempts), as explained under Fix.
- The `workflow-hygiene` force-push invariant still counts
  `release.yml job advance-latest`, because `--force-with-lease` matches the
  detector. The job is still under a non-cancelling group.
