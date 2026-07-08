# Canary Fail-Fast — Overlay Upstreaming

**Status:** approved (design sign-off 2026-07-02)
**Type:** feature (bundled executable skill) — new production code + tests
**Keywords:** fail-fast, overlay-upstreaming, playwright, ci, digest,
github-annotations, config-audit, bundled-skill, self-contained, canary-fail-fast

## Overview and goals

Generalize the private overlay's fail-fast skill into a
client-agnostic, bundled Canary skill named **`canary-fail-fast`**. It surfaces
Playwright test failures **fast** (recommends the config knobs that abort a
broken CI run early) and **loud** (a categorized failure digest to the CI log +
GitHub `::error` annotations, with a non-zero exit so the signal cannot be
missed).

The skill has two independent halves; at least one is required per invocation:

1. **Config audit** — substring-scans a `playwright.config.*` for three
   fail-fast knobs (`forbidOnly` / `maxFailures` / `retries`) and prints
   paste-in recommendations. Read-only; never fails the build.
2. **Loud digest** — parses a Playwright JSON results file, categorizes the
   failures, prints a terse per-category summary + one `::error` annotation per
   failure, and exits non-zero when any real (non-flaky) failure is present.

It lands as a **bundled executable skill** at
`agents/skills/claude-code/canary-fail-fast/` (`cli: scripts/cli.py`),
discoverable via `canary skills list` and runnable via
`canary skills run canary-fail-fast -- …`. The repo's `SkillRegistry` already
supports `cli:` frontmatter and the `skills run` verb; this is the first
*bundled* executable skill, but no registry change is required.

**Out of scope:** Slack summaries, per-branch run history, HTML reports, and the
`@known-failure` quarantine ledger — those belong to the separate "Generic test
reporter" roadmap item. No changes to `SkillRegistry`, `agent/cli.py`, or the
overlay repo. This skill does **not** depend on the overlay's shared
test-reports module or any
future `agent/reports/` module.

## Decisions made

| Decision | Choice | Rationale |
| --- | --- | --- |
| Home | Bundled skill at `agents/skills/claude-code/canary-fail-fast/` | Native, discoverable/runnable via existing registry; mirrors overlay shape for easy further upstreaming |
| Parser coupling | **Self-contained** — bundle a minimal parser + categorizer in the skill's own `scripts/` | Honors roadmap's "decouple the shared results parser"; keeps this a low-effort, copy-paste-portable folder; does not front-load the medium-effort reporter item |
| Parser scope | Extract **failures only** (drop full `ReportData` envelope: passed/skipped/pass-rate) | Fail-fast needs only the failures bucket; the copy is smaller than the overlay's 113-line `parse_results.py`, not a straight duplicate |
| Flaky handling | A `failed`/`unexpected` test with any passing retry is **flaky**, excluded from the failure count/exit code | Matches overlay semantics; a flake should not fail the digest step |
| De-id | overlay skill names → `canary-*` (name, `prog`, messages); drop the overlay's `deploy_to` client-target list; remove `sys.path` cross-skill hack | Zero client strings by construction; the roadmap's stated de-id surface |
| CLI surface | Keep `--results` and `--config` flags; at least one required | Preserves overlay ergonomics; results path is already a configurable argument |
| Exit-code contract | Audit contributes 0; digest exits 1 on any real failure; combined = OR | Config audit must never fail a build; failures must fail the step |

## Technical design

Self-contained skill directory (no imports outside the directory):

```text
agents/skills/claude-code/canary-fail-fast/
  SKILL.md                 # cli: scripts/cli.py; de-id'd prose + config block + CI YAML
  scripts/
    __init__.py
    cli.py                 # arg parsing, orchestration, exit codes
    fastfail_check.py      # config audit (pure)     — ported, de-id'd
    parse.py               # NEW: minimal Playwright JSON → list[Failure]
    failures.py            # failure categorizer (pure) — ported, de-id'd
    types.py               # Failure dataclass
```

### `types.py`

A single `Failure` dataclass: `title: str`, `status: str`, `file: str | None`,
`line: int | None`, `error: str | None`. Carries `__test__ = False` so pytest
does not try to collect it.

### `parse.py` — `parse_failures(results_path: Path) -> list[Failure]`

Minimal port of the overlay's `parse_results_from_json`, reduced to the failures
bucket. Walks nested `suites` → `specs` → `tests`, reads the last result's
error message (falling back to `errors[0].message`), and classifies:

- `failed`/`unexpected` **with** a passing retry (`passed`/`expected`) → flaky →
  **excluded** from the returned list.
