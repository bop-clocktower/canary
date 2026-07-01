# Plan: Public-Readiness De-Identification (Phase 0)

**Date:** 2026-06-30 | **Tasks:** 15 | **Time:** ~58 min | **Integration
Tier:** medium
**Spec:** `docs/changes/public-readiness-deident/proposal.md`

## Goal

Remove downstream-client (client) identifiers from the public surface of
`bop-clocktower/canary` and close launch-hygiene gaps, without re-leaking the
client name and without executing any irreversible git-history operation.

## Scope Note

This plan covers the spec's Implementation Order **steps 1–4**. Step 5 (the
`git filter-repo` history rewrite + force-push) is a **human-only runbook
execution and is explicitly OUT OF SCOPE**. No task in this plan runs
`git filter-repo`, edits `.mailmap`, or force-pushes. Task 13 only *writes* the
runbook document; it does not run it.

## Observable Truths (Acceptance Criteria)

Traceable to the spec's 7 success criteria (SC) and EARS behaviors:

1. **(SC#1)** `grep -ri client` over tracked `agent/`, `tests/`, and
   `docs/guides/` returns **zero** hits. (Baseline before change: 43 hits across
   4 files.) — delivered by Tasks 2, 4, 5, 6, 9.
2. **(SC#2, EARS)** When a `company.json` contains an unrecognized scalar key,
   the loader shall emit `ignored unknown field: <key>`; if a config sets a
   removed key (e.g. `client_dashboard_url`), the loader shall not treat it as a
   dashboard field. — delivered by Tasks 3, 4.
3. **(SC#3)** The full unit suite passes; new/updated tests cover the renamed
   fields and the unknown-key warning. — delivered by Tasks 1, 3, 7.
4. **(SC#4)** `pyproject.toml` declares `license = {text="MIT"}` and `authors`;
   the README version badge reads `5.5.1` (matches pyproject); the install name
   is reconciled. — delivered by Tasks 8, 10, 11.
5. **(SC#5)** No `/Users/...` absolute paths remain under `docs/` (excluding
   `docs/changes/public-readiness-deident/`). — delivered by Task 12.
6. **(SC#6)** No committed file contains the employer email;
   `docs/runbooks/scrub-committer-email.md` documents the `filter-repo`
   procedure and the PR does not execute it. — delivered by Task 13.
7. **(SC#7)** `harness validate` passes and markdownlint is clean on changed
   markdown. — delivered by every task's validate step + Task 14.

## Uncertainties

- **[RESOLVED — was ASSUMPTION]** Whether `docs/CANARY_STATE.md`,
  `docs/CANARY_LEARNINGS.md`, `docs/SECURITY_LEDGER.md` can be relocated/
  gitignored. Audit (grep across repo) shows all three are **actively
  referenced by tooling**: `.githooks/pre-commit` and `scripts/security_ledger.py`
  write `docs/SECURITY_LEDGER.md` (gated by `.github/workflows/harness-security.yml`
  and `harness-quality.yml`); `AGENTS.md` and four `canary-*` skills reference
  `CANARY_STATE.md`/`CANARY_LEARNINGS.md`; `scripts/check_removed_symbols.py`
  allowlists both. **Decision: leave all three in place, do NOT relocate or
  gitignore.** Task 12 records this audit result; no move task is created.
- **[ASSUMPTION → checkpoint:decision in Task 11]** README `canary-test-cli`
  (npm/volta) vs `canary-test-ai` (PyPI/pyproject). These may be two distinct
  registries (npm package vs Python package), not a typo. The reconciliation
  direction is confirmed with the human at a `[checkpoint:decision]` before the
  README edit, since guessing wrong could point users at a nonexistent package.
- **[DEFERRABLE]** Exact `authors` name string in `pyproject.toml` — the spec
  says "canonical personal identity". Confirmed via `[checkpoint:human-verify]`
  in Task 8 to avoid re-introducing the very identifier being scrubbed.

## Change Specification (delta)

- **[MODIFIED]** Config scalar keys `client_dashboard_url` → `dashboard_url`,
  `client_dashboard_token_env` → `dashboard_token_env` (dataclass fields, parse,
  merge, serialize, CLI output, docs). `otel_exporter_endpoint` unchanged.
- **[ADDED]** `_KNOWN_KEYS` set + unknown-key warning in `_parse_layer`.
- **[MODIFIED]** `docs/guides/company-knowledge.md` field names + `CLIENT_UAT_TOKEN`
  example.
- **[ADDED]** `pyproject.toml` `license`/`authors`; `docs/runbooks/scrub-committer-email.md`.
- **[MODIFIED]** README version badge + install name; four hardcoded paths in
  `docs/plans/oracle-plugin.md`.

## File Map

- MODIFY `tests/unit/test_company_knowledge.py` (rename fields in tests 159-165,
  358-367; add unknown-key-warning test)
- MODIFY `agent/core/company_knowledge.py` (docstring 17-18, `_Layer` 139-140,
  `_parse_layer` 183-196 + `_KNOWN_KEYS`, `_merge_layers` 268-303, dataclass
  321-322, `is_empty` 338, `to_dict` 455-456)
- MODIFY `agent/cli.py` (1143-1144)
- MODIFY `docs/guides/company-knowledge.md` (47, 99, 179)
- MODIFY `pyproject.toml` (add `license`, `authors`)
- MODIFY `README.md` (version badge line 3; install lines 27, 39, 41)
- MODIFY `docs/plans/oracle-plugin.md` (683, 733, 1071, 1215)
- CREATE `docs/runbooks/scrub-committer-email.md`
- (AUDIT-ONLY, no edit) `docs/CANARY_STATE.md`, `docs/CANARY_LEARNINGS.md`,
  `docs/SECURITY_LEDGER.md`

## Skeleton

Task count 15 (>= 8) at `standard` rigor, so a skeleton was produced:

1. Core rename + unknown-key warning + tests (~7 tasks, ~28 min)
2. Docs de-identification — guide (~2 tasks, ~7 min)
3. Polish — metadata, README, paths, audit (~4 tasks, ~16 min)
4. Runbook + final verification (~2 tasks, ~7 min)

**Estimated total:** 15 tasks, ~58 minutes.
*Skeleton approved: pending (see sign-off request at end of session).*

## Skills

No specific skill recommendations (advisor scanned 758 skills, 0 matched with
signal). Project convention (TDD) is applied inline. No per-task annotations.

---

## Tasks

### Task 1: Rename fields in existing tests (RED) — TDD anchor

**Depends on:** none | **Files:** `tests/unit/test_company_knowledge.py`

This is the TDD RED step: update the tests to the new field names *first*, so
they fail against the un-renamed source, then Task 2 makes them pass.

1. In `tests/unit/test_company_knowledge.py`, rename the two token-env tests
   (lines ~159-165):
   - `test_client_dashboard_token_env_accepted` → `test_dashboard_token_env_accepted`
   - `test_client_dashboard_token_env_lowercase_dropped` →
     `test_dashboard_token_env_lowercase_dropped`
   - Inside each, change the JSON key `"client_dashboard_token_env"` →
     `"dashboard_token_env"` and the attribute `ck.client_dashboard_token_env` →
     `ck.dashboard_token_env`. Keep the value `"ACME_DASHBOARD_TOKEN"` (already
     generic).
2. Rename the merge test (lines ~358-367):
   - `test_client_dashboard_url_replaced_by_env_layer` →
     `test_dashboard_url_replaced_by_env_layer`
   - Change both JSON keys `"client_dashboard_url"` → `"dashboard_url"` and the
     attribute `ck.client_dashboard_url` → `ck.dashboard_url`. Keep the
     `dashboard.example.com` values.
3. Run: `python -m pytest tests/unit/test_company_knowledge.py -k "dashboard" -q`
   — observe **failures** (AttributeError / KeyError: the source still uses
   `client_*`). This confirms the RED state.
4. Do NOT commit yet — commit lands with the source rename in Task 2.

### Task 2: Rename fields across `company_knowledge.py` (GREEN)

**Depends on:** Task 1 | **Files:** `agent/core/company_knowledge.py`

Replace every `client_dashboard_url` → `dashboard_url` and
`client_dashboard_token_env` → `dashboard_token_env`. `otel_exporter_endpoint`
stays untouched. Exact sites:

1. **Module docstring (lines ~17-18):** change
   `scalar fields (client_dashboard_url, client_dashboard_token_env, notes)` →
   `scalar fields (dashboard_url, dashboard_token_env, notes)`.
2. **`_Layer` dataclass (139-140):** rename both fields:

   ```python
       dashboard_url: str = ""
       dashboard_token_env: str = ""
   ```

3. **`_parse_layer` (183-196):** rename local vars, dict keys, and the
   `_SecretDetected` / warning field-name strings:

   ```python
       dashboard_url = ""
       if "dashboard_url" in data:
           dashboard_url = _validate_url(data["dashboard_url"], "dashboard_url", warns)

       dashboard_token_env = ""
       if "dashboard_token_env" in data:
           raw_env = data["dashboard_token_env"]
           if isinstance(raw_env, str):
               if _looks_like_secret(raw_env):
                   raise _SecretDetected("dashboard_token_env", raw_env)
               if _ENV_VAR_RE.match(raw_env):
                   dashboard_token_env = raw_env
               else:
                   warns.append(f"dashboard_token_env: dropped invalid env-var name {raw_env!r}")
   ```

4. **`_parse_layer` return (217-218):** `dashboard_url=dashboard_url,` and
   `dashboard_token_env=dashboard_token_env,`.
5. **`_merge_layers` (268-303):** rename the two local accumulators, the two
   `if layer.<field>:` guards, and the two `dict(...)` keys:

   ```python
       dashboard_url = ""
       dashboard_token_env = ""
   ...
           if layer.dashboard_url:
               dashboard_url = layer.dashboard_url
           if layer.dashboard_token_env:
               dashboard_token_env = layer.dashboard_token_env
   ...
           dashboard_url=dashboard_url,
           dashboard_token_env=dashboard_token_env,
   ```

6. **`CompanyKnowledge` dataclass (321-322):** rename both fields.
7. **`is_empty` (338):** `self.dashboard_url,`.
8. **`to_dict` (455-456):** rename both dict keys:

   ```python
           "dashboard_url": self.dashboard_url,
           "dashboard_token_env": self.dashboard_token_env,
   ```

9. Run: `python -m pytest tests/unit/test_company_knowledge.py -q` — observe
   **all pass** (Task 1 tests now GREEN).
10. Verify no leftover in source:
    `grep -n client agent/core/company_knowledge.py` → zero hits.
11. Run: `harness validate`
12. Commit: `refactor(company-knowledge): rename client_dashboard_* fields to
    dashboard_*`

### Task 3: Add unknown-key-warning test (RED)

**Depends on:** Task 2 | **Files:** `tests/unit/test_company_knowledge.py`

TDD RED for D2. Note an existing `test_unknown_keys_tolerated` (line ~167)
asserts unknown keys don't break loading — that must still pass. Add a *new*
test asserting the warning fires.

1. Add near the existing unknown-key test:

   ```python
   def test_unknown_key_emits_warning(self):
       ck = self._load({"client_dashboard_url": "https://x.example.com"})
       self.assertTrue(
           any("ignored unknown field: client_dashboard_url" in w for w in ck.warnings)
       )
       # a removed key must NOT populate a dashboard field
       self.assertEqual(ck.dashboard_url, "")

   def test_known_keys_emit_no_unknown_warning(self):
       ck = self._load({"confluence_spaces": ["QA"], "dashboard_url": "https://x.example.com"})
       self.assertFalse(
           any("ignored unknown field" in w for w in ck.warnings)
       )
   ```

2. Run: `python -m pytest tests/unit/test_company_knowledge.py -k "unknown" -q`
   — observe `test_unknown_key_emits_warning` **fails** (no warning yet) and
   `test_known_keys_emit_no_unknown_warning` passes.
3. Do NOT commit yet — lands with Task 4.

### Task 4: Add `_KNOWN_KEYS` + unknown-key warning to `_parse_layer` (GREEN)

**Depends on:** Task 3 | **Files:** `agent/core/company_knowledge.py`

1. Define `_KNOWN_KEYS` near the top-level constants (before `_parse_layer`).
   It must list **every** recognized top-level key so valid configs never warn:

   ```python
   _KNOWN_KEYS = {
       "confluence_spaces",
       "jira_projects",
       "internal_doc_urls",
       "internal_domains",
       "mcp_servers",
       "claude_code_skills",
       "dashboard_url",
       "dashboard_token_env",
       "otel_exporter_endpoint",
       "notes",
   }
   ```

2. In `_parse_layer`, immediately before the `return _Layer(...)` (after `notes`
   is computed, ~line 209), append the generic warning loop:

   ```python
       for k in sorted(set(data) - _KNOWN_KEYS):
           warns.append(f"ignored unknown field: {k}")
   ```

   (`sorted` gives deterministic warning order for tests.)
3. Run: `python -m pytest tests/unit/test_company_knowledge.py -q` — observe
   **all pass**, including both new tests and existing `test_unknown_keys_tolerated`.
4. Run: `harness validate`
5. Commit: `feat(company-knowledge): warn on unrecognized company.json keys`

### Task 5: Rename dashboard field in CLI output

**Depends on:** Task 2 | **Files:** `agent/cli.py`

1. At lines 1143-1144, change the attribute reference:

   ```python
       if ck.dashboard_url:
           print(f"[bold]Dashboard URL:[/bold]     {ck.dashboard_url}")
   ```

   (The display label "Dashboard URL" is already generic — only the attribute
   name changes.)
2. Verify: `grep -n client agent/cli.py` → zero hits.
3. Run: `harness validate`
4. Commit: `refactor(cli): use renamed dashboard_url field in company output`

### Task 6: Rename dashboard field references in the guide

**Depends on:** Task 2 | **Files:** `docs/guides/company-knowledge.md`

1. Line ~47-48, scalar-fields sentence:
   `**Scalar fields** (\`dashboard_url\`, \`dashboard_token_env\`, \`notes\`)`.
2. Line ~99, secrets example:
   `them by env-var name (e.g. \`"dashboard_token_env": "MY_TOKEN_VAR"\`).`
3. Run: `markdownlint docs/guides/company-knowledge.md` — clean.
4. Run: `harness validate`
5. Commit: `docs(company-knowledge): rename dashboard_* fields in guide`

*(Note: line 179 `CLIENT_UAT_TOKEN` is handled in Task 9, not here.)*

### Task 7: Verify SC#3 — full company-knowledge suite green

**Depends on:** Task 4, Task 5 | **Files:** none (verification)

[checkpoint:human-verify]

1. Run: `python -m pytest tests/unit/test_company_knowledge.py -q` — record the
   pass count; expect all green.
2. Run: `python -m pytest tests/unit -q` — confirm no other unit test broke on
   the rename.
3. Show the human the summary line. Wait for confirmation before proceeding.
4. No commit (verification only).

### Task 8: Add `license` and `authors` to `pyproject.toml`

**Depends on:** none | **Files:** `pyproject.toml`

[checkpoint:human-verify]

1. Present the intended `authors` string to the human FIRST — the spec says
   "canonical personal identity", and this is the de-identification change, so
   the name must be confirmed, not guessed, to avoid re-leaking an identifier.
   Wait for the confirmed name.
2. In the `[project]` block (after `description`, before `requires-python`), add:

   ```toml
   license = { text = "MIT" }
   authors = [{ name = "<confirmed-canonical-name>" }]
   ```

   (LICENSE file is already MIT — this only declares it in metadata.)
3. Run: `python -c "import tomllib; tomllib.load(open('pyproject.toml','rb'))"`
   — parses without error.
4. Run: `harness validate`
5. Commit: `chore(pyproject): declare MIT license and canonical authors`

### Task 9: Genericize the token example in the guide

**Depends on:** Task 6 | **Files:** `docs/guides/company-knowledge.md`

1. Line ~179, replace the per-env override example:

   ```json
     "notes": "Use UAT endpoint for all API calls. Credentials in DASHBOARD_API_TOKEN."
   ```

2. Verify SC#1 scope for the guide:
   `grep -in client docs/guides/company-knowledge.md` → zero hits.
3. Run: `markdownlint docs/guides/company-knowledge.md` — clean.
4. Run: `harness validate`
5. Commit: `docs(company-knowledge): genericize UAT token example`

### Task 10: Fix README version badge

**Depends on:** none | **Files:** `README.md`

1. Line 3, change the badge version `4.0.0` → `5.5.1` (matches
   `pyproject.toml` version):

   ```markdown
   ![version](https://img.shields.io/badge/version-5.5.1-F0C040?style=flat-square&labelColor=0A0A0A&color=F0C040)
   ```

2. Run: `markdownlint README.md` — clean.
3. Run: `harness validate`
4. Commit: `docs(readme): bump version badge to 5.5.1`

### Task 11: Reconcile README install name

**Depends on:** Task 10 | **Files:** `README.md`

[checkpoint:decision]

The README uses `canary-test-cli` (volta line 27, npm line 39, npx line 41)
while `pyproject.toml` publishes the Python package as `canary-test-ai`. These
may be a genuine mismatch OR two distinct registries (npm vs PyPI). Present to
the human:

|            | A) npm package is `canary-test-ai` (rename README cli refs)     | B) npm package is genuinely `canary-test-cli` (leave README as-is; names differ by registry) | C) Verify against the published npm registry first |
| ---------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Pros**   | Single consistent name everywhere                               | No incorrect edit; respects that npm≠PyPI naming                                             | Ground truth before editing                        |
| **Cons**   | Wrong if npm pkg really is `canary-test-cli` → broken install   | README stays "inconsistent" per SC#4 wording                                                 | Extra round-trip / network check                   |
| **Risk**   | Medium (could point users at a nonexistent package)             | Low                                                                                          | Low                                                |
| **Effort** | Low                                                             | Zero                                                                                         | Low                                                |

**Recommendation:** C then apply A or B (confidence: medium) — a wrong install
command is worse than a naming inconsistency; confirm the real npm name before
editing.

1. Await the human's choice.
2. Apply the chosen edit to lines 27, 39, 41 (or leave unchanged for B).
3. Run: `markdownlint README.md` — clean.
4. Run: `harness validate`
5. Commit: `docs(readme): reconcile install package name` (skip commit if B/no-change).

### Task 12: Genericize oracle-plugin paths + record internal-docs audit

**Depends on:** none | **Files:** `docs/plans/oracle-plugin.md`

**Category:** integration (documentation update)

1. Replace the four `/Users/bs/Github/canary-test-ai-agent/...` absolute paths
   with a placeholder rooted var. At lines 683, 733, 1071, 1215 change the
   prefix `/Users/bs/Github/canary-test-ai-agent` → `$PLUGIN_ROOT` (introduce it
   as `PLUGIN_ROOT=~/path/to/canary-plugin` context if the surrounding prose
   needs it), yielding e.g.:

   ```bash
   mkdir -p "$PLUGIN_ROOT/.claude-plugin"
   mkdir -p "$PLUGIN_ROOT/.claude-plugin/agents"
   mkdir -p "$PLUGIN_ROOT/.claude-plugin/schemas"
   cd "$PLUGIN_ROOT"
   ```

2. Verify SC#5:
   `grep -rn "/Users/" docs/ --include=*.md | grep -v "docs/changes/public-readiness-deident/"`
   → zero hits.
3. **Record the internal-docs audit result** (no file move — audit already
   performed during planning): `docs/CANARY_STATE.md`, `docs/CANARY_LEARNINGS.md`,
   and `docs/SECURITY_LEDGER.md` are actively referenced by tooling
   (`.githooks/pre-commit`, `scripts/security_ledger.py`, `.github/workflows/
   harness-security.yml`, `harness-quality.yml`, `AGENTS.md`, and four `canary-*`
   skills). **They stay in their published locations** — relocating or
   gitignoring would break these hooks/workflows. No edit needed; this step
   documents the decision in the commit body.
4. Run: `markdownlint docs/plans/oracle-plugin.md` — clean.
5. Run: `harness validate`
6. Commit: `docs(oracle-plugin): genericize hardcoded local paths`
   (commit body: "internal-docs audit: CANARY_STATE/LEARNINGS/SECURITY_LEDGER
   are tooling-referenced; kept in place, not relocated").

### Task 13: Write the history-scrub runbook (documentation only)

**Depends on:** none | **Files:** `docs/runbooks/scrub-committer-email.md`

**Category:** integration (new documentation, new entry point)

This task ONLY writes the document. It does NOT run `git filter-repo`, does NOT
create or commit any `.mailmap`, and does NOT force-push. The document must
contain **no employer email literal** (per SC#6 and D3).

1. Create `docs/runbooks/scrub-committer-email.md` with these sections:
   - **Title + bold "HUMAN-EXECUTED ONLY — NOT run by autopilot/CI" banner.**
   - **Purpose:** remove the employer committer email from the canonical
     `bop-clocktower/canary` history; note it is best-effort (forks/caches
     persist) and irreversible.
   - **Why no committed `.mailmap`:** a committed mailmap would have to contain
     the employer email to map it, re-publishing the value being removed. The
     mapping file is created **locally and uncommitted**, and deleted after.
   - **Pre-flight checklist:** merge/close all open PRs; notify fork owners;
     snapshot tags (`git tag > /tmp/tags-before.txt`); ensure a full clone.
   - **Set going-forward identity:**
     `git config user.email "<canonical-email>"` (placeholder — filled by the
     human at runtime; do not hardcode any real address).
   - **Rewrite step:** use `git filter-repo` with a **local uncommitted** mailmap
     (`git filter-repo --mailmap /tmp/local.mailmap`) OR `--email-callback`,
     mapping the employer email → canonical. Show the mailmap FORMAT with
     `<PLACEHOLDER_OLD_EMAIL>` / `<CANONICAL_EMAIL>` tokens only — never a real
     employer address.
   - **Publish:** force-push `main` + tags; request a GitHub-support cache purge.
   - **Cleanup:** delete the local mailmap file.
   - **Caveat box:** forks/caches retain the old email; removal is best-effort on
     the canonical repo only.
2. Verify no real employer email leaked: `grep -in "@" docs/runbooks/scrub-committer-email.md`
   — every `@` line must be a placeholder token, not a real address. Confirm
   visually.
3. Run: `markdownlint docs/runbooks/scrub-committer-email.md` — clean.
4. Run: `harness validate`
5. Commit: `docs(runbooks): add human-executed committer-email scrub runbook`

### Task 14: Final acceptance verification (SC#1, SC#5, SC#7)

**Depends on:** Task 4, 5, 6, 9, 12, 13 | **Files:** none (verification)

[checkpoint:human-verify]

1. **SC#1:** `grep -ri client agent/ tests/ docs/guides/` → **zero** hits.
2. **SC#5:** `grep -rn "/Users/" docs/ --include=*.md | grep -v "docs/changes/public-readiness-deident/"`
   → zero hits.
3. **SC#3:** `python -m pytest tests/unit -q` → all green.
4. **SC#7:** `harness validate` → passes; `markdownlint docs/**/*.md README.md`
   → clean (or scoped to changed files if the glob is noisy).
5. Show the human all four results. Wait for confirmation.
6. No commit (verification only).

### Task 15: Commit the plan artifact (paper trail)

**Depends on:** none | **Files:** this plan file

**Category:** integration

1. Confirm this plan file is committed to git history (done at planning time —
   see Phase 4 Step 8). If somehow uncommitted:

   ```bash
   git add docs/changes/public-readiness-deident/plans/2026-06-30-public-readiness-deident-plan.md
   git commit -m "docs(public-readiness-deident): add plan"
   ```

2. Run: `harness validate`

---

## Sequencing Notes

- **RED→GREEN pairs:** Task 1→2 (rename), Task 3→4 (warning). Tests commit with
  their implementation.
- **Parallelizable** (different subsystems, no shared state): Tasks 8, 10, 12,
  13 can run in any order relative to the core-rename chain. Task 5, 6 depend
  only on Task 2. Task 11 depends on Task 10 (same file). Task 9 depends on
  Task 6 (same file).
- **Verification gates:** Task 7 (mid), Task 14 (final) are `human-verify`
  checkpoints. Task 11 is a `decision` checkpoint. Task 8 embeds a
  `human-verify` for the authors name.
- **Out of scope:** history rewrite (spec step 5) — Task 13 only documents it.

## Checkpoints Summary

- `[checkpoint:human-verify]` — Task 7 (suite green), Task 8 (authors name),
  Task 14 (final acceptance).
- `[checkpoint:decision]` — Task 11 (README install-name reconciliation).
