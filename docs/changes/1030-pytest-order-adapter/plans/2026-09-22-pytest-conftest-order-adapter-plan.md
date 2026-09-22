# Plan: pytest conftest order adapter (#1030)

**Date:** 2026-09-22 | **Spec:** [../proposal.md](../proposal.md) | **Tasks:** 4
| **Time:** ~16 min | **Integration Tier:** medium | **Rigor:** standard

## Goal

A pytest consumer can apply a `canary order` plan by copying one documented
`conftest.py` snippet out of `docs/guides/order.md`, and that snippet's
behaviour is executed by a vitest test rather than asserted in prose.

## Observable truths (acceptance criteria)

1. The system shall expose exactly one ` ```python ` fenced block under a
   "Applying a plan in pytest" heading in `docs/guides/order.md`.
2. When `python3 -m py_compile` is available, the extracted snippet shall
   compile without error.
3. When pytest is available, an ordered run and an unordered run of the same
   throwaway suite shall report the same collected test count.
4. When pytest is available and `CANARY_ORDER_PLAN` names files, the system
   shall run those files in plan order, and files absent from the plan last in
   their original collection order.
5. If `CANARY_ORDER_PLAN` is unset or unreadable, then the system shall not
   change the order or the count, and the run shall still exit 0.
6. While pytest is unavailable, the test shall print the reason it skipped the
   pytest-executing assertions; where `CANARY_REQUIRE_PYTEST=1` is set, it shall
   fail instead of skipping.
7. `docs/guides/order.md` shall no longer claim "pytest and Playwright have no
   adapter yet" unqualified (line 53 today).
8. From `ts/`: `npm run build`, `npm run typecheck`, `npm run format:check`,
   `npm test` all pass. `npx prettier --check` and `npx markdownlint-cli2` pass
   on the changed docs.

## Uncertainties

- [ASSUMPTION] pytest 9.1.1 is present locally (verified:
  `python3 -m pytest --version` → `pytest 9.1.1`), and canary CI has no Python —
  so truths 3-5 will be reported as skipped-with-reason in CI. If CI turns out
  to have python3, nothing breaks; the gate just runs.
- [ASSUMPTION] `ts/test/*.test.ts` files are not currently listed in
  `entropy.entryPoints` (only `*-testkit.ts` helpers are, at lines 287-288 and
  420-421). Task 3 declares the new file anyway per the standing ratchet rule
  and verifies by running the entropy gate; if the gate is clean either way the
  declaration is harmless and keeps the two arrays honest.
- [DEFERRABLE] Exact stderr wording of the snippet's "unreadable plan" line.
- [NOT A RISK] Delivery form is settled (D1): documented snippet, no Python file
  committed, no policy exception.

## File map

- CREATE `ts/test/order-pytest-conftest.test.ts`
- MODIFY `docs/guides/order.md` (add "Applying a plan in pytest" section; fix
  the stale no-adapter sentence; add the new section to the Source list if the
  vitest one is listed there)
- MODIFY `harness.config.json` (two `entropy.entryPoints` arrays, ~line 175 and
  ~line 308)

Do **not** touch `.codex/config.toml`, `.codex/hooks.json`, or
`CANARY_ARCHITECTURE_DIAGRAM.md` — pre-existing uncommitted files owned by
another session.

## Skeleton

_Not produced — 4 tasks, below the standard-mode threshold of 8._

## Tasks

### Task 1: Write the vitest test against the doc section that does not exist (red)

**Depends on:** none | **Files:** `ts/test/order-pytest-conftest.test.ts`

1. Create `ts/test/order-pytest-conftest.test.ts` with, in order:
   - A module-level helper `extractSnippet()` that reads `docs/guides/order.md`
     (resolved from `import.meta.url`, repo-root relative), finds the
     `## Applying a plan in pytest` section, and returns the single
     ` ```python ` fenced block's body. It throws if the count of matching
     blocks is not exactly 1.
   - A module-level probe `pytestAvailable()` that runs
     `spawnSync('python3', ['-m', 'pytest', '--version'])` and returns
     `{ ok, reason }`. When `!ok`:
     - if `process.env.CANARY_REQUIRE_PYTEST === '1'`, the suite must **fail**
       with the reason;
     - otherwise call `console.warn()` with a message that starts
       `SKIPPED: pytest-executing assertions did not run —`, names the
       `<reason>`, and ends
       `Set CANARY_REQUIRE_PYTEST=1 to make this a failure.`; then use
       `describe.skip`. Never skip silently and never report a zero denominator
       as a pass.
   - Always-on test: "the doc contains exactly one pytest conftest snippet" —
     asserts `extractSnippet()` does not throw and the body contains
     `pytest_collection_modifyitems`.
   - python3-gated test: `python3 -m py_compile` on the snippet written to a
     temp file exits 0.
   - pytest-gated tests (one `describe`, shared `beforeAll` that builds the
     throwaway suite):
     - `beforeAll` uses `mkdtempSync(join(tmpdir(), 'canary-order-pytest-'))`
       and writes `conftest.py` (the extracted snippet), plus `test_a.py`,
       `test_b.py`, `test_c.py`, each with 1-2 trivial
       `def test_*(): assert True`. `afterAll` removes the dir with
       `rmSync(dir, { recursive: true, force: true })`.
     - "no test lost": run `python3 -m pytest -q` with and without
       `CANARY_ORDER_PLAN` and assert the collected count is identical.
     - "plan order is honoured": a plan naming `test_c.py` then `test_a.py`;
       assert the `-v` node-id order lists `test_c` before `test_a`.
     - "unknown files run last, in collection order": with the same plan, assert
       `test_b` (unnamed) comes after both ranked files.
     - "an unreadable plan changes nothing": `CANARY_ORDER_PLAN` pointing at a
       file containing `not json`; assert exit code 0 and the same count and
       order as the unordered run.
   - Every `spawnSync` for pytest passes `cwd: dir` and
     `env: { ...process.env, CANARY_ORDER_PLAN: ... }`.
2. Run: `cd ts && npx vitest run test/order-pytest-conftest.test.ts`
3. **Observe failure** — the doc has no pytest section, so `extractSnippet()`
   throws and every test fails. Record the failure output; this is the red step.
4. Do not commit yet (red must not land alone). Proceed to Task 2.

### Task 2: Write the doc's pytest section containing the snippet (green)

**Depends on:** Task 1 | **Files:** `docs/guides/order.md`

1. Insert a `## Applying a plan in pytest` section immediately after the
   existing `## Applying a plan in vitest` section (after current line 54).
2. The section contains exactly one ` ```python ` fenced block — a
   self-contained `conftest.py`, standard library only (`json`, `os`, `pathlib`,
   `subprocess`, `sys`), no canary import, implementing D2-D5:
   - `_plan_rank(plan_path)` parses the plan, returns `{test_file: index}` or
     `None` on any failure (missing `entries`, non-string `test_file`, bad JSON,
     unreadable file) after writing one line to `sys.stderr`.
   - `pytest_collection_modifyitems(config, items)` returns immediately when
     `CANARY_ORDER_PLAN` is unset or `_plan_rank` returned `None`, otherwise
     does `items.sort(key=lambda ...)` with key `(rank, original_index)` and
     `rank = float('inf')` for unnamed files. Sort in place — a permutation, so
     the collected set cannot change.
   - Repo root from `git rev-parse --show-toplevel`, falling back to
     `config.rootpath`; paths normalized to POSIX separators (D4, ADR 0029).
3. Add a ` ```bash ` block showing
   `CANARY_ORDER_PLAN=plan.json python3 -m pytest`, and prose stating: no file
   is dropped; unnamed files run last; an unreadable plan degrades to pytest's
   own order; the snippet is copied into the consumer's repo (canary ships no
   Python package — D1).
4. Fix the stale sentence at line 53: "pytest and Playwright have no adapter
   yet" → vitest has a sequencer, pytest has the conftest snippet below,
   Playwright has no adapter yet.
5. Every fenced block in the new content must carry a language tag.
6. Run from the repo root: `npx prettier --write docs/guides/order.md` then
   `npx markdownlint-cli2 docs/guides/order.md`. Both must be clean (prettier
   clean is not markdownlint clean — run both).
7. Run: `cd ts && npx vitest run test/order-pytest-conftest.test.ts` — **observe
   pass**, including the pytest-executing assertions (pytest 9.1.1 is present
   locally). If they report as skipped locally, that is a red flag: re-check the
   probe, do not accept it.
8. Commit:
   `feat(order): document a pytest conftest adapter and execute it from the doc`

### Task 3: Declare the new test file in both entropy entryPoints arrays

**Depends on:** Task 2 | **Files:** `harness.config.json` | **Category:**
integration

1. Add `"ts/test/order-pytest-conftest.test.ts"` to the `entropy.entryPoints`
   array near line 175 **and** to the second array near line 308. The two arrays
   must stay in sync — an edit to one only is the known failure mode.
2. Never raise `entropy.maxFindings`.
3. Run from the repo root: `npx harness check-entropy` (or the repo's entropy
   script) and confirm the finding count did not rise above the committed
   ceiling. If the count is unchanged with and without the declaration, keep the
   declaration and say so in the PR body.
4. Run: `npx prettier --write harness.config.json`
5. Commit: `chore(entropy): declare the pytest conftest test as an entry point`

### Task 4: Four gates and honest-denominator evidence for the PR

**Depends on:** Task 3 | **Files:** none (verification only)
**[checkpoint:human-verify]**

1. From `ts/` (not the repo root — there is no `lint` script here):
   - `npm run build`
   - `npm run typecheck`
   - `npm run format:check`
   - `npm test` Run each as its own command; a silent result means it did not
     run. Never read `$?` after a pipe.
2. Capture the denominator evidence for the PR body:
   - `cd ts && CANARY_REQUIRE_PYTEST=1 npx vitest run test/order-pytest-conftest.test.ts`
     — must pass locally, proving the pytest assertions really execute rather
     than skipping.
   - Record the local `pytest --version` (9.1.1) and state plainly in the PR
     that canary CI has no Python, so truths 3-5 are reported skipped there with
     a printed reason.
3. Record decision **D1** (documented snippet; no Python package; no policy
   exception) in the PR body, per success criterion 5.
4. Run: `npx harness validate` from the repo root.
5. Pause and show the human: the four gate results, the
   `CANARY_REQUIRE_PYTEST=1` output, and the rendered doc section. Wait for
   confirmation before opening the PR.

## Traceability

| Observable truth | Delivered by                                                |
| ---------------- | ----------------------------------------------------------- |
| 1, 2             | Task 1 (test), Task 2 (doc)                                 |
| 3, 4, 5          | Task 1 (test), Task 2 (snippet)                             |
| 6                | Task 1 (probe + `CANARY_REQUIRE_PYTEST`), Task 4 (evidence) |
| 7                | Task 2 step 4                                               |
| 8                | Task 2 step 6, Task 3, Task 4                               |

## Constraints held

- TDD: red in Task 1, green in Task 2. No task defers its test.
- No Python file is committed. The snippet lives only in the doc; the executed
  copy is extracted at test time into an OS temp dir.
- Gates run from `ts/`; there is no `lint` script.
- Never `--no-verify`; never a bare `-n` on a `git commit` line.
- `.codex/config.toml`, `.codex/hooks.json`, `CANARY_ARCHITECTURE_DIAGRAM.md`
  are left untouched.
