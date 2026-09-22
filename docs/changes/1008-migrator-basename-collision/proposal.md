# Workflow-template basename collisions fail loudly, keyed on the source path

Issue: #1008. Supersedes the parked half of PR #1000 (which merged the
reproduction and a basename-keyed `conflict` report).

## Overview

`HarnessMigrator.installWorkflows` names each installed workflow file
`basename(src)` (`ts/src/core/migrator.ts:1922`). Two declared templates that
share a basename therefore target one `.github/workflows/<name>.yml`.

PR #1000 landed a per-run `claimed` map keyed on the destination **basename**
(`ts/src/core/migrator.ts:1880`) that reports the second declaration as
`conflict`. Review raised two must-fix findings, both of which this change
resolves:

1. Keying on the basename alone means the **same** template listed under two
   shapes is falsely reported as a conflict. Identical sources are not a
   collision.
2. The remaining `--force` guidance is wrong for a filename collision —
   `--force` overwrites the first variant rather than resolving anything.

## Decisions made

Settled by the human at fleet CONFIRM; not re-derived here.

| Decision                                                                                                | Rationale                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Collision key is the resolved SOURCE PATH**, not the basename and not target+hash                     | The same template legitimately appears under two shape prefixes. Two _different_ sources landing on one filename is the only real ambiguity.                    |
| **Identical sources dedupe silently** — no result row, no warning                                       | It is a no-op, and a warning on a legal declaration is noise on every scheduled freshness check.                                                                |
| **Different sources sharing a basename FAIL the migration** with a usage error naming both source paths | There is no correct file to install. Any silent pick is a coin flip the consumer cannot see.                                                                    |
| **No renaming of installed files by shape, and no manifest `target:` key**                              | Installed filenames are a consumer-visible contract (a required-check context name references the workflow file). Renaming would break existing repos silently. |
| **The abort is a pre-pass**, before any file is written                                                 | Otherwise `--apply` leaves a partially installed `.github/workflows/`, and dry run and apply would still differ in their side effects.                          |
| **`--force` is no longer suggested for this case**                                                      | A collision is not an overwrite decision. `--force` would clobber the first variant.                                                                            |
| **A plain `Error`, not a new exported error class**                                                     | An export consumed only inside its own module trips the dead-export ratchet, and no caller needs to discriminate this from other migration aborts.              |

### Approaches considered

- **A — keep reporting `conflict`, but key on the source path.** Cheapest diff.
  Rejected: the human settled on failing loudly, and a `conflict` row still
  leaves `--apply` writing one arbitrary variant.
- **B — namespace the installed file by shape (`guardian-api.yml`).** Rejected:
  changes installed filenames for existing consumers.
- **C — pre-pass abort keyed on the source path (chosen).** Dry run and apply
  reach the identical verdict because neither gets past the pre-pass, and
  nothing is written on the way out.

## Technical design

`ts/src/core/migrator.ts`:

- A module-private helper resolves every declared template for the active shapes
  into a `basename -> resolved source path` map **before** the install loop
  runs. A second declaration of an already-claimed basename whose resolved
  source is byte-identical in path is skipped silently; a different source
  throws.
- The thrown message names `.github/workflows/<name>`, **both** source paths
  with their declaring skills, and the remedy ("rename one template"). It states
  explicitly that `--force` does not resolve a filename collision.
- The `claimed` map added by PR #1000 is removed from the install loop; the loop
  returns to its pre-#1000 shape, with the pre-pass now guaranteeing no two
  entries target one file.
- Entries that do not resolve (`invalid`) or are not shipped (`missing`) are
  skipped by the pre-pass and keep their existing per-entry result rows.

`checkFreshness` (`migrator.ts:2130`) calls `installWorkflows` in dry-run mode,
so a colliding overlay now aborts the freshness check too. That is the intended
"fail loudly" behavior: the overlay is malformed and no verdict about it would
be honest.

## Integration points

- **Entry points:** none new. `installWorkflows` keeps its signature; the
  `canary migrate` surface is unchanged.
- **Registrations required:** none. No new module, no new export, no new status,
  so no `entropy.entryPoints` declaration and no arch-allowance bump.
- **Documentation updates:** none — the collision case was never documented as
  supported behavior.
- **Architectural decisions:** none rises to an ADR (small change, one file).
- **Knowledge impact:** "a workflow template's installed filename is a
  consumer-visible contract" is the durable fact behind rejecting the rename
  option.

## Success criteria

1. Two **different** sources sharing a basename abort the migration with an
   error naming both source paths.
2. The **same** source declared under two shapes installs once, silently, with
   no `conflict` row and no warning.
3. Dry run and apply reach the same verdict in both cases.
4. Apply writes nothing when the migration aborts.
5. The abort message does not suggest `--force`.
6. #1000's `TestInstallWorkflowsBasenameCollision` is kept and extended.

## Implementation order

1. Extend `TestInstallWorkflowsBasenameCollision` with the four failing cases
   (tests first).
2. Add the pre-pass helper and remove the in-loop `claimed` map.
3. Four gates from `ts/`.
