# canary uninstall

**Status:** approved (decisions D1–D4 by the human during brainstorming; D5–D7
delegated with "go with recommendations") **Issue:** #523 (second half — the
docs half shipped in PR #665) **Keywords:** uninstall, lifecycle, plugin-cache,
overlays, dry-run, abstention, project-state

## Overview

`canary uninstall` enumerates every artifact a Canary install leaves behind,
removes the ones the CLI can safely remove, and prints exact instructions for
the ones it structurally cannot. It never claims to have finished a job it did
not finish.

The command exists because a full install scatters artifacts across at least
seven locations (#523), several of them non-obvious — `installed_plugins.json`
in particular is internal Claude Code state that no Canary doc mentioned before
PR #665. Removing the binary is the smallest part of the footprint.

### Goals

- One command that reports the complete footprint, per scope.
- Remove what is safely removable; abstain loudly on everything else.
- Never destroy work the user may still want.
- Never corrupt a working install.

### Non-goals

- Removing the CLI binary. The command is the running process, and removal is
  package-manager-specific. It reports the resolved install root and prints the
  matching removal command.
- Deregistering the Claude Code plugin. That is Claude Code's own state
  (`installed_plugins.json`), mutated by `/plugin uninstall`.
- A `doctor` info line for orphaned caches. Listed as optional in #523; cut
  under YAGNI and recorded below as a future consideration.

## Decisions made

**D1 — Bare `canary uninstall` has no default scope.** It enumerates both
scopes, removes nothing, and names the flag to pass. A user typing the command
inside a repo could plausibly mean "off my machine" or "out of this project",
and guessing wrong deletes the wrong things. Scope is selected with `--global`,
`--project`, or `--all`.

**D2 — Project scope separates machinery from content.** Always removable:
`.canary/` config, `test-results/reports/`, and the `canary-mcp` key in
`.mcp.json`. Reported but never removed without `--include-generated`:
`tests/generated/` (holds tests Canary generated that the user never promoted)
and `.canary/quarantine.json` (the canary-katana ledger recording _why_ tests
were deleted, which outlives Canary as history).

**D3 — `.mcp.json` is edited surgically, never deleted.** The file is shared:
this repo's own lists `canary-mcp`, `harness`, and `playwright`. Only the
`canary-mcp` key is removed. If that leaves `mcpServers` empty, the file is
still left in place — deciding a now-empty config should not exist is the user's
call, not ours.

**D4 — Global scope removes orphaned plugin caches only.** "Orphaned" means
every cached version directory except the one named by `installPath` in
`installed_plugins.json`. The registered cache and the marketplace clone are
reported with the `/plugin` commands that remove them.

> The current version MUST be read from `installed_plugins.json`'s `installPath`
> and never inferred by sorting version numbers. On the machine this spec was
> written against, six versions were cached (4.0.0, 6.3.0, 6.4.0, 6.5.0, 6.6.0,
> 6.7.1) and the registered one was **6.4.0** — not the newest. A
> highest-version heuristic would delete the live install and leave five
> orphans.

This also makes the full-uninstall path fall out of the constraint rather than
fighting it: after `/plugin uninstall`, the previously-registered cache
_becomes_ an orphan, and a re-run sweeps it through the same code path. No
special case, no flag.

**D5 — Overlays: skip dirty, remove clean, report what was skipped.** Reuses
`workingTreeStatus` (`npm/src/overlay-commands.ts:327`), already consumed by
`overlay update` and the doctor check. An overlay whose git status is `dirty` or
`unreadable` is kept and listed with its path.

> `overlay remove` itself does _not_ guard against local edits — it calls
> `fs.rmSync(..., { force: true })` unconditionally
> (`npm/src/overlay-commands.ts:665`). Removing one overlay by name is a
> deliberate act so that is defensible; a bulk sweep is not. The gap in
> `overlay remove` is filed separately rather than changed here.

**D6 — Dry-run by default; `--apply` executes.** Matches the established
destructive-operation shape (`ts/src/cli-commands.ts:559`,
`const dryRun = !opts.apply`) and #523's own framing ("the same
dry-run-then-apply shape `canary migrate` already uses"). _(Delegated.)_

**D7 — The CLI binary is reported, never touched.** The command resolves and
prints its own install root as a fact, then prints the removal command for each
install path, marking the one whose root matches. Self-removal from a running
process is unreliable and package-manager-specific. _(Delegated.)_

## Technical design

### File layout

| File                                        | Role                                                        |
| ------------------------------------------- | ----------------------------------------------------------- |
| `npm/src/uninstall.ts`                      | New. Pure enumeration + removal, fully dependency-injected. |
| `npm/src/router.ts`                         | Add `'uninstall'` to `TS_COMMANDS`; route to the handler.   |
| `npm/scripts/__tests__/uninstall-*.test.js` | New. `node --test`, run against `dist/`.                    |
| `README.md`                                 | Point the Uninstalling section at the command.              |

The command lives on the npm side, next to `overlay` and `doctor`, because it
needs the overlay registry (`npm/src/overlays-registry.ts`) and the plugin-dir
knowledge already in `npm/src/engine-checks.ts:205-235`. The pipx/Python entry
point does not carry these commands, matching `overlayStub`/`doctorStub`
(`ts/src/cli-commands.ts:944,951`).

### Core shape

Enumeration is separated from removal so the dry-run and apply paths share one
source of truth and cannot drift:

```ts
type Disposition = 'removable' | 'blocked' | 'manual';

interface Artifact {
  scope: 'global' | 'project';
  kind: string; // 'overlay' | 'plugin-cache' | 'project-config' | ...
  label: string;
  path: string | null; // null for instruction-only entries
  disposition: Disposition;
  reason?: string; // why blocked, or the command that does it
  sizeBytes?: number;
}

export function enumerate(opts, deps): Artifact[];
export function removeAll(artifacts, deps): RemovalOutcome;
```

`manual` entries (the CLI binary, plugin registration, marketplace clone) always
render as instructions and are never passed to `removeAll`. `blocked` entries
(dirty overlays, `tests/generated/` without `--include-generated`) render with
their reason. Only `removable` is acted on, and only under `--apply`.

### Dependency injection

Mirrors `CommandDeps` in `overlay-commands.ts`:
`{ homeDir, cwd, out, err, git }`. Every filesystem root is injected so tests
run against `mkdtempSync` fixtures with no network and no real `$HOME` access.

### Output contract

Grouped by scope, with a summary line that states the denominator explicitly. A
run that finds nothing says so rather than printing an empty success:

```text
canary uninstall --global (dry run)

  Removable (5)
    plugin cache  4.0.0   ~/.claude/plugins/cache/.../4.0.0    7.2M
    ...
  Skipped (1)
    overlay  acme-overlay   has local edits — commit or discard first
  You must do these yourself (2)
    Claude Code plugin   /plugin uninstall canary@bop-clocktower
    CLI binary           npm uninstall -g canary-test-cli   (detected: npm global)

  5 removable, 1 skipped, 2 manual. Nothing was removed — re-run with --apply.
```

### Exit codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | Ran successfully (dry-run, or apply that removed everything removable) |
| 1    | Usage error (no scope flag, unknown flag) or a removal failed          |
| 3    | Reserved for abstention, consistent with `EXIT_ABSTAINED`              |

## Integration points

**Entry Points** — New `canary uninstall` subcommand, routed through
`npm/bin/canary.js` → `npm/src/router.ts`.

**Registrations Required** — `TS_COMMANDS` in `npm/src/router.ts:19` gains
`'uninstall'`. No barrel export (the npm package exposes only `./reporter`).

**Documentation Updates** — `README.md`'s Uninstalling section (added in #665)
gains a pointer to the command as the assisted path, keeping the manual steps as
the fallback. `AGENTS.md` needs no change (no new subsystem).

**Architectural Decisions** — None rise to a standalone ADR. D3 and D4 are
implementation constraints rather than architecture, and D1/D2 are UX policy
scoped to one command.

**Knowledge Impact** — One concept worth recording: _the registered plugin
version is authoritative from `installPath`, not from version ordering_. It is
non-obvious, it is currently false on a real machine, and any future code
touching the plugin cache can repeat the mistake.

## Success criteria

1. `canary uninstall` with no scope flag removes nothing, exits 1, and names the
   available flags.
2. `canary uninstall --global` lists every cached plugin version except the one
   at `installed_plugins.json`'s `installPath`.
3. Given a cache set where the registered version is not the highest, the
   registered version is never listed as removable.
4. A dirty overlay is reported as skipped with its path and is still on disk
   after `--apply`.
5. A clean overlay is removed under `--apply`, and its registry entry is gone.
6. `--project` removes the `canary-mcp` key from `.mcp.json` while leaving every
   other server key byte-identical.
7. `--project` without `--include-generated` leaves `tests/generated/` and
   `quarantine.json` on disk and reports both with counts.
8. `--project --include-generated --apply` removes both.
9. Without `--apply`, no path is written or deleted in any scenario.
10. A scope with nothing to remove states that explicitly rather than printing
    an empty list.
11. The CLI binary and plugin registration always render as manual instructions,
    never as removable.

## Implementation order

1. **Enumeration, global scope** — plugin caches with orphan detection, overlays
   with dirty detection. Tests first.
2. **Enumeration, project scope** — `.canary/`, `test-results/reports/`,
   `.mcp.json` key, and the two content artifacts behind `--include-generated`.
3. **Removal** — `removeAll` over `removable` entries only, plus the surgical
   `.mcp.json` edit.
4. **Rendering + routing** — output contract, exit codes, `TS_COMMANDS`
   registration, flag parsing.
5. **Docs** — README pointer, CHANGELOG entry.

## Future considerations

- A `doctor` info line when orphaned caches are present (#523, listed optional).
  Cheap once `enumerate` exists — it is the same call.
- `overlay remove` gaining the dirty-tree guard that `overlay update` already
  has.
