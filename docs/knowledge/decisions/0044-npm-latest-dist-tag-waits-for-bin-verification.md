---
number: 0044
title: The npm latest dist-tag waits for bin verification
date: 2026-10-23
status: accepted
tier: small
source: https://github.com/bop-clocktower/canary/issues/1440
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0044 — The npm `latest` dist-tag waits for bin verification

**Status:** accepted **Date:** 2026-10-23 **Deciders:** Bri Stevenski
(maintainer) **Related:**
[#1440](https://github.com/bop-clocktower/canary/issues/1440) (this decision);
ADR 0042 (bin verification gates the git `latest` tag, and defers this
question); [#1252](https://github.com/bop-clocktower/canary/issues/1252) (why
bin verification exists);
[#1185](https://github.com/bop-clocktower/canary/issues/1185) (trusted
publishing, npm before the Release); ADR 0009 (exit 3 reserved for "abstained")

## Context

canary has two things called `latest`, and only one of them is gated.

- **The git tag `latest`.** ADR 0042 decided that it moves only after bin
  verification passes. `advance-latest` (`release.yml:133-157`) force-moves it.
- **The npm dist-tag `latest`.** It is what `npm i canary-test-cli` installs.
  For stable `vX.Y.Z` tags, `Publish npm package` sets `DIST_TAG=latest`
  (`release.yml:65-69`) and runs
  `npm publish --access public --provenance --tag "$DIST_TAG"`
  (`release.yml:79`). The dist-tag moves during that step, before
  `Verify the published manifest ships every bin` (`release.yml:87-124`) runs.

So a stable release whose published manifest lost its bins (the #1252 failure)
still becomes what every new install gets. ADR 0042 noticed this and left it for
a separate decision (ADR 0042, Consequences, "The npm `latest` dist-tag is
outside this gate").

npm authenticates through OIDC trusted publishing, with no stored token
(`release.yml:43-47`). The fleet first assumed that OIDC could only run
`npm publish`, which would have meant a long-lived npm token for any later
`npm dist-tag add`. **npm's docs say otherwise** (verified 2026-10-23,
<https://docs.npmjs.com/trusted-publishers>, "Managing dist-tags with trusted
publishing"):

- OIDC "supports `npm publish`, `npm stage publish`, and the dist-tag
  operations". The page's examples are `npm dist-tag ls`, `add`, and `rm`.
- This is opt-in for each trusted-publisher configuration. The setting is
  **"Allow npm dist-tag"**, which "is disabled by default". "Permission to
  publish or stage a package does not grant this access automatically."
- It "requires npm CLI version 11.21.0 (or later) and 12.2.0 (or later)".
  `release.yml:49` installs `npm@^11.5.1`, which resolves to 11.21.1 today
  (`npm view npm@11 version`). The CI npm is new enough, but only because the
  range floats.
- "Other npm commands such as `install`, `view`, or `access` still require
  traditional authentication methods." `npm deprecate` is not listed.

Registry state on 2026-10-23 (`npm view canary-test-cli dist-tags`):
`latest: 9.5.0`, `next: 6.0.0-rc.1`.

## Decision

**Publish stable versions under the `next` dist-tag. Move npm `latest` with
`npm dist-tag add` only after bin verification passes, from a job that
authenticates through OIDC trusted publishing.** This is #1440 option (a). It
needs no long-lived npm token.

1. **Publish to staging.** `Publish npm package` uses `--tag next` for every
   `v*` tag, stable or pre-release. The dist-tag choice at `release.yml:65-69`
   goes away.
2. **A promotion job moves `latest`.** A new job runs for stable tags only (the
   same `!contains(github.ref_name, '-')` condition as `release.yml:138`). Its
   `needs:` includes the bin verification job from ADR 0042, and it runs
   `npm dist-tag add <name>@<version> latest`. GitHub Actions skips a job whose
   `needs:` failed, so exit 1 and exit 3 both leave `latest` where it was.
3. **The job declares its own OIDC permission.** Job-level `permissions:`
   replace the workflow-level block (`release.yml:8-10`), as `advance-latest`
   shows (`release.yml:140-141`). The promotion job therefore lists
   `id-token: write` itself. It also needs `setup-node` with the registry URL
   and npm ≥ 11.21.0.
4. **Prerequisite: "Allow npm dist-tag" is on.** A maintainer enables it on the
   npmjs.com trusted-publisher configuration for `canary-test-cli`
   (bop-clocktower/canary + `release.yml`). **Nobody has checked whether it is
   on today.** A maintainer must confirm it before the workflow change merges.
   Without it the promotion job fails and `latest` never moves.
5. **Pin the npm floor.** The follow-up changes `release.yml:49` to
   `npm@^11.21.0`, so OIDC dist-tag support is required by the range rather than
   supplied by whatever the range floats to.
6. **Exit 3 stays an abstention** (ADR 0009). Nothing in this change turns an
   unverified version into a promoted one.

**Implementation: follow-up issue to be filed.** This ADR records the decision
only. The `release.yml` edit (items 1-3 and 5) and the npmjs.com setting
(item 4) are separate build work, done after this ADR is accepted.

## Alternatives Considered

- **(b) Manual promotion.** Stable versions publish under `next`, and a
  maintainer runs `npm dist-tag add … latest` by hand after checking the run.
  Rejected: the gate is no stronger than (a), because a human reads the same
  verify result, and every release waits on a person being available. It also
  needs a maintainer's own login on every release, while (a) needs one only for
  rare recovery.
- **(c) Accept it ungated.** Keep `npm publish --tag latest`, record the gap,
  and rely on `npm dist-tag add <pkg>@<prev> latest` plus `npm deprecate` for
  recovery. Rejected: the bad version is what everyone installs until a human
  notices, which is the #1252 failure that bin verification exists to catch. The
  main argument for (c) was that gating needed a long-lived token, and npm's
  docs show it does not.

## Consequences

- **The two `latest`s agree.** Both the git tag and the npm dist-tag move only
  after the published manifest is read back with every declared bin present.
- **`latest` lags each stable release.** Between the publish and a passing
  verification, `npm i canary-test-cli` still installs the previous version. The
  lag is at most the poll window, 20 × 30 s, about 10 minutes
  (`release.yml:96-103`), plus a job start.
- **A failed or abstained check leaves the new version under `next`.** `latest`
  stays on the previous good version. If the check abstained only because the
  registry was slow, re-running the verify job and then the promotion job
  finishes the release, with no re-publish. The publish re-run guard
  (`release.yml:72-77`) keeps a full re-run safe too.
- **Stable versions overwrite `next`.** Today `next` points at `6.0.0-rc.1` and
  only pre-releases move it. After this change, every stable release repoints
  `next` to itself. Anyone who installs `canary-test-cli@next` to get
  pre-releases will get the newest stable version whenever it is newer than the
  last pre-release. The `next` name still means "at least as new as `latest`".
- **Recovering a bad version still needs a person.** `latest` is protected
  automatically, but a version that failed verification stays published under
  `next`. Marking it deprecated means `npm deprecate <pkg>@<bad> "<reason>"`.
  The trusted-publishers page does not list `npm deprecate` as OIDC-capable, so
  it most likely needs a maintainer's own login.
- **One more job and one more npmjs.com setting.** The release workflow gains a
  short job, and a trusted-publisher setting becomes part of release
  correctness. If someone later turns that setting off, promotion breaks loudly
  with a red job, not silently.

### Assumptions made

- The decision is recorded as the human chose it on 2026-10-23 (option (a)),
  after the fleet found that the token argument behind the first pick (c) was
  wrong. The architecture advisor's discovery and choice gates were settled by
  that answer.
- "Allow npm dist-tag" is **not known** to be on for `canary-test-cli`. Item 4
  is a prerequisite, not a recorded fact.
- `npm dist-tag add` works under OIDC because npm's docs say so. canary has not
  run it in CI yet. The first release after the follow-up is the real test.
- The promotion job depends on the separate verify job that ADR 0042 decides on.
  That split is not in `release.yml` yet; today the check is still a step inside
  `publish` (`release.yml:87-124`). If the follow-up lands before ADR 0042's
  build work, the promotion job uses `needs: publish`, which gives the same gate
  because the check is inside that job.
- Overwriting `next` with stable versions is acceptable. The only pre-release on
  `next` today is `6.0.0-rc.1`, three majors behind `latest`.
- Tier is `small`: one workflow file and one registry setting. No runtime code
  changes.
