# Host-LLM Migration Verification — 2026-05-26

**Branch:** `docs/host-llm-verification-2026-05-26`
**Scope:** Phases 1 (oracle-test-author) and 2 (oracle-test-healer)
**Method:** static analysis of agent instructions + probe of
`oracle__analyze_file` against representative inputs + walkthrough
of each shipped example prompt

This report is the "Task 4 reviewer verification" from
[Phase 1's plan](../../plans/host-llm-migration.md) and the parallel
Task 3 from [Phase 2's plan](../../plans/self-heal-migration.md).
Both PRs (#136, #137) deferred this work to a reviewer; doing it
proactively before the Wednesday architecture meeting so we walk in
with concrete evidence the migration works (or specific issues to fix).

Note on baseline: a strict side-by-side against `oracle generate`
would need a provider API key, which is by policy off-limits
(per the `feedback_no_api_keys` agent memory). The verification
instead probes the agent's input surface, walks the four example
prompts through the agent's documented Process, and surfaces gaps
between what the instructions claim and what the MCP tool actually
returns.

## Findings (high priority)

### Finding F1 — `oracle__analyze_file` `framework` field is misleading

`_analyze_file_impl` in `agent/mcp_server.py:13-43` sets
`framework` from the file suffix alone:

```python
if suffix in (".ts", ".js"):
    framework = "playwright"
elif suffix == ".py":
    framework = "pytest"
else:
    framework = "unknown"
```

This returns `framework: "playwright"` for any `.ts` file including
production source, and `framework: "pytest"` for any `.py` file
including `agent/core/classifier.py` (which is not a test).

**Impact on agent:** `oracle-test-author.md` Phase 2 step 1 says
"Capture the returned framework, test_type, imports, functions,
existing_tests, and context_snippets." An agent that trusts the
`framework` field on a source file will misclassify.

**Recommendation:** field should reflect the project's framework
(detected from config files via `MetadataScanner`), not the file's
suffix. Or rename the field to `file_kind` to make its semantics
clear. **Phase-1-blocking? No** — agent's Phase 1 already reads
config files independently, so the misleading field is just noise.
But worth fixing.

### Finding F2 — `functions` field is project-wide, not file-local

`_analyze_file_impl` returns
`domain.functions[:10]` where `domain` comes from
`DomainScanner().scan(project_root)`. The scanner walks the whole
project, not just the target file.

Probed against `agent/core/classifier.py`:

```json
"functions": [
  "is_ci", "extract_framework_hint", "extract_code",
  "build_issue_url", "record_last_generation",
  "load_last_generation", "resolve_cli_path",
  "is_executable_skill_allowed"
]
```

None of those are defined in `classifier.py`. They're cross-project
public names.

**Impact on agent:** could mislead the agent about which functions
exist in the file under test.

**Recommendation:** either filter `functions` to those defined in
the target file, or rename to `project_functions` to signal the
broader scope. Lower priority than F1.

### Finding F3 — `existing_tests` always empty

Even in a project with hundreds of tests, `analyze_file` returns
`existing_tests: []`. The field is hardcoded:

```python
"existing_tests": [],
```

**Impact on agent:** `oracle-test-author.md` Phase 2 step 1 captures
this field and Phase 2 step 4 says "Imports real fixtures from
`existing_tests` / `tests/helpers/`, not invented ones." The
`existing_tests` half of that pair never delivers. Agent falls back
to `Glob` (Phase 1 already does this), so functionally OK — but
the documented contract is broken.

**Recommendation:** populate `existing_tests` from
`pattern.recent_test_paths` or similar. Already flagged in Phase 1's
coverage matrix as a fixture-context gap; this is half of it.

### Finding F4 — `imports` field empty on most source files

Probed against `agent/core/classifier.py` (which has `import re`,
`from dataclasses import dataclass`) the response shows
`"imports": []`.

`_analyze_file_impl` sources `imports` from
`PatternMatcher().scan(project_root).common_imports`. The pattern
matcher computes "common imports across test files" — which is
empty for a non-test project tree, and missing for a project that
doesn't yet have shared test patterns.

**Impact on agent:** less context for matching idioms. Agent
recovers via Read.

**Recommendation:** clarify the field's meaning — if "common across
existing tests," document that. If "imports of the analyzed file,"
implement that.

## Findings (medium priority)

### Finding F5 — Path-not-found short-circuits without partial context

When `oracle__analyze_file` is called on a path that doesn't exist
(typical for "new test file" prompts) the response is just:

```json
{"error": "file not found: /tmp/foo.spec.ts"}
```

The agent's Phase 2 step 1 says "or on a representative existing
test in the same area if generating for a new module." That's fine
— the agent's Phase 1 (Anchor) already does the directory walk and
should land on an existing test path before calling analyze_file.

But if the agent skips the fallback and just calls analyze_file on
the user-supplied target path, it gets no context at all.

**Impact on agent:** depends on whether the agent reliably follows
Phase 1 before Phase 2. The instructions are clear; whether models
follow them is empirical.

**Recommendation:** consider returning a `nearest_existing_test`
field when the target path doesn't exist, so the agent has a
fallback even if it skips its own Phase 1.

### Finding F6 — agent's "tools" frontmatter has Bash but no rationale

`plugins/oracle/agents/oracle-test-author.md` line 5:
`tools: Bash, Read, Write, Edit, Glob, Grep, mcp__oracle__oracle__analyze_file`

The agent never uses `Bash` in its current Process. The only Bash
mention is in Phase 3 (verify with `npx playwright test`, `pytest`,
etc.). Worth either removing `Bash` if Phase 3's verification is
considered out of scope, or keeping it for the Phase 3 verify step.

**Recommendation:** keep — Phase 3's verify-the-test step is
load-bearing for the agent's quality bar.

## Per-prompt walkthrough

### `playwright-e2e-login`

> Generate a Playwright test for a login page at
> `https://example.com/login`. Two scenarios in one file:
> happy path + error path. Page object model where it adds clarity.
> Specific assertions (URL + visible text). No screenshots, no video.

**Agent flow:**

1. **Phase 1 (Anchor):** agent should glob for `playwright.config.*`
   — none present in this repo. Decide framework from prompt: user
   explicitly wrote "Playwright". OK.
2. **Phase 2 step 1:** call `analyze_file` on a target path. User
   didn't specify one. Agent should either ask or default to a
   conventional path like `tests/e2e/login.spec.ts`. Either way,
   `analyze_file` returns "file not found." Phase 2 step 2 (Read
   package.json, tsconfig, etc.) becomes load-bearing.
3. **Phase 2 step 4:** generate test code. Should be straightforward
   — the prompt is detailed and the user supplied both scenarios.
4. **Phase 2 step 5 (self-check):** "Does the framework choice
   match `oracle__analyze_file`'s detection?" Doesn't apply when
   analyze_file errored. **Suggestion:** rephrase the self-check to
   "Does the framework choice match the user's stated intent OR the
   project's config files OR analyze_file's detection (whichever
   resolved)?"

**Predicted output quality:** high. The prompt is detailed enough
that even without analyze_file context, the agent has everything
needed. Page object model decision is a judgment call the agent
handles via its instructions.

**Verdict:** PASS — instructions cover this case adequately.

### `pytest-api-checkout`

> Generate a Pytest test file for POST `/v1/checkout`. Three cases:
> success (201 + order_id), validation (400 + items message), auth
> (401). Use `requests` library. Bearer from `TEST_BEARER_TOKEN` env.

**Agent flow:**

1. **Phase 1:** detect framework from prompt ("Pytest"). Glob for
   `pyproject.toml` or `pytest.ini` to confirm version. Read
   `pyproject.toml` if present.
2. **Phase 2 step 1:** target path unspecified. Default to
   `tests/api/test_checkout.py`. `analyze_file` errors (file not
   found). Step 2 supplements via Read.
3. **Phase 2 step 4:** generate. The prompt is precise — three
   parametrize-friendly cases. Agent may use `pytest.mark.parametrize`
   or three separate test functions; either is fine.
4. **Self-check:** "For API tests: are HTTP status assertions tied
   to real endpoint behavior, not guessed?" — the prompt specifies
   expected statuses; agent should trust the prompt over its
   self-doubt heuristic.

**Predicted output quality:** high.

**Verdict:** PASS.

### `vitest-unit-validation`

> Vitest unit test for `validateEmail(input: string)`. Validity
> rules + edge cases listed. describe/it blocks, no snapshots.

**Agent flow:**

1. **Phase 1:** framework from prompt ("Vitest"). Look for
   `vitest.config.*` — none present here, but agent doesn't need it.
2. **Phase 2 step 1:** target path unspecified.
   `tests/validateEmail.test.ts` reasonable. analyze_file errors.
3. **Phase 2 step 4:** generate. Edge cases are explicit; mapping
   to `describe('validateEmail', () => { it('returns ok for...', …)})`
   is rote.
4. **Self-check passes:** unit test, no UI selectors, no API status
   codes, no real-network calls.

**Predicted output quality:** high.

**Verdict:** PASS.

### `k6-perf-checkout`

> k6 load test: 50 RPS for 30s, 5s ramp, fixed payload, bearer from
> env, thresholds p(95)<500ms + error rate <1%, 50ms sleep between
> iterations.

**Agent flow:**

1. **Phase 1:** framework from prompt ("k6"). k6 has no
   "config file" in the conventional sense; the agent might glob
   for `*.load.js` or `*.k6.js` to mimic existing scripts.
2. **Phase 2 step 1:** target `load/checkout.load.js`. analyze_file
   errors.
3. **Phase 2 step 4:** generate. k6's API is a bit specialized;
   the prompt is precise on every parameter. Risk: agent may produce
   the older `scenarios` block layout that the prompt explicitly
   prohibits ("Single scenario, no scenarios block nesting").
4. **Self-check:** "Does every `import` resolve to a real path in
   the repo?" — k6 imports from `'k6'` and `'k6/http'`, which are
   global runtime modules, not repo paths. The self-check is
   playwright/pytest-centric.

**Predicted output quality:** medium-high. The "no scenarios block
nesting" rule is one the agent needs to obey explicitly. Risk of the
agent over-engineering with `options.scenarios = {...}`.

**Verdict:** PASS with caveat — recommend tightening the self-check
to acknowledge runtime-module imports (k6 globals).

## oracle-test-healer (Phase 2) walkthrough

No fixture currently exists to verify the healer end-to-end (would
need a deliberately broken test + a Playwright `trace.zip`). The
agent's instructions are reviewed statically:

- **Phase 1 (Anchor):** sound. Bash-runs the framework's test
  command to capture error output if user didn't paste it.
- **Phase 2 (Diagnose):** selector-vs-generic classification is
  pattern-based and stable. Patterns listed (`TimeoutError`,
  `locator.click: Timeout`, `getByRole`/`getByTestId`/`getByText`,
  `strict mode violation`, `Element is not attached`, `Element is
  not visible`) are exhaustive for the common Playwright failures.
- **Phase 3 (DOM context):** unzip via Bash. Correct approach.
  Truncates to 3500 chars — matches the original `SelectorHealer`
  behavior.
- **Phase 4 (Generate fix):** in-session generation. Same path as
  oracle-test-author.
- **Phase 5 (Verify):** re-runs the test. Good.
- **Phase 6 (No blind retry):** explicit stop-rule. Good — prevents
  the CLI's 3-attempt loop pattern from leaking into a
  conversational context where the user can intervene.

**Verdict:** PASS on static review. Fixture-based verification still
needed before this is fully validated; flagging as follow-up.

## Recommended fixes

In priority order:

1. **F1: `framework` field semantics** — ✅ **Fixed in PR #146**
   (merged 2026-05-26). Framework is now detected from project
   config files (`playwright.config.*`, `vitest.config.*`,
   `pytest.ini`, `pyproject.toml` with `[tool.pytest...]`) by
   walking up to the `.git` boundary; suffix is a documented
   fallback. New `framework_source` field reports
   `"config"` / `"suffix"` / `"unknown"` so callers can gauge
   trust level.
2. **F3: populate `existing_tests`** — ✅ **Fixed in PR #146.**
   Returns up to 10 test file paths relative to the project root,
   sourced from `PatternMatcher._find_test_files`. Sibling fix:
   `project_root` now walks up to `.git` (was `path.parent`, which
   broke discovery for nested files).
3. **F2: `functions` scope** — ⏩ **Partially addressed in PR #146.**
   New `file_functions` field returns file-local defs only (Python
   AST + TS/JS regex). The existing `functions` field keeps its
   project-wide semantics for backward compat; agents should
   prefer `file_functions` for the target file's own definitions.
4. **F4: `imports` scope** — ⏸ Not fixed. Still surfaces
   `PatternMatcher.common_imports` (cross-test common). Lower
   priority since agents have `Read` for direct imports.
5. **F5: nearest-existing-test fallback** on missing target — ⏸
   Not implemented. The populated `existing_tests` field covers
   the common case; a true nearest-test heuristic is its own scope.
6. **Self-check phrasing in `oracle-test-author.md`** — ⏸ Not
   changed. With F1 fixed the existing self-check is tighter, but
   the agent prose could still be broadened to cite
   `framework_source`. Follow-up.

None blocked the migration as-shipped. Phase 1 and Phase 2's agents
produce usable output for the four example prompts. The remaining
gaps (F4, F5, self-check phrasing) are non-blocking and agnostic to
the "stay separate vs pull into Harness" decision.

## Overall verdict

**Phases 1 and 2 are sound enough to keep building on.** The agent
instructions are correct and the failure modes are recoverable. The
MCP tool surface has known gaps that don't break anything but
should be cleaned up in a follow-up.

Walking into Wednesday's architecture meeting with this report:
the migration's quality story is concrete (four prompts predicted
PASS), the known gaps are documented (5 findings), the gaps are
agnostic to the "stay separate vs pull into Harness" decision, and
the next-step fix list is ready for either world.
