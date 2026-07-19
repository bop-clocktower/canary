# Plan: canary-pr-guardian — Phase 1 (Deterministic Engine)

**Date:** 2026-07-19 | **Spec:** `docs/changes/canary-pr-guardian/proposal.md` |
**Tasks:** 13 | **Sitting-sized (≤3 files each)** | **Integration Tier:** medium

> Scope note: **Phase 1 ONLY** — the agent-free Tier 0 core. Phases 2–6 (PR
> workflow surface, pre-commit hook, agent orchestrator/`AgentTier`,
> harness-check integration, docs/ADRs) are explicitly out of scope here.

## Goal

Ship the deterministic, agent-free Tier 0 core (`agent/guardian/coverage.py` +
`agent/guardian/pr_check.py`, wired as `canary guardian pr-check`) that scopes a
git diff, resolves diff-coverage at the highest available fidelity, renders
fidelity-labeled findings, and computes soft/hard gate exit codes — with no LLM
or agent dependency.

## Success Criteria This Phase Verifies

| SC    | Criterion (from spec)                                                                                                                             | Delivered by tasks |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| SC-3  | Coverage resolution selects highest available fidelity per unit (report › graph › heuristic) + labels each                                        | T1, T3, T4, T5, T6 |
| SC-4  | `gate: hard` exits non-zero on unaddressed `critical/high` `untested-new-code`; `soft` always 0; addressed = covering-test-in-diff OR suppression | T7, T8, T9         |
| SC-8  | Malformed `canary.guardian` block → loud warning via `read_json_with_warning`, not silent default                                                 | T11                |
| SC-11 | Deterministic engine imports no `AgentTier`/LLM/agent module — capability boundary holds                                                          | T13                |
| SC-12 | `// canary:allow-untested <reason>` clears a finding from the hard-gate exit calc but keeps it visible (labeled `suppressed`)                     | T8, T9, T10        |

_Scaffolded-not-verified this phase (per parent brief):_ `skipGlobs` and
`pr.tier`/`preCommit` config **fields are read** into the config object (T11)
but their behavior (SC-2 skip, SC-5 tier degradation) is a **later phase**. T11
reads them; nothing in Phase 1 acts on them beyond storage.

## Observable Truths (Acceptance Criteria, EARS)

1. **Event-driven:** When `resolve_coverage` runs on a changed unit that appears
   in a coverage report, a matching graph node, **and** a naming-heuristic hit,
   the system shall return exactly one `CoverageResult` with
   `fidelity == COVERAGE_VERIFIED` (report wins). (SC-3)
2. **Event-driven:** When only a populated graph is available (no report), the
   system shall return `fidelity == GRAPH_VERIFIED`; when neither report nor
   graph is present, it shall return `fidelity == HEURISTIC`. (SC-3)
3. **State-driven:** While `gate == "hard"` and at least one `critical|high`
   `untested-new-code` finding is neither covered-in-diff nor suppressed, the
   CLI shall exit non-zero; otherwise it shall exit 0. (SC-4)
4. **Ubiquitous:** While `gate == "soft"`, the CLI shall always exit 0. (SC-4)
5. **Unwanted:** If a changed unit carries a `// canary:allow-untested <reason>`
   (or `# canary:allow-untested <reason>`) annotation, then the system shall not
   count it in the hard-gate exit calculation, and shall still render it labeled
   `suppressed`. (SC-12)
6. **Event-driven:** When the `canary.guardian` block is malformed JSON, the
   system shall surface the `read_json_with_warning` warning string and fall
   back to defaults — never silently. (SC-8)
7. **Ubiquitous:** The system shall ensure `agent/guardian/pr_check.py` and
   `agent/guardian/coverage.py` import no `AgentTier`, `agent.llm`, or LLM-SDK
   module. (SC-11)

## File Map

- CREATE `agent/guardian/coverage.py` — tiered coverage resolver + fidelity
  shapes
- CREATE `agent/guardian/pr_check.py` — Tier 0 engine (scope, findings,
  suppression, exit codes, render, config)
