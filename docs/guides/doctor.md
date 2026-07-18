---
project: canary
created: 2026-07-17
---

# `canary doctor`

`canary doctor` answers one question: **is my Canary setup working, and if not,
what exactly do I fix?** It prints each check as pass/fail with a one-line
remedy under every failure, and exits non-zero when anything fails — so it drops
cleanly into a setup script or CI gate.

> **npm install required.** `doctor` ships in the npm package
> (`npm install -g canary-test-cli`). A pipx/Python install prints a pointer to
> the npm install instead — see [CLI Deprecation](../specs/cli-deprecation.md).

---

## Quick start

```bash
canary doctor                 # run every check
canary doctor --persona alpha # run only the checks tagged for a persona
```

Exit code is **0 when every check passed** (skipped and informational lines do
not count as failures) and **non-zero when at least one check failed**.

Output adopts the `harness doctor` shape — one symbol per line, remedy indented
under a failure:

```text
canary doctor

Engine
  ✓ CLI 5.9.0 (latest)
  ✓ git present (git version 2.44.0)
  ✓ overlay "example-org-example-overlay": up to date
  ✓ overlay "example-org-example-overlay": no local changes
  ✓ project .canary/ config parses (1 file(s))
  ✓ MCP config resolves

Overlay: example-org-example-overlay
  ✓ skills-present: .canary/skills exists
  ✗ api-reachable: https://api.example.com unreachable
      → Check your network / VPN, or set the API base URL in .canary/company.json
  - smoke-test: skipped (command checks need consent — re-run 'canary overlay add')

1 check(s) failed.
```

| Symbol | Meaning                                                   |
| ------ | --------------------------------------------------------- |
| `✓`    | pass                                                      |
| `✗`    | fail (a remedy line follows)                              |
| `-`    | skipped (e.g. a `command-succeeds` check without consent) |
| `ℹ`    | informational (e.g. latest-version lookup was offline)    |

---

## The two tiers

### Tier 1 — engine checks (built in)

These run with no overlay present and need no configuration:

| Check                    | Passes when                                                               | On failure                                                                   |
| ------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `engine:version`         | Installed CLI matches the latest published version                        | Points at `npm install -g …@latest`. Offline → an `ℹ` line, never a failure. |
| `engine:git`             | `git` is on `PATH`                                                        | Install git — `overlay add`/`update` need it.                                |
| `overlay:<name>:present` | The registered clone still exists on disk                                 | Re-add the overlay.                                                          |
| `overlay:<name>:fresh`   | The clone is up to date with its last-known remote state                  | Run `canary overlay update <name>`. Does **not** hit the network.            |
| `overlay:<name>:clean`   | The clone has no local modifications                                      | Commit/stash, or remove and re-add.                                          |
| `engine:project-config`  | `.canary/company.json` (and any `company.<env>.json`) parse as JSON       | Skipped when there is no project `.canary/`.                                 |
| `engine:mcp`             | Project and home `.mcp.json` parse and their `mcpServers` entries resolve | Skipped when no `.mcp.json` exists.                                          |

### Tier 2 — overlay checks (data-driven)

Each tracked overlay may ship a `.canary/doctor.json` manifest describing extra
checks the engine runs on its behalf — `file-exists`, `url-reachable`, and
`command-succeeds`. See the [doctor.json schema reference](doctor-manifest.md)
for the manifest format.

A malformed or unreadable manifest degrades to a **single** failing check naming
the parse error and the manifest path. It never blocks the engine checks or any
other overlay's checks, and never crashes `doctor`.

---

## `--persona <tag>`

`--persona <tag>` (or `--persona=<tag>`) runs only the overlay checks whose
`persona` list contains `<tag>` (case-insensitive), **plus** every check that
has no `persona` field. With no flag, all checks run.

The engine ships **no persona vocabulary** — tags are free-form strings the
overlay owns. An overlay might tag some checks `alpha` and others `beta`; what
those mean is documented by that overlay, not by Canary.

If you pass a `--persona` value that **no** installed overlay declares, `doctor`
prints a hint listing the persona tags it actually found (discovered from the
overlays' manifests) so you can pick a valid one — rather than silently running
only the untagged checks and leaving you to guess why your filter matched
nothing. When no overlay defines any personas at all, the hint says so and
tells you to drop the flag.

---

## Consent and `command-succeeds`

`command-succeeds` is the only check type that executes a command from a cloned
repository, so it runs **only with recorded consent**. When you
`canary overlay add` an overlay whose manifest contains `command-succeeds`
checks, `add` prints the command list and asks you to confirm; your decision is
stored in `overlays.json`.

- **Consent granted** → `doctor` runs those commands (in the clone directory,
  under a timeout, no shell).
- **Consent absent or declined** → each `command-succeeds` check is reported as
  **skipped** (`-`), not failed, and **all other check types still run**.
- **The command set later changes** (via `canary overlay update`) → consent is
  treated as _not granted_ until you re-confirm, so a changed command can never
  run under stale consent.

Every check runs under a bounded timeout; a `url-reachable` or
`command-succeeds` check that hangs fails its own line at the timeout without
delaying the rest.

---

## See also

- [Tracked Overlays Guide](tracked-overlays.md) — adding and updating overlays,
  and where consent is recorded.
- [doctor.json schema reference](doctor-manifest.md) — authoring an overlay's
  check manifest.
