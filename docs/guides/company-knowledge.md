---
project: canary
created: 2026-06-01
---

# Company Knowledge Guide

Canary can ground AI generation in your organisation's internal context —
Confluence spaces, Jira project keys, internal doc URLs, MCP servers, and
Claude Code skills — without committing any proprietary content to a repo.

All this is configured via `.canary/company.json`, which stores **pointers
only**. The actual content is fetched at runtime by the AI agent through your
configured MCP servers or authenticated tooling.

---

## Quick start

```bash
# Interactive setup (recommended)
canary company-knowledge init

# Check what Canary sees
canary company-knowledge show

# Validate that configured MCP servers are registered
canary company-knowledge show --validate-mcp
```

---

## The merge cascade

Canary loads three sources and merges them, lowest to highest priority:

| Priority | File | Purpose |
| --- | --- | --- |
| **1 (lowest)** | `~/.canary/company.json` | Org-wide defaults shared across all your local projects |
| **2** | `.canary/company.json` | Project-local config (committed) |
| **3 (highest)** | `.canary/company.<env>.json` | Environment override (e.g. `company.uat.json`) |

**List fields** (`confluence_spaces`, `jira_projects`, `internal_doc_urls`,
`internal_domains`, `mcp_servers`, `claude_code_skills`) are **unioned** —
each layer adds to the set.

**Scalar fields** (`dashboard_url`, `dashboard_token_env`,
`notes`) are **replaced** by the highest-priority source that sets them.

> **Naming convention (contract):** Public code carries no client/employer
> identifiers. `company.json` scalar fields (`dashboard_url`,
> `dashboard_token_env`, `otel_exporter_endpoint`) are generic by contract —
> never client-named. Client-specific values belong in a project's own
> (uncommitted) `.canary/company.json`, never in field names or shipped
> defaults.

### Environment detection

The env layer is loaded when:

- `CANARY_ENV` is set in the shell, or
- `--env <name>` is passed to `canary company-knowledge show`

```bash
# Load .canary/company.uat.json on top of company.json
CANARY_ENV=uat canary company-knowledge show
canary company-knowledge show --env uat
```

---

## The schema

`.canary/company.json` is a plain JSON object. All fields are optional.

```json
{
  "confluence_spaces": ["QA", "ENG"],
  "jira_projects": ["PROJ", "OPS"],
  "internal_doc_urls": [
    "https://acme.atlassian.net/wiki/spaces/QA/pages/1/Test-Conventions"
  ],
  "internal_domains": ["acme.example.com", "partner.example.com"],
  "mcp_servers": ["plugin_atlassian_atlassian", "harness"],
  "claude_code_skills": ["acme:ui", "acme:e2e"],
  "notes": "Free-text guidance for the LLM. No secrets."
}
```

| Field | Validation | Notes |
| --- | --- | --- |
| `confluence_spaces` | Uppercase alphanumeric, ≤32 chars, deduped | |
| `jira_projects` | Uppercase alphanumeric, ≤32 chars, deduped | |
| `internal_doc_urls` | Must parse as `http(s)://...` | Invalid entries dropped with a warning |
| `internal_domains` | `^[a-z0-9.-]+\.[a-z]{2,}$`, lowercased | |
| `mcp_servers` | `^[A-Za-z0-9_-]+$` | |
| `claude_code_skills` | Bare (`verify`) or scoped (`acme:ui`) slugs | |
| `notes` | Free text, capped at 2048 chars | Triple-backtick fences stripped |

### Secrets

The module **rejects** any value that looks like a secret — values matching
`sk-`, `api_key`, `token`, `secret`, `bearer` prefixes, or longer than 128
chars in non-`notes` fields. Detected secrets cause the whole file to be
rejected with a clear error. Keep secrets in environment variables; reference
them by env-var name (e.g. `"dashboard_token_env": "MY_TOKEN_VAR"`).

---

## `canary company-knowledge init`

Interactive scaffolder — walks through each field with examples and current
values as defaults. Safe to re-run: merges with an existing file unless
`--force` is passed.

