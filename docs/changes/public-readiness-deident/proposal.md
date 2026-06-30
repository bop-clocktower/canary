# Public-Readiness De-Identification

**Status:** draft (design sign-off pending)
**Type:** de-identification + hygiene — small/medium change; touches
production code (config loader), docs, and metadata
**Keywords:** de-identification, company-knowledge, config-schema-rename,
git-history, mailmap, filter-repo, public-readiness, unknown-key-warning

## Overview and goals

`bop-clocktower/canary` is public, but its surface still carries downstream-client
(Optum) identifiers and a few launch-hygiene gaps that make it read as a
client-coupled tool rather than the generic test-automation engine it is. This
change removes the employer/client identifiers from the public surface and closes
the hygiene gaps in one coherent pass — without re-leaking the client name and
without running an irreversible git operation unattended.

Tracked as Issue #248.

Out of scope (YAGNI): the `company.json` validation/secret-detection engine is
unchanged; the config schema is not redesigned; coordinating downstream Optum
repos' `company.json` updates is a separate team task; the git-history rewrite is
documented as a runbook but **not executed** by this change.

## Decisions made

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | Hard-rename `optum_dashboard_url` / `optum_dashboard_token_env` → `dashboard_url` / `dashboard_token_env` across all references | A backward-compat alias would keep `optum_*` in public source, re-leaking the identifier. `otel_exporter_endpoint` is already generic and untouched. |
| D2 | Add a generic unknown-key warning to the config loader | Closes the silent-breakage the rename creates for stale downstream configs, echoing the *user's* key string — never naming "optum". |
| D3 | Git history (repo is already public): the employer email is removed **only** by a precise **human-run** `filter-repo` runbook using a local, uncommitted mapping; **no `.mailmap` is committed** | A committed `.mailmap` must list the employer email to map it — re-publishing the very value we are removing. The rewrite is the only real removal; it is best-effort (forks/caches persist) and irreversible, so it stays a deliberate manual op, not an autopilot step. |
| D4 | Genericize the `OPTUM_UAT_TOKEN` example in the company-knowledge guide | Last literal client token in docs/tests; test *values* are already generic. |
| D5 | Land the four polish items in the same PR (Approach 1) | All are low-risk launch hygiene; isolating them in a second PR buys nothing. |

## Technical design

### D1 — Field rename (`company_knowledge.py`, `cli.py`, tests, guide)

Rename `optum_dashboard_url` → `dashboard_url` and `optum_dashboard_token_env`
→ `dashboard_token_env` in every site:

- `agent/core/company_knowledge.py`: module docstring (lines ~17-18), `_Layer`
  (139-140), `_parse_layer` (183-196), `_merge_layers` (268-303), `CompanyKnowledge`
  dataclass (321-322), `is_empty` (338), `to_dict` (455-456).
- `agent/cli.py`: the `canary company` output (1143-1144).
- `tests/unit/test_company_knowledge.py`: rename the test methods and the JSON
  keys they assert (159-165, 358-367). Test *values* (`ACME_DASHBOARD_TOKEN`,
  `dashboard.example.com`) are already generic.
- `docs/guides/company-knowledge.md`: field references (47, 99).

`otel_exporter_endpoint` is left as-is (already generic).

### D2 — Unknown-key warning (`_parse_layer`)

Introduce a `_KNOWN_KEYS` set of the recognized top-level keys. After parsing,
emit one warning per unrecognized key:

```python
for k in set(data) - _KNOWN_KEYS:
    warns.append(f"ignored unknown field: {k}")
```

The warned string is the user's own key, so a stale `optum_dashboard_url` config
self-diagnoses without our source ever naming "optum". Add a unit test asserting
the warning fires for an unknown key and not for known ones.

### D3 — History-scrub runbook (no committed `.mailmap`)

A committed `.mailmap` would have to contain the employer email to map it,
re-publishing the value we are removing — so it is **not** used. Instead, new
`docs/runbooks/scrub-committer-email.md` documents the exact procedure:

- Set the going-forward `git config user.email` to the canonical identity.
- Pre-flight: merge/close open PRs, notify fork owners, snapshot tags.
- Rewrite with `git filter-repo` using a **local, uncommitted** mailmap file (or
  `--email-callback`) mapping `employer@email` → canonical.
