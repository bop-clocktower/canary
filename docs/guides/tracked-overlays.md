---
project: canary
created: 2026-07-16
---

# Tracked Overlays Guide

An **overlay** is a git repository of Canary skills (and, later, other project
assets) that a downstream team maintains and publishes for its users. Instead
of hand-copying skill directories into `~/.canary/skills/`, you add the overlay
once and Canary tracks it as a git clone you can update and inspect.

> **npm install required.** The `overlay` command group ships in the npm
> package (`npm install -g canary-test-cli`). A pipx/Python install prints a
> pointer to the npm install instead — see
> [CLI Deprecation](../specs/cli-deprecation.md).

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

| Command | What it does |
| --- | --- |
| `canary overlay add <source> [--ref <tag>]` | Clone `<source>` into `~/.canary/overlays/<owner>-<repo>/` and register it. `--ref` pins a tag or branch. Idempotent — re-adding is a no-op with a hint to `update`. |
| `canary overlay list` | Name, source, ref, freshness (`up to date` / `N commits behind`), and skill count for each overlay. Does **not** hit the network — freshness reflects the last fetch. |
| `canary overlay update [name]` | Fast-forward the clone (`git pull --ff-only`, or fetch + checkout when pinned). No name updates all. Refuses on local modifications or a non-fast-forward. |
| `canary overlay remove <name>` | Deregister the overlay and delete its clone. |

### Source grammar

`add` accepts the same source forms used elsewhere in the ecosystem:

- `github:owner/repo` — shorthand for `https://github.com/owner/repo.git`
- a full git URL — `https://…/owner/repo.git`, `git@host:owner/repo.git`,
  `ssh://…`
- a local filesystem path — useful for testing an overlay before publishing

The overlay **name** (registry key and clone directory) is `<owner>-<repo>`,
or the path basename for a local source.

### Authentication

`overlay add` clones with your existing git credentials (SSH keys or a
credential helper). There is no Canary-managed auth. A private overlay that
your credentials cannot reach fails at clone time with a message distinguishing
a network problem from an access-denied one; nothing is registered on failure.

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

## On-disk layout

```text
~/.canary/
  overlays/
    example-org-example-overlay/   # full git clone
  overlays.json                    # registry: name, source, ref, path, addedDate
  skills/                          # legacy hand-installed global skills — still work
```

`overlays.json` is managed entirely by the `overlay` commands — you do not edit
it by hand, and the skill loader never reads it (it scans the clone directories
directly).

---

## Updating and freshness

`overlay list` reports freshness against your clone's last-known state of the
remote — it does not fetch. Run `overlay update` to fetch and fast-forward.
If you have edited files inside a clone, `update` refuses and prints the clone
path so nothing is silently discarded; commit or stash your changes, or remove
and re-add the overlay.