```bash
canary company-knowledge init           # merge with existing
canary company-knowledge init --force   # start from scratch
```

Adds `.canary/` to `.gitignore` automatically.

---

## `canary company-knowledge show`

Prints the merged view across all three cascade sources.

```bash
canary company-knowledge show                  # styled output
canary company-knowledge show --json           # raw JSON
canary company-knowledge show --env uat        # include env layer
canary company-knowledge show --validate-mcp   # check MCP registration
```

Output includes a `sources:` header showing which files were loaded.

### `--validate-mcp`

Checks each `mcp_servers` entry against locally registered sources:

| Status | Meaning |
| --- | --- |
| ✓ `registered` | Found in `.mcp.json` or an installed Claude Code plugin |
| ⚠ `plugin_disabled` | Plugin installed but not enabled in Claude Code settings |
| ✗ `not_found` | Not found locally (may still work at runtime if registered elsewhere) |

The check is local-only — no network calls.

---

## Org-wide defaults

If your team shares a set of common pointers (same Jira projects, same MCP
servers), place them in `~/.canary/company.json` on each developer's machine.
Project files then only need to declare what's specific to that repo.

```json
// ~/.canary/company.json — shared team baseline
{
  "mcp_servers": ["plugin_atlassian_atlassian", "harness"],
  "internal_domains": ["acme.example.com"]
}
```

```json
// .canary/company.json — project-specific additions
{
  "confluence_spaces": ["PROJ-QA"],
  "jira_projects": ["PROJ"],
  "claude_code_skills": ["acme:ui"]
}
```

Merged result: all four fields populated, no duplication.

---

## Per-environment overrides

Create `.canary/company.<env>.json` for environment-specific config:

```json
// .canary/company.uat.json
{
  "notes": "Use UAT endpoint for all API calls. Credentials in DASHBOARD_API_TOKEN."
}
```

The env layer's `notes` replaces the project layer's `notes` when active.
List fields (like `confluence_spaces`) would be unioned on top.

---

## What gets injected into prompts

When `is_empty == False`, Canary appends this block to generation prompts:

```text
--- COMPANY KNOWLEDGE ---
Consult these company-internal sources when generating:
- Confluence spaces (via plugin_atlassian_atlassian MCP): QA, ENG
- Jira projects (via plugin_atlassian_atlassian MCP): PROJ
- Reference docs (fetch via MCP / authenticated tool):
    - https://acme.atlassian.net/wiki/spaces/QA/...
- Internal domains: acme.example.com
- Claude Code skills available for this project: /acme:ui. Invoke the
  relevant skill when its scope matches the task.
- Notes from the project owner: <verbatim notes>
Do not invent internal URLs, project keys, or hostnames. If a piece of
context isn't covered above, say so in a comment rather than guessing.
```

---

## Usage examples

Fields are validated and merged, but Canary itself never auto-consumes
most of them beyond the prompt-injection block above — skills that want a
pointer read it explicitly. `otel_exporter_endpoint` has one such consumer:

### `canary-instrument` — OTLP collector endpoint

The `canary-instrument` skill's `otel_bootstrap/instrument.mjs` reads the
standard `OTEL_EXPORTER_OTLP_ENDPOINT` env var directly — it has no code
dependency on this module. Populate that env var from company-knowledge
before your test run if you want spans additionally streamed to a
collector (the file-based export `canary-instrument` relies on for
correlation works either way):

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="$(canary company-knowledge show --json | jq -r '.otel_exporter_endpoint')"
npx playwright test
```

See `agents/skills/claude-code/canary-instrument/SKILL.md` for the full
setup.

---

## `.canary/` gitignore note

`.canary/` is gitignored by `canary company-knowledge init`. This means
`.canary/company.json` is **not committed** by default — it's a per-clone
artifact.

If you want the project-level config committed (it contains only pointers,
no secrets), add an exception:

```gitignore
.canary/
!.canary/company.json
```
