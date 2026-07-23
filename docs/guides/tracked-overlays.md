---
project: canary
created: 2026-07-16
---

# Tracked Overlays Guide

An **overlay** is a git repository of Canary skills (and, later, other project
assets) that a downstream team maintains and publishes for its users. Instead of
hand-copying skill directories into `~/.canary/skills/`, you add the overlay
once and Canary tracks it as a git clone you can update and inspect.

> **npm install required.** The `overlay` command group ships in the npm package
> (`npm install -g canary-test-cli`). A pipx/Python install prints a pointer to
> the npm install instead — see [CLI Deprecation](../specs/cli-deprecation.md).

---

## Quick start

```bash
# Add an overlay (clones it into ~/.canary/overlays/)
canary overlay add github:example-org/example-overlay

# See what you have and whether it is current
canary overlay list

# Its skills now appear in every session
canary skills list
```

No API key is needed — all LLM work runs through your agent session.

---

## Commands

| Command                                     | What it does                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canary overlay add <source> [--ref <tag>]` | Clone `<source>` into `~/.canary/overlays/<owner>-<repo>/` and register it. `--ref` pins a tag or branch. Idempotent — re-adding is a no-op with a hint to `update`.  |
| `canary overlay list`                       | Name, source, ref, freshness (`up to date` / `N commits behind`), and skill count for each overlay. Does **not** hit the network — freshness reflects the last fetch. |
| `canary overlay lint <name\|path> [--json]` | Validate an overlay against the authoring contract (frontmatter floor, `deploy_to` targets, `cli:` paths, `doctor.json`). Exits non-zero on any error. See below.     |
| `canary overlay update [name]`              | Fast-forward the clone (`git pull --ff-only`, or fetch + checkout when pinned). No name updates all. Refuses on local modifications or a non-fast-forward.            |
| `canary overlay remove <name>`              | Deregister the overlay and delete its clone.                                                                                                                          |

### Source grammar

`add` accepts the same source forms used elsewhere in the ecosystem:

- `github:owner/repo` — shorthand for `https://github.com/owner/repo.git`
- a full git URL — `https://…/owner/repo.git`, `git@host:owner/repo.git`,
  `ssh://…`
- a local filesystem path — useful for testing an overlay before publishing

The overlay **name** (registry key and clone directory) is `<owner>-<repo>`, or
the path basename for a local source.

### Authentication

`overlay add` clones with your existing git credentials (SSH keys or a
credential helper). There is no Canary-managed auth. A private overlay that your
credentials cannot reach fails at clone time with a message distinguishing a
network problem from an access-denied one; nothing is registered on failure.

---

## How overlays are discovered

Overlay skills are one tier in Canary's skill precedence chain:

```text
bundled  <  overlay  <  global (~/.canary/skills/)  <  local (.canary/skills/)
```

A skill defined in your project (`local`) always wins; an overlay skill
overrides a bundled one of the same name. See
[Skill Discovery](../specs/skill-discovery.md) for the full rules.

`canary skills list` shows overlay skills under an `Overlay skills (<name>)`
group, one per overlay.

---

## Arbitration: when two overlays ship the same skill name

With more than one overlay registered, two overlays can ship a skill of the
**same name**. Which definition wins is decided by a declared **`precedence`**:

- Each overlay entry in `overlays.json` may carry a numeric `precedence`.
  **Higher wins.** An absent or `null` precedence counts as **0**.
- A collision is **resolved** only when exactly one contending overlay holds the
  highest precedence. If two overlays tie (e.g. both undeclared, both 0), the
  winner is **accidental** (falls back to directory-name order) — that is the
  case you want to eliminate.

Diagnostics:

```bash
canary overlay list --conflicts   # list every skill-name collision + both sources
canary doctor                     # fails on any UNRESOLVED collision, with a remedy
```

`overlay list --conflicts` prints each colliding skill, every overlay that ships
it (with its effective precedence), and whether it is resolved; it exits
non-zero when any collision is unresolved, so it doubles as a CI gate.
`canary doctor` surfaces the same as a failing `engine:overlay-conflicts` check.

