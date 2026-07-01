# Runbook: Scrub Committer Email from Git History

> **HUMAN-EXECUTED ONLY — NOT run by autopilot/CI.**
> This runbook rewrites published git history and force-pushes. It is
> irreversible and must be performed deliberately by a human maintainer.
> No automation, agent, or CI job should execute these steps.

## Purpose

Remove the employer committer email from the canonical
`bop-clocktower/canary` history and replace it with the maintainer's
canonical personal address, so the public repo does not expose an
employer identifier in commit metadata.

This is **best-effort**: once history is rewritten and published, the
canonical repo is clean, but forks, clones, and third-party caches
(including GitHub's own cached views and any mirror) may retain the old
email. Removal is only guaranteed on the canonical repo, and the
rewrite is **irreversible** — every commit hash after the rewrite point
changes.

## Why no committed `.mailmap`

A `.mailmap` file maps an old identity to a new one, which means it must
**contain the old (employer) email in plaintext** to do its job. Committing
such a file would re-publish the very value we are trying to remove — it
would live in the tree of the rewritten repo forever.

Therefore the mapping file is created **locally and left uncommitted**
(e.g. under `/tmp`), used only as an input to `git filter-repo`, and
**deleted immediately after** the rewrite. Nothing containing the old
email is ever committed.

## Pre-flight checklist

- [ ] Merge or close **all** open pull requests. A rewrite invalidates
      every open PR's commit range.
- [ ] Notify all fork owners and collaborators that history will change
      and they must re-clone (not pull) afterward.
- [ ] Snapshot current tags for comparison:
      `git tag > /tmp/tags-before.txt`
- [ ] Ensure you have a **full, non-shallow clone** of the canonical repo
      (`git clone` fresh, or `git fetch --unshallow`), since `filter-repo`
      requires complete history.
- [ ] Install `git filter-repo` (`pip install git-filter-repo` or via your
      package manager). `git filter-branch` is deprecated — do not use it.

## Set the going-forward identity

Configure the address all **future** commits should use. Fill in the real
canonical address at runtime — do not hardcode it anywhere committed:

```bash
git config user.email "<CANONICAL_EMAIL>"
git config user.name  "<CANONICAL_NAME>"
```

## Rewrite step

Create a **local, uncommitted** mailmap file that maps the old employer
email to the canonical one. The format below uses placeholder tokens
only — substitute the real addresses at runtime in your local `/tmp`
copy (never commit this file):

```text
# /tmp/local.mailmap  (LOCAL ONLY — do NOT commit; delete after use)
<CANONICAL_NAME> <CANONICAL_EMAIL> <PLACEHOLDER_OLD_NAME> <PLACEHOLDER_OLD_EMAIL>
```

Run the rewrite against the full clone:

```bash
git filter-repo --mailmap /tmp/local.mailmap
```

Alternatively, avoid a file entirely with an inline callback (still using
placeholder tokens — substitute at runtime):

```bash
git filter-repo --email-callback '
  return email if email != b"<PLACEHOLDER_OLD_EMAIL>" else b"<CANONICAL_EMAIL>"
'
```

Verify the old address is gone before publishing:

```bash
git log --all --format='%ae%n%ce' | sort -u
```

The output must contain only the canonical address (and any other
legitimate contributor addresses) — not the placeholder old value.

## Publish

```bash
git push --force-with-lease origin main
git push --force --tags
```

Then request a **GitHub-support cache purge** so cached commit views of
the old email are dropped. Compare `git tag` against
`/tmp/tags-before.txt` to confirm no tag was lost.

## Cleanup

```bash
rm -f /tmp/local.mailmap
```

Delete any other local scratch file that contained the old address.

## Caveat box

> Forks, existing clones, and third-party/CDN caches retain the old
> email. This procedure removes it from the **canonical repo only**, on a
> best-effort basis. It is irreversible — all rewritten commit hashes
> change, so coordinate the rewrite window with every collaborator.
