---
name: canary-company-knowledge
description: >
  Scaffold .canary/company.json — the org-specific pointer file (Confluence
  spaces, Jira projects, internal docs/domains, MCP servers, dashboard, and
  the user-catalog skill) that canary-ci-ready and canary-failure-impact
  silently assume already exists. Use when the user says "set up company
  knowledge", "bootstrap company.json", "no company.json", "canary
  company-knowledge init", or when canary-ci-ready/canary-failure-impact
  report no user-catalog config for auth/config failures. Scaffolds the file
  and prompts for the fields that genuinely cannot be inferred — it does not
  claim full automation.
---

# Canary: Company Knowledge Init

Wraps `canary company-knowledge init` to scaffold `.canary/company.json` —
the *pointers-only* file that lets Canary skills reach into your org's
internal tooling (Confluence, Jira, internal docs, MCP servers, a user
catalog) without ever committing proprietary content to this open-core repo.

This file is silently assumed to exist by
[`canary-ci-ready`](../canary-ci-ready/SKILL.md) (user-catalog investigation
for auth/config failures) and
[`canary-failure-impact`](../canary-failure-impact/SKILL.md) (same). If
neither has ever been run with a populated `company.json`, both degrade to a
generic "check your user catalog if you have one" message. This skill closes
that gap.

## When to Use

- First-time setup for a new project or team — "we need to configure company
  knowledge for canary"
- `canary-ci-ready` or `canary-failure-impact` fell back to the generic
  user-catalog message and the user wants real investigation instead
- `canary company-knowledge show` reports "No company knowledge configured"
- Re-running setup to add a field that was skipped the first time (safe —
  `init` merges onto existing values by default)
- NOT for storing secrets, API keys, or tokens — this file holds pointers
  only; the CLI's secret heuristic (`_looks_like_secret`) rejects
  `sk-`/`token`/`bearer`-shaped values and anything over 128 chars outside
  `notes`
- NOT for company-specific proprietary content (client names, internal
  runbooks, populated data) — per this repo's open-core boundary
  (`AGENTS.md`), that lives only in a private overlay under `.canary/skills/`
  or the org's own tooling, reached *via* the pointers this file stores

## What This Skill Cannot Automate

Every field in `.canary/company.json` is org-specific and cannot be reliably
inferred from the codebase alone — this repo is public/open-core by design,
so nothing in it names a real company, Jira project, or internal host. Don't
claim otherwise. What this skill *can* do:

- Scaffold the file and `.gitignore` entry so it exists and is never
  accidentally committed
- Prompt for each field with the exact validation format the CLI expects, so
  the user isn't guessing at schema
- Detect when a value looks like a secret and refuse it before it reaches
  disk
- Merge onto existing values, so re-running is always safe

What it cannot do: know your Confluence space key, your Jira project prefix,
or which MCP server your org runs. Those come from the user.

## Process

### Phase 1: CHECK — Does It Already Exist?

```bash
python -m agent.cli company-knowledge show
```

- **"No company knowledge configured"** → proceed to Phase 2 (fresh
  scaffold).
- **Populated output** → note which fields are already set (shown with
  `sources:` — `~/.canary/company.json`, `.canary/company.json`, or an env
  layer). Proceed to Phase 2 in merge mode (no `--force`) so existing values
  survive as defaults.
- **`⚠` error line** (secret-like value or malformed JSON in an existing
  layer) → surface the exact warning to the user before continuing; that
  layer is being skipped entirely until fixed.

### Phase 2: SCAFFOLD — Run the Interactive Init

```bash
python -m agent.cli company-knowledge init
```

Walk the user through each prompt. For each field, explain what it's for and
give the expected shape before they answer — the CLI accepts blank input to
skip or keep the current value:

| Field | Format | Purpose |
| --- | --- | --- |
| `confluence_spaces` | comma-separated, uppercase (`QA, ENG`) | spaces the LLM should consult for org docs |
| `jira_projects` | comma-separated, uppercase (`PROJ, OPS`) | projects for ticket cross-referencing |
| `internal_doc_urls` | one URL per line, `http(s)://` only | specific reference docs to fetch via MCP |
| `internal_domains` | comma-separated hostnames (`corp.example.com`) | flags internal-only URLs in generated content |
| `mcp_servers` | comma-separated identifiers (`plugin_atlassian_atlassian`) | which configured MCP server(s) back the above |
| `claude_code_skills` | comma-separated slugs (`team:skill-name`) | project-overlay skills to surface as available |
| `notes` | free text, ≤2048 chars, no secrets | anything else the LLM should know |

