# canary critical-areas

Rank tracked source files by churn, importers and, when a report is present,
coverage, and write the map `canary-katana` alarms against. Katana records only
without this file, so a fresh worktree runs degraded until something writes it.

This is #1529 ([proposal](../changes/1529-critical-areas-cli/proposal.md)). It
is deterministic: no LLM, and no harness MCP server.

## What it does

```bash
canary critical-areas
canary critical-areas --root path/in/repo --out /tmp/areas.json
canary critical-areas --coverage reports/lcov.info
```

- `--root <dir>`: any directory in the repository, default the current one. It
  resolves to the repository top level, so paths in the file are repo-relative.
- `--out <path>`: output file, default `<repo top>/.canary/critical-areas.json`.
  Missing parent directories are created. A relative path resolves against the
  current directory.
- `--coverage <file>`: a coverage report, default the first conventional one
  found. A relative path resolves against the current directory.

Katana has no default path for this file, so pass it with `--critical-areas`.

## Score

```text
base  = 0.5 * churn / max churn  +  0.5 * importers / max importers
boost = 0.15 * (1 - coverage / 100), when coverage is known
score = min(1, base + boost), rounded to 2 places
```

- The maxima are the largest values among candidate files.
- The boost needs another signal. A file with a `base` of 0 scores 0, because
  being untested alone does not make a file critical.
- When churn is unknown (a shallow clone, or a failed `git log`), importers
  carry the whole weight: `base = importers / max importers`. At half weight the
  top score would be 0.65 and katana's critical threshold of 0.7 could not be
  reached.
- The file lists the 25 candidate files with the highest scores above 0, plus
  any path that already declares `symbols`, whatever its score. A declared path
  that is not a candidate is listed for its symbols and takes none of the 25.

## Signals

`null` means not measured, never 0. `signal_sources` records whether each signal
was measured, and why not.

**Churn** is commits per path in the 90 days ending at HEAD's commit time, not
the wall clock, so one commit gives one ranking on any day. A backdated commit
does not stop the count, and is itself filtered by its own date. A shallow clone
writes `churn_commits: null`, because every file there reads as one commit. So
does a `git log` that fails, including on a git too old for `--since-as-filter`.
`signal_sources.churn` records which.

`--root` decides the repository, even when a git hook has exported `GIT_DIR` and
its relatives.

**Coverage** is read from `--coverage`, else the first of:

1. `coverage/lcov.info`
2. `lcov.info`
3. `coverage/coverage.json`
4. `coverage.json`
5. `coverage.xml`

A report binds a file by exact repo-relative path, after anchoring its keys to
where the report sits (a `pkg/coverage/lcov.info` naming `src/a.ts` binds
`pkg/src/a.ts`). It never binds by suffix, and an absolute key outside the
repository is ignored.

A discovered report that cannot be parsed, or any report giving a percentage for
0 files, is recorded as absent with a reason. A stale file in `coverage/` should
not stop katana getting its map. `files_matched` counts only files with a
percentage. A file a usable report does not list is `coverage_pct: null`: the
report did not measure it, so it is not 0%. So is a file with no denominator,
such as a coverage-json entry with `covered_lines` and no `instrumented_lines`:
the lines it recorded are not the lines it could have measured.

**Importers** are read, not resolved. Only non-test source files count as
importers, because counting tests would rank well-tested files higher. A
declared path that is not a candidate can still be imported, and its count says
so.

| Language | Counted                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| JS/TS    | Relative `import`, `from`, `require` and `import()`, with `.js` mapped to `.ts`, and `index.*`; `@/`, `~/`, `#/` aliases by unique path suffix |
| Python   | `import a.b` and `from a.b import c` by unique path suffix; leading dots relative to the file                                                  |
| PHP      | `require` and `include` of a string path; `use A\B\C` by unique path suffix                                                                    |

**The count is approximate.** It can miss an import: an ambiguous suffix counts
nothing, tsconfig `paths` and bare packages are not resolved, and a Python
module named like the standard library (`import os` beside `py/os.py`) is read
as the standard library. It can also count a mention: whole-line comments are
skipped, but an import inside a string or a docstring still counts.

It reads the working tree, not blobs at HEAD: a clean checkout is the same
content, but a dirty tree can shift counts. A tracked file missing from the
working tree cannot be read, so its imports count nothing, while
`signal_sources.importers` still says `measured`. Two runs differ only in
`generated` for one commit and one tree.

## Exit codes

| Code | When                                                                                  |
| ---- | ------------------------------------------------------------------------------------- |
| 0    | The file was written                                                                  |
| 1    | The file could not be written; one line names the path and the errno code             |
| 2    | `--coverage` names a report that is missing or cannot be parsed                       |
| 3    | Abstained: git not found, no git repo, no commit, no source file, or every score is 0 |

On 1, 2 and 3 an existing file is left as it was: the write goes to a temporary
file beside the target and is renamed into place. The `--coverage` check runs
first, so a mistyped flag exits 2 even outside a repository.

## Overwriting

It overwrites an existing map, including one the `canary-critical-areas` skill
wrote, and the skill can regenerate its judgement. `symbols` a person declared
are kept for every path that is a tracked file in HEAD. Symbols for any other
path are dropped, and the command says which. A list katana's contract would
reject (empty, not strings, or holding a name under 3 letters or digits once
normalized) is dropped whole, and the command says which paths lost it, because
katana would refuse to assess that area. A malformed existing file is
overwritten.

## `rank_score` and `risk_score`

These are two names for one idea across consumers. `canary briefing` reads
`rank_score`; katana, `canary ci-ready` and the skill's schema use `risk_score`.
This command writes both, with the same value. Unifying them is a follow-up.

## Source

- [critical-areas-cli.ts](../../ts/src/critical-areas/critical-areas-cli.ts):
  the command, coverage read, atomic write and exit codes.
- [declared-symbols.ts](../../ts/src/critical-areas/declared-symbols.ts): the
  symbols kept through a rewrite, and the rule mirrored from katana's contract.
- [git-signals.ts](../../ts/src/critical-areas/git-signals.ts): top level, HEAD,
  candidate files, churn and the shallow check.
- [importers.ts](../../ts/src/critical-areas/importers.ts): unique importers.
- [scoring.ts](../../ts/src/critical-areas/scoring.ts): the pure score and
  document.