- MODIFY `agent/guardian/cli.py` — register `pr-check` on `guardian_app`
- MODIFY `agent/guardian/__init__.py` — export `Fidelity`, `Finding`,
  `CoverageResult`
- CREATE `tests/unit/test_guardian_coverage.py` — coverage.py TDD
- CREATE `tests/unit/test_guardian_pr_check.py` — pr_check.py + CLI TDD
- CREATE `tests/unit/test_guardian_config.py` — config-load TDD (SC-8)
- CREATE `tests/unit/test_guardian_capability_boundary.py` — SC-11 architecture
  test

## Assumptions & Uncertainties

- **[ASSUMPTION] Graph has no explicit `tests`/`covers` edge.** Verified: the
  live graph (`.harness/graph/graph.json`) carries only `contains`, `calls`,
  `imports`, `documents`, `triggered_by`, `co_changes_with` edge types. So
  **graph-verified coverage is _derived_** — a changed file is "graph-covered"
  iff some **test-path node** (path matches `tests/**`, `test_*.py`, `*.test.*`,
  `*.spec.*`) reaches the changed file's node (or a symbol node it `contains`)
  via a `calls`/`imports` edge. If this heuristic proves too loose in review,
  tighten in a follow-up; it is intentionally conservative (edge present →
  covered).
