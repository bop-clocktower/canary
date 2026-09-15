# Plan: retire the Python-port framing (Issue #926, narrowed)

**Scope (settled by the human after PR #962's first attempt was rejected):**
only the sites Issue #926 enumerates. No behavior change.

## Tasks

1. **Doc framing in the 11 listed `ts/src` files.** Remove "faithful port of
   `agent/...`", "matching Python ...", and "Python original" claims. Where the
   behavior still matters, state it as TypeScript behavior.
   - `ts/src/analysis/cli.ts`, `ts/src/core/skill-registry.ts`,
     `ts/src/core/test-files.ts`, `ts/src/core/workflow-discovery.ts`,
     `ts/src/guardian/diff-coverage/formats/cobertura.ts`,
     `ts/src/guardian/diff-coverage/formats/coverage-json-lint.ts`,
     `ts/src/guardian/diff-extractor.ts`, `ts/src/guardian/pr-comment.ts`,
     `ts/src/mcp-server.ts`, `ts/src/ui/banner.ts`,
     `ts/src/util/ensure-ascii.ts`
2. **Rename the 6 private `py*` helpers in `diff-extractor.ts`:** `pyEqual` ->
   `specValueEqual`, `pyTruthy` -> `isTruthy`, `pyOr` -> `orDefault`, `pyGet` ->
   `getOrDefault`, `pyListEqual` -> `arrayEqual`, `pyDictEqual` -> `objectEqual`
   (plus `isNone` -> `isAbsent`), and drop its "Python: ..." doc comments. The
   #924 pins in `ts/test/guardian-diff.test.ts` stay unchanged.
3. **Stale CI comments** in `.github/workflows/harness-quality.yml`: drop the
   Python `validate` job references, keep why pytest is installed. Job name
   `TS engine (pilot)` unchanged.
4. **Gates** from `ts/`: build, typecheck, format:check, test. Confirm no net
   non-blank growth in `ts/src` and measure `harness check-arch`.

## Issue group 4

- `spike/schemathesis/` is kept, per ADR 0012 and because
  `docs/roadmap-archive.md` links its `SPIKE_REPORT.md`. A `README.md` in the
  directory says why it stays, which meets #926's acceptance item. Decided by
  the human after the rebuild.

## Out of scope (tracked elsewhere)

- "Faithful port" headers in modules the issue does not list, private `py*`
  copies in other modules (`pyTruthy`, `pyGet`, `pyRepr`, ...), and the stale
  MCP registry path: #970.
- `pyInt` / `pyFloat` / `pySlice` (#964); "oracle" comments (#965).
- Python-behavior comparisons (`str.splitlines()`, `Path.suffix`, ...) stay,
  because they document behavior the code still reproduces.