- `failed`/`unexpected` **without** a passing retry → appended to failures.

Defensive JSON handling ported verbatim: strip leading non-JSON content before
`json.loads`; missing file → `[]`; malformed JSON → `ValueError`; non-object
top level → `ValueError`.

### `failures.py` — `categorize_failure(error) -> str`, `FAILURE_CATEGORIES`

Verbatim port of the overlay categorizer: an ordered regex rule list mapping an
error message to one of `schema` / `auth` / `server` / `client` / `timeout` /
`network` / `other`. Order is load-bearing (most distinctive signals first);
preserved exactly. No client-specific patterns exist in the rules.

### `fastfail_check.py` — `check_config(text: str) -> list[str]`

Ported verbatim (already client-agnostic): returns one recommendation per
fail-fast knob absent from the config text. Empty list = all present. The
`CANONICAL` paste-in block is generic Playwright and is retained.

### `digest.py` — `build_digest(failures: list[Failure]) -> Digest`

Ported from the overlay. Returns a `Digest(text, annotations, exit_code)`:

- No failures → `text="✅ 0 failing tests."`, no annotations, `exit_code=0`.
- N failures → a per-category summary (`FAILURE_CATEGORIES` order, empty
  categories skipped), one `::error file=…,line=…,title=Test failure::…`
  annotation per failure, and `exit_code=1`.

### `cli.py` — `main(argv) -> int`

`argparse` with `--results PATH` and `--config PATH`. Neither → usage error,
exit 1. `--config`: read file (OSError → exit 1) → `check_config` → print recs
or "Fail-fast config OK." (contributes 0). `--results`: missing file → exit 1;
otherwise `parse_failures` → `build_digest` → print text + annotations → adopt
the digest exit code. Combined exit = digest code (audit never raises it).

### Error handling

Missing or unreadable `--results` file exits 1 with a clear stderr message;
malformed JSON surfaces as a `ValueError` → exit 1; an unreadable `--config`
exits 1. No silent fallbacks or fail-open behavior.

## Integration Points

- **Entry Points:** new bundled skill directory
  `agents/skills/claude-code/canary-fail-fast/` with `SKILL.md`
  (`cli: scripts/cli.py`) and `scripts/`. Invoked as
  `canary skills run canary-fail-fast -- --results <json> [--config <path>]`.
- **Registrations Required:** none — `SkillRegistry._bundled_harness_skills`
  auto-discovers `agents/skills/claude-code/<name>/SKILL.md`, and `_parse_nested`
  already reads the `cli:` field. No `agent/cli.py` or registry change.
- **Documentation Updates:** the skill's own `SKILL.md`. Mark the roadmap
  "Fail-fast CI gate" item done on merge. No `AGENTS.md` change.
- **Architectural Decisions:** none (no ADR — additive skill, no cross-module
  coupling introduced).
- **Knowledge Impact:** relates to the overlay-upstreaming effort; the
  test-reports and instrument items remain the other upstreaming candidates.

## Success criteria

- The skill appears in `canary skills list` and is invocable via
  `canary skills run canary-fail-fast`.
- Config audit: each missing knob yields exactly one recommendation; all present
  → "Fail-fast config OK."; audit alone never sets a non-zero exit.
- Digest: 0 failures → exit 0 + "0 failing"; N failures → categorized text, one
  `::error` (with `file=`/`line=` when known) per failure, exit 1; a flaky test
  (failed-then-passed retry) is excluded from the failure count and exit code.
- CLI: neither flag → exit 1 with usage; missing/malformed `--results` → exit 1.
- No overlay client/company identifier (per the repo denylist) or the overlay
  skill name appears anywhere in the shipped files.
- New pytest tests cover `check_config`, `parse_failures`, `build_digest`, and
  `cli` exit codes; the full suite stays green.

## Implementation order

1. `types.py` (Failure) + failing tests for `parse_failures` → implement
   `parse.py` (TDD).
2. `failures.py` (port categorizer) + tests for category boundaries.
3. `fastfail_check.py` (port) + tests for knob detection.
4. `digest.py` (port) + tests for text/annotations/exit code.
5. `cli.py` wiring + tests for arg validation and combined exit codes.
6. `SKILL.md` (de-id'd prose, generic config block, CI YAML, `cli:` frontmatter).
7. Verify `canary skills list`/`run` discover and execute it; run full pytest +
   markdownlint; grep for residual client strings.
8. Commit on `feat/canary-fail-fast`; open PR; mark roadmap item done.