Fields not prompted by `init` (`dashboard_url`, `dashboard_token_env`,
`otel_exporter_endpoint`) can be added by hand-editing the JSON afterward —
mention this if the user needs dashboard/OTel wiring; don't skip it silently.

If the user offers a value that looks like a credential (starts with `sk-`,
`token`, `bearer`, or is unusually long), stop and remind them: secrets go in
environment variables, never in `company.json`. The CLI will reject the
whole layer if one slips through — better to catch it before submitting.

### Phase 3: WIRE THE USER-CATALOG SKILL (Known Schema Gap)

`canary-ci-ready` and `canary-failure-impact` both read a `user_catalog_skill`
key directly from `.canary/company.json` to investigate auth/config
failures. **This key is not part of the CLI's validated schema** — it isn't
in `CompanyKnowledge`'s known fields, `company-knowledge init` never prompts
for it, and `company-knowledge show` will list it under "ignored unknown
field" if you inspect warnings. It still works for the two consuming skills
because they read the raw JSON file directly rather than going through the
Python loader — but be transparent with the user that this is an informal
extension, not a first-class field, until the schema catches up.

To wire it:

1. Ask the user which project-overlay skill (if any) looks up test users —
   e.g. `team:user-lookup`. If they don't have one, skip this phase; the
   consuming skills degrade gracefully to a generic prompt.
2. If they gave a normal skill slug, prefer adding it to
   `claude_code_skills` (a real, validated field) *and* separately hand-edit
   `.canary/company.json` to add the literal key:

   ```json
   {
     "claude_code_skills": ["team:user-lookup"],
     "user_catalog_skill": "team:user-lookup"
   }
   ```

3. Confirm the value matches what `canary skills run <user_catalog_skill>`
   expects as an identifier (same slug format as `claude_code_skills`:
   `^[a-z0-9][a-z0-9_-]*(:[a-z0-9][a-z0-9_-]*)?$`).

### Phase 4: VERIFY

```bash
python -m agent.cli company-knowledge show
```

- Confirm every field the user just set appears in the printed output.
- Confirm no `⚠` warnings (unknown fields other than the intentional
  `user_catalog_skill` extension, dropped invalid entries, secret
  detections).
- Confirm `.gitignore` now contains a `.canary/` line — `init` adds it
  automatically, but verify if the project already had a `.gitignore` with
  unusual formatting.
- If JSON output is useful for the user's own tooling: `--json`.

## Error Handling

| Situation | What Happens | What To Do |
| --- | --- | --- |
| `.canary/company.json` already exists, no `--force` | `init` shows existing values as defaults and merges | Normal — just re-run `init` |
| Secret-like value entered | That whole layer is dropped; `show` prints a red `✗` | Remove the value, use an env var, re-run |
| Malformed JSON in an existing file | Layer skipped with a parse error | Fix the JSON by hand, then re-run `show` to confirm |
| Invalid entry format (e.g. lowercase Jira key) | Entry silently dropped, warning logged | Re-enter in the correct case/format |
| Unknown field in the file | Warned, not fatal, field ignored by the loader | Expected for `user_catalog_skill` today (Phase 3) — otherwise likely a typo |
| User has no Confluence/Jira/MCP setup at all | Every field is legitimately empty | Skip `init` entirely; `canary-ci-ready`/`canary-failure-impact` degrade to their generic prompts, which is correct behavior, not a bug |

## Examples

### Example: First-time team lead setup

**Prompt:** "Set up company knowledge for canary on this repo."

**Action:** Run `company-knowledge show` → "No company knowledge
configured." Run `company-knowledge init`. Walk through each field; the team
lead has a Confluence space (`QA`), a Jira project (`OPS`), and an Atlassian
MCP server (`plugin_atlassian_atlassian`) but no internal dashboard yet.
Leave `dashboard_url` unset. Ask about a user-catalog skill — they don't have
one, so Phase 3 is skipped. Verify with `show`.

### Example: Retrofitting `user_catalog_skill` onto an existing file

**Prompt:** "`canary-ci-ready` keeps telling me to check my user catalog
manually, but we have a skill for that."

**Action:** Run `show` — confirm `.canary/company.json` already has
`confluence_spaces`/`jira_projects` set from a prior run. Ask for the skill
slug (`team:test-user-lookup`). Add it to both `claude_code_skills` and the
raw `user_catalog_skill` key per Phase 3. Re-run `show` to confirm no new
warnings, then re-run `canary-ci-ready` on a known failing auth test to
confirm the lookup now fires.

## Related Skills

- [`canary-ci-ready`](../canary-ci-ready/SKILL.md) — consumes
  `user_catalog_skill` for auth/config failure investigation
- [`canary-failure-impact`](../canary-failure-impact/SKILL.md) — same
  investigation pattern, different trigger context