**To resolve a collision**, set a higher `precedence` on the overlay you want to
win in `~/.canary/overlays.json`:

```jsonc
{
  "schemaVersion": 1,
  "overlays": [
    { "name": "org-primary-overlay", "precedence": 10 /* … */ },
    { "name": "org-legacy-overlay", "precedence": 1 /* … */ },
  ],
}
```

Both runtimes honor this identically: the TS diagnostics above and the Python
skill loader compute the **same** winner, so `doctor` never reports a winner the
loader disagrees with.

---

## Linting an overlay

`canary overlay lint <name|path>` validates an overlay clone against the
authoring contract, so frontmatter chaos, dead `cli:` paths, and invalid doctor
manifests are caught mechanically instead of at a consumer's first run. It
checks, per skill under `<overlay>/.canary/skills/<name>/SKILL.md`:

1. **Frontmatter floor** — `name` and a non-empty `description` are present.
2. **`deploy_to` targets** — every value is a known migration target (`api`,
   `e2e_ui`, `frontend_unit`, `load`, `performance`, or the `all` sentinel).
3. **`cli:` paths** — the script exists and resolves _inside_ the skill
   directory (a path that escapes is rejected).

Plus one overlay-level check: **`.canary/doctor.json`** (if present) must pass
manifest validation — the same `loadManifest` `canary doctor` uses, so the lint
and doctor never disagree.

Errors exit non-zero; warnings (e.g. a directory with no `SKILL.md`) are
advisory and don't fail. `--json` emits `{ overlay, skillsChecked, findings }`
for tooling. The target is a tracked overlay **name** or a filesystem **path**
(same name-vs-path rule as `--from`).

**Wire it into CI** — an unenforced lint is shelf-ware. In the overlay repo:

```yaml
# .github/workflows/overlay-lint.yml
name: Overlay Lint
on: [push, pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npx --yes canary-test-cli overlay lint . # the repo root IS the overlay
```

---

## On-disk layout

```text
~/.canary/
  overlays/
    example-org-example-overlay/   # full git clone
  overlays.json                    # registry: name, source, ref, path, addedDate, precedence
  skills/                          # legacy hand-installed global skills — still work
```

