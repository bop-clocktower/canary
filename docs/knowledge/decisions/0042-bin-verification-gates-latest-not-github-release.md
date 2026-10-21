---
number: 0042
title: Bin verification gates the latest advance, not the GitHub Release
date: 2026-10-21
status: accepted
tier: small
source: https://github.com/bop-clocktower/canary/issues/1392
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0042 — Bin verification gates the latest advance, not the GitHub Release

**Status:** accepted **Date:** 2026-10-21 **Deciders:** Bri Stevenski
(maintainer) **Related:**
[#1392](https://github.com/bop-clocktower/canary/issues/1392) (this decision);
[#1332](https://github.com/bop-clocktower/canary/issues/1332) (original
proposal); [#1331](https://github.com/bop-clocktower/canary/issues/1331) (poll
window widened to 20 x 30 s);
[#1252](https://github.com/bop-clocktower/canary/issues/1252) (why bin
verification exists);
[#1185](https://github.com/bop-clocktower/canary/issues/1185) (npm publishes
before the Release); ADR 0009 (exit 3 reserved for "abstained")

## Context

`.github/workflows/release.yml` runs on every `v*` tag push (`release.yml:3-6`).
It has two jobs, and today almost all the work sits in the first one.

- **`publish`** (`release.yml:17-131`) builds the TypeScript engine and the npm
  package, then runs three ordered steps:
  1. `Publish npm package` (`release.yml:55-79`). Stable tags publish under the
     npm `latest` dist-tag and pre-releases under `next`. A version already on
     the registry is skipped so a re-run does not fail on E403
     (`release.yml:72-77`).
  2. `Verify the published manifest ships every bin` (`release.yml:87-124`). It
     polls `npm view <name>@<version> version` up to 20 times, 30 s apart
     (`release.yml:96-103`). If the version never shows up it exits 3 and says
     the bins were not verified (`release.yml:104-107`). Otherwise it reads the
     published `bin` map and exits 1 if any bin declared in the local
     `npm/package.json` is missing (`release.yml:110-124`).
  3. `Create GitHub Release (changelog only)` (`release.yml:126-131`).
- **`advance-latest`** (`release.yml:133-157`) has `needs: publish` and runs for
  stable tags only (`release.yml:135-138`). It force-moves the git tag `latest`
  to the release commit (`release.yml:155-156`).

Bin verification exists because of #1252. A green publish step did not prove the
CLI shipped: npm printed `"bin[canary]" ... was invalid and removed` on every
release, so a release that really lost its bins looked like every other one
(`release.yml:81-86`).

Because the verify step sits inside `publish`, any non-zero exit from it skips
both later stages. The GitHub Release is not created and `advance-latest` never
starts. That holds even when the npm publish in step 1 succeeded and the version
is already installable.

That happened on v9.3.0. The old 6 x 10 s window abstained after a good publish,
because npm now warns that a new version "may take a few minutes to become
available" (`release.yml:92-95`). #1331 widened the window to 20 x 30 s, about
10 minutes, which makes an abstention much less likely but not impossible. #1332
first proposed moving the check into its own job, and #1392 carries that
decision forward. The human chose option (c) on 2026-10-21.

Two constraints frame the choice:

- **ADR 0009.** Exit 3 means "abstained", never "passed". An abstention at the
  end of the poll window must not be treated as a green check by anything
  downstream of it.
- **#1185.** npm publishes before the GitHub Release on purpose: npm is the
  distribution channel and the Release is the announcement
  (`release.yml:51-54`). Once the publish has happened, the Release records a
  fact, whatever a later check says.

## Decision

**Move bin verification into its own job. That job gates the `latest` advance
and does not gate the GitHub Release** (#1392 option (c), hybrid).

1. **A new job holds the check.** The
   `Verify the published manifest ships every bin` step (`release.yml:87-124`)
   moves out of `publish` into its own job, which has `needs: publish`. The
   step's logic does not change: the 20 x 30 s window, exit 3 on a version that
   never becomes visible, and exit 1 on a missing bin all stay as they are.
2. **The GitHub Release is not gated on it.**
   `Create GitHub Release (changelog only)` stays behind the npm publish and no
   longer waits on bin verification. The publish really happened, and the
   Release records that. A bin failure or abstention still turns the run red, in
   the verify job.
3. **`advance-latest` needs the verify job.** Its `needs:` gains the new job, so
   the git `latest` tag never moves on an unverified (exit 3) or failed (exit 1)
   check. GitHub Actions skips a job whose `needs:` did not succeed, so this
   costs no extra logic.
4. **Recovery is a re-run of the verify job.** If the check abstained because
   the registry was slow, re-running that job (and then the skipped
   `advance-latest`) finishes the release. Nothing has to be re-published, and
   the publish step's existing re-run guard (`release.yml:72-77`) keeps a full
   re-run safe as well.
5. **Exit 3 stays an abstention.** No change in this ADR may turn the end of the
   poll window into a pass, a warning, or a `continue-on-error` (ADR 0009).

This ADR records the decision only. The `release.yml` edit is separate build
work.

## Alternatives Considered

- **(a) Full split: neither the Release nor `latest` waits on bin
  verification.** The check runs in its own job and gates nothing. Rejected:
  `latest` could advance over a release whose published manifest is missing
  bins, which is the #1252 failure the check was added to catch.
- **(b) Keep as-is: the check gates both.** Strongest gate, no build work.
  Rejected: every abstention strands a good, already-installable release with no
  GitHub Release and no `latest` advance. v9.3.0 showed that this happens after
  a good publish, and the only fix today is re-running the whole `publish` job.

## Consequences

- **A slow registry no longer strands the announcement.** An abstention or a bin
  failure leaves the GitHub Release in place, because the publish it records
  really happened.
- **`latest` keeps the strongest gate.** The git `latest` tag only moves after
  the published manifest was read back and every declared bin was found. An
  abstention holds it back, as ADR 0009 requires.
- **Recovery gets smaller.** Re-running one short job replaces re-running the
  whole build-and-publish job.
- **A GitHub Release can now exist for a version whose bins are missing.** That
  is the cost of option (c). It is bounded: the run is red, `latest` has not
  moved, and the verify job's `::error::` names the missing bins. A human then
  decides whether to deprecate the npm version or edit the Release notes. This
  ADR does not automate that.
- **The npm `latest` dist-tag is outside this gate.** For stable tags,
  `npm publish --tag latest` (`release.yml:65-79`) moves npm's dist-tag during
  the publish step, before any verification. This ADR gates the git `latest` tag
  that `advance-latest` moves, not npm's dist-tag. Gating npm's dist-tag
  (publish under a staging tag, then `npm dist-tag add` after verification)
  would be a separate decision.
- **One more job in the release workflow.** The new job needs `actions/checkout`
  and `actions/setup-node` again, because it reads `npm/package.json` and runs
  `npm view`. It adds a runner start-up to every release, but the publish job
  loses up to 10 minutes of polling in exchange.

### Assumptions made

- The decision is recorded as the human chose it on 2026-10-21 (option (c)). The
  architecture advisor's discovery and choice gates were settled by that answer,
  so no new options were weighed.
- "`latest`" in #1392 means the git tag moved by `advance-latest`
  (`release.yml:133-157`), not npm's `latest` dist-tag. The dist-tag point is
  recorded above as a Consequence, not decided here.
- The new job runs for every `v*` tag, pre-releases included, as the step does
  today. Only `advance-latest` keeps its stable-only `if:`.
- The GitHub Release stays a step inside `publish` after the npm publish. Moving
  it into a job of its own is not required by this decision and is left to the
  build work.
- Tier is `small`: one workflow file, no runtime code, no change to the check's
  logic.