- **[ASSUMPTION] Read `graph.json` directly, not `impact-preview`.** Verified:
  `harness impact-preview --json` reports only _staged_ changes ("no staged
  changes" against a clean tree) and needs staging, so it cannot score an
  arbitrary `--diff`. The engine parses the NDJSON `graph.json` directly; the
  MCP `analyze_diff`/`get_impact` tools are the agent-tier equivalents and are
  **not** used here (SC-11).
- **[ASSUMPTION] Coverage-report formats.** Phase 1 supports `coverage.json`
  (canary's own report shape) and `lcov.info`. `coverage.xml` (Cobertura) is
  **deferrable** — resolver returns "format unrecognized → no report result" and
  falls through, so absence never blocks.
- **[ASSUMPTION] `canary.guardian` absent today** (verified). Absent → defaults
  silently; malformed → warn (SC-8).
- **[DEFERRABLE] Exact rendered comment prose/emoji.** Structure is pinned
  (sticky marker, fidelity summary line, severity-ranked findings, tier footer);
  exact wording finalized during implementation.
- **[DEFERRABLE] AST symbol granularity.** Phase 1 keys findings at
  file+line-range granularity; `Finding.unit` carries a symbol name **when a
  cheap scan yields one**, else the file path. Deep AST symbol attribution is
  not required for the SCs above.

## Skeleton (produced — standard mode, 13 tasks ≥ 8)

1. **Shapes & diff scoping** (T1–T2) —
   `Fidelity`/`ChangedUnit`/`CoverageResult`; unified-diff parser.
2. **Tiered resolvers** (T3–T5) — report, graph, heuristic; each
   fidelity-labeled.
3. **Resolver orchestrator** (T6) — first-hit-wins per unit. **← CHECKPOINT
   (coverage resolver testable, SC-3).**
4. **Findings & gate** (T7–T9) — `Finding` build, suppression, exit codes.
5. **Render & config** (T10–T11) — comment/json/text; `canary.guardian` load.
6. **CLI & boundary** (T12–T13) — register `pr-check`; SC-11 architecture test.

_Skeleton approved: proceeding to full tasks per parent directive._

## Conventions (apply to every task)

- **TDD, test-first.** Write the test, run it, watch it fail for the intended
  reason, then implement until green. No implementation before a failing test.
- **Test command:** `python3 -m pytest tests/unit/<file> -q`
- **Lint (every task):** `ruff check agent tests`
- **Validate (every task, final step):** `harness validate`
- **Commit (every task):** conventional `feat(guardian): …` /
  `test(guardian): …`. We are on `feat/canary-pr-guardian`; commit per task.
- **No agent/LLM imports** in `coverage.py` or `pr_check.py` (SC-11 is enforced
  by T13 but respect it from T1).

---

## Tasks

### Task 1: Coverage shapes — `Fidelity`, `ChangedUnit`, `CoverageResult`

**Depends on:** none | **Files:** `agent/guardian/coverage.py`,
`tests/unit/test_guardian_coverage.py`

**Outputs (signatures to implement):**

```python
# agent/guardian/coverage.py
class Fidelity(str, Enum):
    COVERAGE_VERIFIED = "coverage-verified"
    GRAPH_VERIFIED = "graph-verified"
    HEURISTIC = "heuristic"
    @property
    def rank(self) -> int: ...   # 0=coverage,1=graph,2=heuristic (lower = higher fidelity)

@dataclass
class ChangedUnit:
    path: str
    added_ranges: list[tuple[int, int]]   # inclusive 1-based line ranges added by the diff
    symbol: str | None = None

@dataclass
class CoverageResult:
    unit: ChangedUnit
    covered: bool
    fidelity: Fidelity
    evidence: str
    uncovered_lines: list[int] = field(default_factory=list)
```

**TDD steps:**

1. Write `tests/unit/test_guardian_coverage.py::TestShapes` — assert
   `Fidelity.COVERAGE_VERIFIED.rank < Fidelity.GRAPH_VERIFIED.rank < Fidelity.HEURISTIC.rank`;
   construct a `ChangedUnit`/`CoverageResult` and read fields back.
2. `python3 -m pytest tests/unit/test_guardian_coverage.py -q` → fails (module
   missing).
3. Implement the shapes.
4. Rerun → passes. `ruff check agent tests`. `harness validate`.
5. Commit: `feat(guardian): add coverage fidelity shapes`

### Task 2: Diff scoping — unified diff → `ChangedUnit` list

**Depends on:** T1 | **Files:** `agent/guardian/pr_check.py`,
`tests/unit/test_guardian_pr_check.py`

**Outputs:**

```python
# agent/guardian/pr_check.py
def scope_diff(diff_text: str) -> list[ChangedUnit]: ...
    # parse unified-diff hunks; per target file (b/ path) collect ADDED line
    # ranges from @@ headers + '+' lines (ignore '-' and context). Skip
    # /dev/null deletes. One ChangedUnit per file, ranges merged.

def read_diff(source: str | None) -> str: ...
    # source == '-' → stdin; a path → file contents; None → subprocess
    # `git diff` (and fall back to `git diff --staged`). Pure passthrough of text.
```

**TDD steps:**

1. Write `TestScopeDiff` with an inline unified-diff fixture adding lines 12–28
   to `agent/core/foo.py` and touching a second file; assert two `ChangedUnit`s
   with correct `added_ranges`; assert a pure-deletion hunk yields no added
   ranges.
2. Run → fail. Implement `scope_diff` (hunk-header regex `@@ -a,b +c,d @@`, walk
   body counting `+`/context lines). Implement `read_diff` (stdin/path/git).
3. Run → pass. Lint. Validate.
4. Commit: `feat(guardian): scope unified diff into changed units`

### Task 3: Resolver tier 1 — coverage-verified (report)

**Depends on:** T1 | **Files:** `agent/guardian/coverage.py`,
`tests/unit/test_guardian_coverage.py`

**Outputs:**

```python
def resolve_from_report(units, report_path: Path) -> list[CoverageResult] | None: ...
    # Parse report_path. Supported: *.json (canary coverage-report shape:
    # {"files": {"<path>": {"covered_lines": [...] }}} — adapt to the actual
    # canary shape) and lcov.info (DA:<line>,<hits>). Unrecognized/empty → None
    # (fall through). For each unit: a line in added_ranges with hits>0 => covered;
    # any added line with 0 hits => uncovered (record uncovered_lines).
    # fidelity = COVERAGE_VERIFIED, evidence e.g. "lines 12-28: 3 uncovered".
```

**TDD steps:**

1. `TestResolveFromReport`: fixture lcov + fixture json in `tmp_path`; a unit
   whose added lines are all hit → `covered is True`; a unit with a zero-hit
   added line → `covered is False` + populated `uncovered_lines`; an
   unreadable/unknown format → returns `None`.
2. Run → fail. Implement lcov + json parsers + line mapping.
3. Run → pass. Lint. Validate.
4. Commit: `feat(guardian): coverage-verified resolver from lcov/json reports`

### Task 4: Resolver tier 2 — graph-verified (derived from `.harness/graph`)

**Depends on:** T1 | **Files:** `agent/guardian/coverage.py`,
`tests/unit/test_guardian_coverage.py`

**Outputs:**

```python
def resolve_from_graph(units, graph_path: Path = Path(".harness/graph/graph.json")
                       ) -> list[CoverageResult] | None: ...
    # If graph_path missing/empty → None (fall through — never blocks).
    # Parse NDJSON: each line is {"kind":"node"|"edge", ...}. Build:
    #   - nodes-by-path index
    #   - reverse adjacency for `calls`/`imports`/`contains`
    # A unit's file is GRAPH-COVERED iff some TEST-PATH node
    #   (path matches tests/**, test_*.py, *.test.*, *.spec.*)
    #   reaches the file's node (or a symbol it `contains`) via calls/imports.
    # fidelity = GRAPH_VERIFIED; evidence names the covering test node.
    # NOTE: read the file directly — do NOT shell impact-preview (staged-only)
    # and do NOT import analyze_diff/get_impact MCP tools (SC-11).
```

**TDD steps:**

1. `TestResolveFromGraph`: write a tiny NDJSON fixture (a source file node, a
   test file node, a `calls` edge test→source) to `tmp_path`; assert covered. A
   second source node with no inbound test edge → uncovered. A **missing** graph
   path → `None`.
2. Run → fail. Implement NDJSON streaming parse + reverse traversal.
3. Run → pass. Lint. Validate.
4. Commit: `feat(guardian): graph-verified resolver via .harness/graph NDJSON`

### Task 5: Resolver tier 3 — heuristic (naming/AST)

**Depends on:** T1 | **Files:** `agent/guardian/coverage.py`,
`tests/unit/test_guardian_coverage.py`

**Outputs:**

```python
def resolve_heuristic(units, repo_root: Path = Path(".")) -> list[CoverageResult]: ...
    # Always returns a result per unit (last-resort tier, never None).
    # For each unit: derive a base symbol (module/file stem + top-level def/class
    # names via a cheap `ast.parse` for .py, regex for others). A unit is
    # HEURISTIC-covered iff a test file (test_*.py / *.test.* / *.spec.*) under
    # repo_root references the file stem or a symbol name (substring/import scan).
    # fidelity = HEURISTIC; evidence names the referencing test file or
    # "no *.test.* references <symbol>".
```

**TDD steps:**

1. `TestResolveHeuristic`: `tmp_path` repo with `pkg/foo.py` and
   `tests/test_foo.py` that imports/mentions `foo` → covered; a `pkg/bar.py`
   with no test mention → uncovered; assert `fidelity == HEURISTIC` in both.
2. Run → fail. Implement stem/symbol extraction + test-file scan.
3. Run → pass. Lint. Validate.
4. Commit: `feat(guardian): heuristic naming/AST coverage resolver`

### Task 6: Resolver orchestrator — first-hit-wins per unit (SC-3) ⟵ CHECKPOINT

**Depends on:** T3, T4, T5 | **Files:** `agent/guardian/coverage.py`,
`tests/unit/test_guardian_coverage.py`

**Outputs:**

```python
def resolve_coverage(units,
                     coverage_path: Path | None = None,
                     graph_path: Path = Path(".harness/graph/graph.json"),
                     repo_root: Path = Path(".")) -> list[CoverageResult]: ...
    # Per unit, first available signal wins:
    #   1. coverage_path present & resolve_from_report != None  → COVERAGE_VERIFIED
    #   2. else resolve_from_graph != None                       → GRAPH_VERIFIED
    #   3. else resolve_heuristic                                → HEURISTIC
    # Returns exactly one CoverageResult per input unit, fidelity-labeled.
```

**TDD steps:**

1. `TestResolveCoverage` — the SC-3 matrix, one assertion per combination:
   report+graph+heuristic all present → `COVERAGE_VERIFIED`; graph+heuristic
   only → `GRAPH_VERIFIED`; heuristic only → `HEURISTIC`. Assert exactly one
   result per unit.
2. Run → fail. Implement the fallthrough ladder.
3. Run → pass. Lint. Validate.
4. Commit:
   `feat(guardian): tiered coverage resolver (report > graph > heuristic)`

> **[checkpoint:human-verify]** The coverage resolver is now independently
> testable and SC-3 is green. **Pause for human review** of the fidelity ladder,
> the graph-edge derivation assumption, and the report-format coverage
> **before** building the findings/gate engine on top. Show
> `pytest tests/unit/test_guardian_coverage.py -v` output and the SC-3 matrix.
> Wait for confirmation to proceed to T7.

### Task 7: `Finding` shape + `build_findings` (severity via impact_mapper)

**Depends on:** T1, T6 | **Files:** `agent/guardian/pr_check.py`,
`tests/unit/test_guardian_pr_check.py`

**Outputs:**

```python
# pr_check.py — reuse impact_mapper.Severity (do NOT invent a new vocab)
from agent.guardian.impact_mapper import Severity

@dataclass
class Finding:
    path: str
    unit: str                     # symbol or file
    kind: str = "untested-new-code"   # weak-test is Tier 1+, out of Phase 1
    fidelity: Fidelity = Fidelity.HEURISTIC
    severity: Severity = Severity.HIGH
    evidence: str = ""
    suggestion: str = ""
    suppressed: bool = False
    suppression_reason: str | None = None

def build_findings(results: list[CoverageResult]) -> list[Finding]: ...
    # Only uncovered results become findings. Severity policy (Phase 1):
    #   coverage-verified uncovered → HIGH ; graph-verified uncovered → HIGH ;
    #   heuristic uncovered → MEDIUM (lower confidence). Sort by Severity.sort_key.
```

**TDD steps:**

1. `TestBuildFindings`: covered result → no finding; uncovered heuristic →
   MEDIUM; uncovered graph/report → HIGH; findings sorted critical→low;
   `fidelity`/`evidence` propagated from the `CoverageResult`.
2. Run → fail. Implement. 3. Run → pass. Lint. Validate.
3. Commit:
   `feat(guardian): build fidelity-labeled findings from coverage results`

### Task 8: Suppression detection — `// canary:allow-untested` (SC-12)

**Depends on:** T7 | **Files:** `agent/guardian/pr_check.py`,
`tests/unit/test_guardian_pr_check.py`

**Outputs:**

```python
def apply_suppressions(findings, repo_root: Path = Path(".")) -> list[Finding]: ...
    # Scan each finding's source file for a `canary:allow-untested <reason>`
    # annotation (accept `//` and `#` comment leaders). If present in/near the
    # unit, mark finding.suppressed = True and capture suppression_reason=<reason>.
    # Returns the same findings, mutated/replaced — suppressed ones stay in the list.
```

**TDD steps:**

1. `TestSuppressions`: a source file containing
   `# canary:allow-untested legacy shim` → its finding `.suppressed is True` and
   `.suppression_reason == "legacy shim"`; a file without the annotation →
   `.suppressed is False`.
2. Run → fail. Implement (regex `canary:allow-untested\s+(.+)`). 3. Run → pass.
   Lint. Validate.
3. Commit:
   `feat(guardian): honor // canary:allow-untested suppression annotations`

### Task 9: Exit-code logic — soft/hard gate (SC-4)

**Depends on:** T7, T8 | **Files:** `agent/guardian/pr_check.py`,
`tests/unit/test_guardian_pr_check.py`

**Outputs:**

```python
def compute_exit_code(findings, gate: str) -> int: ...
    # gate == "soft" → always 0.
    # gate == "hard" → 1 iff any finding is:
    #     kind == "untested-new-code"
    #     AND severity in {CRITICAL, HIGH}
    #     AND NOT addressed
    #   where addressed == finding.suppressed (SC-12) OR covered-in-diff
    #   (covered-in-diff = the finding no longer exists because a covering test was
    #    added in the same diff — i.e. it simply won't be in `findings`; suppressed
    #    findings remain in the list, so the check is `not suppressed`).
    # else 0.
```

**TDD steps:**

1. `TestExitCode`: hard + unaddressed HIGH untested → 1; hard + same finding
   suppressed → 0; hard + only MEDIUM/LOW → 0; soft + unaddressed CRITICAL → 0
   (soft always 0); empty findings → 0.
2. Run → fail. Implement. 3. Run → pass. Lint. Validate.
3. Commit: `feat(guardian): soft/hard gate exit-code logic with suppression`

### Task 10: Renderers — comment / json / text (sticky marker, fidelity labels)

**Depends on:** T7, T8 | **Files:** `agent/guardian/pr_check.py`,
`tests/unit/test_guardian_pr_check.py`

**Outputs:**

```python
def render(findings, fmt: str, tier: int = 0, degraded_notice: str | None = None) -> str: ...
    # fmt == "comment": begins with the sticky marker `<!-- canary-pr-guardian -->`;
    #   a fidelity-labeled summary line; findings ranked by severity, each showing
    #   path/unit, severity, fidelity, evidence; SUPPRESSED findings rendered but
    #   visually marked `suppressed`; footer states "tier 0" (+ degraded_notice if any).
    # fmt == "json": {"findings":[...serialized Finding...], "tier":0} — stable schema.
    # fmt == "text": plain, no markdown, for local/CLI output.
```

**TDD steps:**

1. `TestRender`: comment output contains `<!-- canary-pr-guardian -->` and each
   finding's `fidelity` label; a suppressed finding appears with a `suppressed`
   marker; json output round-trips via `json.loads` and lists all findings; text
   output has no `<!--` marker.
2. Run → fail. Implement. 3. Run → pass. Lint. Validate.
3. Commit:
   `feat(guardian): render findings as comment/json/text with fidelity labels`

### Task 11: Config loader — `canary.guardian` via `read_json_with_warning` (SC-8)

**Depends on:** none | **Files:** `agent/guardian/pr_check.py`,
`tests/unit/test_guardian_config.py`

**Outputs:**

```python
from agent.core.config_validation import read_json_with_warning

@dataclass
class GuardianConfig:
    pr_enabled: bool = True
    pr_tier: int = 0
    pr_gate: str = "soft"
    precommit_enabled: bool = False
    precommit_author_tests: bool = True
    precommit_gate: str = "soft"
    coverage_paths: list[str] = field(default_factory=list)   # scaffold (T-later use)
    skip_globs: list[str] = field(default_factory=list)       # scaffold (SC-2 later)

def load_guardian_config(config_path: Path = Path("harness.config.json")
                         ) -> tuple[GuardianConfig, str | None]: ...
    # Uses read_json_with_warning. Returns (GuardianConfig, warning_or_None):
    #   file absent            → (defaults, None)              # silent, normal
    #   malformed JSON         → (defaults, "<warning str>")   # LOUD, SC-8
    #   valid but no canary.guardian → (defaults, None)
    #   valid canary.guardian  → (parsed, None); tier/gate/skipGlobs read into fields
```

**TDD steps:**

1. `TestLoadGuardianConfig`: valid block → fields parsed (incl
   `skipGlobs`/`tier` stored but unused); **malformed JSON file → non-None
   warning + defaults (SC-8)**; absent file → `(defaults, None)`; valid file
   lacking the block → `(defaults, None)`.
2. Run → fail. Implement. 3. Run → pass. Lint. Validate.
3. Commit:
   `feat(guardian): load canary.guardian config with loud malformed warning`

### Task 12: CLI — register `guardian pr-check`

**Depends on:** T2, T6, T7, T8, T9, T10, T11 | **Files:**
`agent/guardian/cli.py`, `agent/guardian/__init__.py`,
`tests/unit/test_guardian_pr_check.py`

**Outputs:** a new `@guardian_app.command("pr-check")` alongside
`analyze`/`watch`:

```python
@guardian_app.command("pr-check")
def pr_check(
    diff: Optional[str] = typer.Option(None, "--diff", help="Diff file, '-' for stdin, or omit to use `git diff`."),
    coverage: Optional[str] = typer.Option(None, "--coverage", help="Coverage report path (lcov/json)."),
    fmt: str = typer.Option("comment", "--format", help="comment|json|text"),
    config_path: str = typer.Option("harness.config.json", "--config"),
    gate: Optional[str] = typer.Option(None, "--gate", help="Override config gate: soft|hard"),
) -> None:
    # Pipeline: load_guardian_config → read_diff/scope_diff → resolve_coverage
    #   → build_findings → apply_suppressions → render(print) → raise typer.Exit(compute_exit_code)
    # If config warning present, print it loudly first (SC-8). gate override wins.
    # Update agent/guardian/__init__.py to export Fidelity, Finding, CoverageResult.
```

**TDD steps:**

1. `TestPrCheckCLI` (typer `CliRunner`): pipe a diff via `--diff -` that adds an
   untested unit; `--format json` → parseable output with a finding;
   `--gate soft` → `exit_code == 0`; `--gate hard` with an unaddressed HIGH
   untested finding → `exit_code != 0`. (Point `--coverage`/graph at nothing so
   the heuristic tier runs deterministically in `tmp_path`.)
2. Run → fail. Implement the command + `__init__` exports.
3. Run → pass. Run the **full** guardian suite:

   ```bash
   python3 -m pytest tests/unit/test_guardian_pr_check.py \
     tests/unit/test_guardian_coverage.py \
     tests/unit/test_guardian_config.py -q
   ```

   Lint. Validate.

4. Commit: `feat(guardian): register pr-check Tier 0 CLI command`

### Task 13: Capability-boundary architecture test (SC-11)

**Depends on:** T1–T12 | **Files:**
`tests/unit/test_guardian_capability_boundary.py`

**Outputs:** an import/AST architecture test asserting the deterministic engine
is LLM/agent-free.

**TDD steps:**

1. Write `test_guardian_capability_boundary.py`: `ast.parse` both
   `agent/guardian/pr_check.py` and `agent/guardian/coverage.py`; collect every
   `import`/`from … import` module string; assert **none** match a denylist:
   `AgentTier`, `agent.llm`, `anthropic`, `openai`, `google.generativeai`, and
   any `*agent*tier*`/LLM-client pattern. Also assert neither module references
   the `analyze_diff`/`get_impact` MCP tool names. This test _fails first_ only
   if a forbidden import exists — so it should pass immediately on clean
   modules; to honor TDD, first add a throwaway `import anthropic` locally,
   watch it fail, then remove it and watch it pass (documented in the test's
   docstring as the RED proof).
2. Run → confirm RED-proof then GREEN. Lint. Validate.
3. Commit:
   `test(guardian): assert Tier 0 engine imports no agent/LLM module (SC-11)`

---

## Sequencing & Parallelism

- **Critical path:** T1 → T6 (via T3/T4/T5) → **checkpoint** → T7 → T8/T9/T10 →
  T12 → T13.
- **Parallelizable:** T3, T4, T5 (independent resolver tiers, all depend only on
  T1). T11 (config) is fully independent and can be done any time before T12. T2
  (diff scoping) depends only on T1 and can run alongside the resolver tiers.
- **File-contention note:** T3/T4/T5/T6 all touch `coverage.py` +
  `test_guardian_coverage.py`; T7/T8/T9/T10/T11 all touch `pr_check.py` (T11
  also `test_guardian_config.py`). Sequence tasks that share a file; parallelize
  only across the two modules.

## Post-Phase Verification (Definition of Done)

Run the full new-suite and repo gates:

```bash
python3 -m pytest tests/unit/test_guardian_coverage.py \
  tests/unit/test_guardian_pr_check.py \
  tests/unit/test_guardian_config.py \
  tests/unit/test_guardian_capability_boundary.py -q
ruff check agent tests
harness validate
python3 -m agent.cli guardian pr-check --help   # command discoverable
```

All green + SC-3/4/8/11/12 each traced to a passing test ⇒ Phase 1 complete.
Phase 2 (PR workflow surface, sticky-comment upsert, `--post-comment`,
`skipGlobs` behavior) picks up from here.