`overlays.json` is managed by the `overlay` commands. You normally do not edit
it by hand — the exception is `precedence` (see
[Arbitration](#arbitration-when-two-overlays-ship-the-same-skill-name)), which
you may set to declare a collision winner. The skill loader scans the clone
directories directly for skills and reads `overlays.json` **read-only**, solely
for that precedence ordering.

---

## Updating and freshness

`overlay list` reports freshness against your clone's last-known state of the
remote — it does not fetch. Run `overlay update` to fetch and fast-forward. If
you have edited files inside a clone, `update` refuses and prints the clone path
so nothing is silently discarded; commit or stash your changes, or remove and
re-add the overlay.

---

## Deploying overlay skills with `canary migrate`

`canary migrate` converts a harness-scaffolded project to Canary's layout. Pass
`--from` to also deploy an overlay's skills (those whose `deploy_to` frontmatter
matches the detected project shape) into the target's `.canary/skills/`:

```bash
# Deploy from a tracked overlay by name
canary migrate --from example-org-example-overlay

# With exactly one overlay tracked, --from defaults to it
canary migrate

# A value with a path separator is used as a path, not a name
canary migrate --from ../example-overlay
```

Resolution:

| `--from` value                               | Resolved as                                   |
| -------------------------------------------- | --------------------------------------------- |
| a bare name (`example-org-example-overlay`)  | a tracked overlay under `~/.canary/overlays/` |
| a value with a `/` (`../x`, `/abs/x`, `./x`) | that filesystem path directly                 |

- **Default:** with no `--from` and exactly one tracked overlay, `migrate` uses
  it and says so. With none tracked, no overlay skills are deployed. With more
  than one, `migrate` asks you to pick one with `--from <name>`.
- **A bare name is never a path** — a same-named directory in your working
  directory cannot shadow a tracked overlay, and a mistyped name fails with the
  list of tracked overlays rather than silently resolving to a stray path.

> **`--overlay <path>` is deprecated.** The old `--overlay <path>` option (point
> `migrate` at an overlay checked out as a filesystem sibling) still works but
> prints a deprecation notice — use `--from` instead. If both are given,
> `--from` wins.

---

## Freshness gate & drift (`migrate --check`)

Deployed overlay skills go stale silently: a consuming repo only refreshes them
when someone remembers to re-run `migrate`.
`canary migrate --from <overlay> --check` is the gate that makes drift loud. It
reports (without writing) how the target's deployed skills compare to the
overlay that owns them and exits with a drift-aware code:

| Exit | Meaning                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------ |
| `0`  | In sync — every deployed overlay skill is current.                                               |
| `1`  | **Drift** — the overlay carries newer deployable skills (`stale`) or ones the target is missing. |
| `2`  | **Local edits** — a deployed skill was hand-modified; one-way ownership refuses to overwrite it. |

```bash
canary migrate --from example-org-example-overlay --check          # human-readable
canary migrate --from example-org-example-overlay --check --json   # machine-readable
```

`--json` emits a machine-readable summary, where each skill's `status` is
`current` \| `stale` \| `missing` \| `local_edit`:

```text
{ shape, overlay_path, in_sync, has_drift, has_local_edits, exit_code,
  skills: [{ skill_name, dir_name, status, detail }] }
```

### One-way ownership (the safety guarantee)

Deployment is **strictly one-way**: the overlay owns every file it deploys.
`migrate --apply` refreshes a skill only when the deployed copy still matches
what was last deployed (tracked in `.canary/skills/.deploy-manifest.json`) and
the overlay has moved on. If the deployed copy has **local edits** — it differs
from both the overlay and the recorded deployment, or was hand-placed with no
provenance — `--apply` skips it and `--check` reports it as `local_edit` (exit
`2`). An automated update PR can therefore never clobber hand modifications:
reconcile them first (revert, or upstream the change into the overlay).

### Scheduled auto-update recipe

Wire the gate into a cron workflow in the **consuming** repo so drift opens a PR
instead of rotting. On drift (exit `1`) it applies the refresh and opens a PR; a
local-edit stop (exit `2`) fails the run for a human instead of forcing an
overwrite.

```yaml
# .github/workflows/overlay-freshness.yml
name: Overlay Freshness
on:
  schedule:
    - cron: '0 6 * * 1' # Mondays 06:00 UTC
  workflow_dispatch:
jobs:
  freshness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      # PyPI (`canary-test-ai`) is not published yet — install from git.
      - run: pipx install git+https://github.com/bop-clocktower/canary@latest
      - name: Check overlay freshness
        id: check
        run: |
          set +e
          canary migrate --from example-org-example-overlay --check --json > freshness.json
          echo "code=$?" >> "$GITHUB_OUTPUT"
      - name: Fail on local edits (needs a human)
        if: steps.check.outputs.code == '2'
        run: |
          echo "::error::A deployed overlay skill has local edits — reconcile before auto-update." 
          cat freshness.json
          exit 1
      - name: Apply refresh and open PR
        if: steps.check.outputs.code == '1'
        run: canary migrate --from example-org-example-overlay --apply
      - name: Open PR
        if: steps.check.outputs.code == '1'
        uses: peter-evans/create-pull-request@v6
        with:
          branch: chore/overlay-freshness
          title:
            'chore: refresh overlay skills from example-org-example-overlay'
          commit-message:
            'chore: refresh overlay skills (canary migrate --apply)'
          body: |
            Automated overlay freshness update. The tracked overlay carries newer
            deployable skills than this repo carried; `canary migrate --apply`
            refreshed them. Deployment is one-way — skills with local edits were
            left untouched.
```

> Replace `example-org-example-overlay` with your tracked overlay name (or a
> path). `create-pull-request` is a third-party action; swap in your team's PR
> tooling if you prefer. `ACME`-style placeholder names are fine in your own
> copy — the gate cares only about the overlay reference you pass to `--from`.
