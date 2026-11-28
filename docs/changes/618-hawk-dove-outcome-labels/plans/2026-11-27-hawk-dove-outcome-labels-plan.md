# Plan: canary-hawk-dove outcome labels (slice of #618)

**Spec:** [proposal.md](../proposal.md) **Date:** 2026-11-27 **Route:** feature

Every task is test-first: write the failing test in
`agents/skills/test/canary-hawk-dove-*.test.ts`, watch it fail, implement, watch
it pass, run `prettier --write` on the touched files, then commit. One commit
per task. Module fan-out stays at four imports or fewer.

## Module map

```text
cli.mjs ── write.mjs ── ledger.mjs ── files.mjs
   │          ├──────── ingest.mjs ── lib/scan-baseline.mjs
   │          ├──────── derive.mjs ── git.mjs
   │          └──────── escape.mjs
   └────── read.mjs ─── report.mjs ── escape.mjs
```

## Tasks

1. **escape.mjs.** `clean` (ANSI, controls, U+2028/9, code-point clamp), `md`
   (metacharacters plus GFM autolink neutralisation). Tests: each control class,
   clamp without splitting a surrogate pair, `https://`, `www.`, `a@b.c`.
2. **files.mjs.** `readInside(root, rel, {ext, maxBytes})` returning `{text}` or
   `{notRead: reason}`: realpath containment, per-segment `lstat` (symlink
   reported as `not read: symlink`), regular-file check, extension gate, size
   cap. `writeOut(path, text)` returns `null` or a `cannot write` message.
   Tests: outside root, symlinked file, symlinked parent, directory, FIFO-free
   non-regular (directory), wrong extension, oversized, write failure.
3. **ingest.mjs.** `parseRun(text, {gate, name})` for the guardian
   `pr-check --json` shape and the scan-baseline shape. Bounded parse errors
   (name plus position, never the parser message). `findingId`. Finding cap with
   a "not read" count. Tests: id stable across a line move and re-indent,
   distinct for distinct gates, guardian suppression fields kept, vouching
   computed, malformed JSON message has no file bytes.
4. **ledger.mjs.** `loadLedger` (malformed lines counted as not read, size cap)
   and `appendRecords` (append only). Tests: existing bytes preserved byte for
   byte across appends; malformed line skipped and counted; symlinked ledger
   refused.
5. **git.mjs + derive.mjs.** `changedFiles(repo, base, head)` via argv with
   revision validation, `--`, timeout and a path cap.
   `deriveLabels(state, run, changed)` for the three ADR 0025 rules, once per
   (finding, rule). Tests: `fp:` -> noise, other reason -> intentional,
   covered-later -> real, and each ambiguous case unlabelled (not vouching, file
   left the diff, git unavailable, still present, not coverage-verified); a
   revision starting with `-` is rejected.
6. **report.mjs.** `tally` (latest label wins), `renderMarkdown`, `renderJson`,
   `PRECISION_FLOOR = 30` with a parity test against
   `ts/src/guardian/adjudication.ts`. Tests: below floor abstains with "needs N
   more", above floor prints counts and the caveat, no threshold wording at any
   count, a hostile gate value is escaped.
7. **write.mjs, read.mjs, cli.mjs.** Subcommands `record`, `label`, `escape`,
   `report`; `--out`; exit codes 0/1/2/3. CLI tests run the real `main`, plus a
   gate-conformance row with `advisoryCode: 3`.
8. **Wiring and docs.** `SKILL.md`, naming registry (`shipped` with the slice
   note), `.claude-plugin/plugin.json`, `agents/skills/README.md`, the
   `format:check` glob, the vitest coverage include, both `entryPoints` arrays
   in `harness.config.json`, the roadmap row's Spec line and a `CHANGELOG.md`
   entry.

## Verification

From `ts/`: build, typecheck, format:check, test. From `agents/skills/`: test,
typecheck, format:check. Then canary-blackhawk and canary-savant `--strict` over
the test trees, and perf, arch, entropy and docs ratchets measured in clean
detached worktrees of the base and the head.