- Force-push `main` + tags; request a GitHub-support cache purge.

**Explicitly human-executed, not autopilot.** Caveat documented: forks/caches
retain the old email regardless, so removal is best-effort on the canonical repo
only. **Nothing containing the employer email is committed by this change.**

### D4 — Token genericization

`docs/guides/company-knowledge.md:179`: replace `OPTUM_UAT_TOKEN` with a generic
placeholder (e.g. `DASHBOARD_API_TOKEN`).

### D5 — Polish

- `pyproject.toml`: add `license = { text = "MIT" }` and
  `authors = [{ name = "<canonical>" }]` (canonical personal identity; LICENSE is
  already MIT).
- `README.md`: version badge `4.0.0` → `5.5.1` (match `pyproject`); reconcile the
  install commands (`canary-test-cli`) with the published package name
  (`canary-test-ai`).
- `docs/plans/oracle-plugin.md`: genericize the four hardcoded
  `/Users/bs/Github/canary-test-ai-agent/...` paths (lines 683, 733, 1071, 1215)
  to relative or placeholder paths.
- **Audit-then-act** on `docs/CANARY_STATE.md`, `docs/CANARY_LEARNINGS.md`,
  `docs/SECURITY_LEDGER.md`: grep for hook/tooling references first (the pre-commit
  "refreshing security ledger" hook writes one of these); relocate or `.gitignore`
  **only if** no tooling depends on the published location.

## Integration points

- **Entry Points:** the `.canary/company.json` scalar schema (`dashboard_*` keys);
  the `canary company` CLI output; the "COMPANY KNOWLEDGE" prompt block. New file:
  `docs/runbooks/scrub-committer-email.md`.
- **Registrations Required:** None. (The downstream overlay's `dashboard-sink`
  skill consumes these keys — out-of-scope coordination, noted for the team.)
- **Documentation Updates:** `docs/guides/company-knowledge.md` (field names,
  token, unknown-key behavior); `README.md` (version badge + install name).
- **Architectural Decisions:** None rise to a standalone ADR — a small-tier
  public-facing rename plus an ops runbook; rationale lives in the Decisions table.
- **Knowledge Impact:** record one convention — *public code carries no client
  identifiers; `company.json` scalar fields are generic by contract.*

## Success criteria

1. `grep -ri optum` over tracked `agent/`, `tests/`, and `docs/guides/` returns
   zero hits (excluding the de-id change-docs `docs/changes/public-readiness-deident/`
   and `docs/runbooks/`, which legitimately name the old field to describe its removal).
2. A `company.json` with `dashboard_url` / `dashboard_token_env` loads correctly;
   a stale `optum_*` key is ignored **and** emits `ignored unknown field: optum_dashboard_url`.
3. The full test suite passes; new tests cover the renamed fields and the
   unknown-key warning.
4. `pyproject.toml` declares `license` (MIT) and `authors` (canonical); the README
   version badge matches the `pyproject` version; the install name is reconciled.
5. No `/Users/...` absolute paths remain under `docs/`, excluding
   `docs/changes/public-readiness-deident/` (which cites the bad path as the
   thing being fixed).
6. No committed file contains the employer email; `docs/runbooks/scrub-committer-email.md`
   documents the `filter-repo` procedure (and the PR does not execute it).
7. `harness validate` passes and markdownlint is clean.

EARS behaviors:

- When a `company.json` contains an unrecognized scalar key, the loader shall emit
  a warning naming that key.
- If a config sets a removed key (e.g. a pre-rename `optum_*` key), then the loader
  shall not treat it as a dashboard field.

## Implementation order

1. Core rename + unknown-key warning + tests (`company_knowledge.py`, `cli.py`,
   `test_company_knowledge.py`).
2. Docs de-identification (guide field names + token).
3. Polish (`pyproject.toml`, `README.md`, hardcoded paths, internal-docs audit).
4. `docs/runbooks/scrub-committer-email.md` (no committed `.mailmap`).
5. *(Post-merge, human-executed)* run the history-scrub runbook.
