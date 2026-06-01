# Canary: Setup Harness

> Configure the Harness Engineering guardrails in a new Canary
> project (or a fork). Installs the harness CLI, initialises the
> config, wires up CI workflows, and verifies all gates pass on
> a clean repository.

## When to Use

- When setting up Canary (or a fork) in a new repository for
  the first time
- When onboarding a new project that wants Canary's CI gate
  structure
- When a fork has drifted from the harness config and needs
  to be re-aligned
- NOT for day-to-day harness updates — use the harness CLI's
  own update flow for that
- NOT for adding a single new gate to an existing config —
  edit `harness.config.json` directly
- NOT for troubleshooting a failing CI check — see the
  [Understanding the Harness][harness-wiki] wiki page

[harness-wiki]: ../../../../docs/wiki/Understanding-the-Harness.md

## Process

### Phase 1: PREREQUISITES — Confirm the Environment

1. **Verify Node.js is available** (harness CLI requires it):

   ```bash
   node --version
   ```

   Version 18 or later is required.

2. **Verify Python is available** (security ledger script):

   ```bash
   python3 --version
   ```

   Version 3.11 or later is required.

3. **Confirm the repo has a `harness.config.json`** at the
   root. If it doesn't, the harness is not yet configured —
   continue to Phase 2. If it does, validate it first:

   ```bash
   npx --yes -p @harness-engineering/cli harness validate
   ```

   If validation passes, the harness is already set up. Stop
   here unless re-alignment is the goal.

### Phase 2: INSTALL — Run the Harness Init

1. **Initialise the harness** from the repo root:

   ```bash
   npx --yes -p @harness-engineering/cli harness init
   ```

   This creates `harness.config.json` with default gates and
   generates the `.harness/` hooks directory.

2. **Review the generated `harness.config.json`.** The defaults
   are sensible, but confirm:

   - `layers` matches the project's actual package structure
     (for Canary: `llm`, `core`, `cli`)
   - `entrypoints` lists the correct top-level packages
   - `telemetry` and `adoption` settings match team policy

3. **Inspect `.harness/hooks/`.** The hooks directory contains
   scripts that run locally on git events. Review each file
   briefly — they should not require network access outside
   the harness telemetry endpoint.

### Phase 3: CONFIGURE — Wire Up CI Workflows

1. **Check which workflows already exist:**

   ```bash
   ls .github/workflows/
   ```

2. **Required workflows for a full harness setup.** Each
   should exist as a `.yml` file in `.github/workflows/`:

   - `harness.yml` — core phase-gate checks
   - `harness-architecture.yml` — layer dependency validation
   - `harness-quality.yml` — quality and integrity checks
   - `harness-security.yml` — security scan + ledger refresh
   - `docs-lint.yml` — markdown formatting enforcement

   If any are missing, copy them from an upstream Canary
   reference install or generate them:

   ```bash
   npx --yes -p @harness-engineering/cli harness \
     generate-workflows
   ```

3. **Confirm `harness-security.yml` refreshes the ledger.**
   The final steps of the security job must run the ledger
   script and commit if changed. Without this, the security
   ledger goes stale and the Quality gate fails.

4. **Confirm `docs-lint.yml` covers all doc paths.** The
   workflow's `paths` filter should include:

   - `docs/**`
   - `agents/**`
   - `AGENTS.md`

5. **Set required permissions.** Workflows that commit
   back to the repository need `contents: write`:

   ```yaml
   permissions:
     contents: write
   ```

   This applies to `harness-security.yml` at minimum.

### Phase 4: BASELINE — Generate Initial Artifacts

1. **Run the security scan to create the initial ledger:**

   ```bash
   npx --yes -p @harness-engineering/cli harness check-security
   python3 scripts/security_ledger.py
   ```

2. **Commit the generated baseline files:**

   ```bash
   git add harness.config.json .harness/ \
     .harness/security/timeline.json \
     docs/SECURITY_LEDGER.md
   git commit -m "chore: initialise harness configuration"
   ```

3. **Push and confirm all CI gates pass** on the resulting
   commit before calling setup complete.

### Phase 5: VERIFY — Confirm All Gates Pass

1. **Open a pull request** (or push to the configured branch)
   to trigger CI.
2. **Check each workflow:**

   - Architecture Enforcer: green
   - Quality & Integrity: green
   - Docs Lint: green
   - Security Reviewer: green (ledger will be auto-refreshed
     by the workflow on first scan)

3. **If any gate fails:** Read the error, fix the root cause,
   push again. Do not suppress gates or skip hooks to make CI
   green — fix the actual issue.

4. **Log to `docs/CANARY_STATE.md`** that harness setup was
   completed, including the date and commit SHA.

## Canary Integration

- **`harness.config.json`** — Layer rules, entrypoints,
  telemetry/adoption settings. Source of truth for all
  harness gates.
- **`.harness/hooks/`** — Local git hooks generated during
  `harness init`. Committed so all contributors share them.
- **`.github/workflows/`** — CI workflows that run the harness
  gates on every PR.
- **`scripts/security_ledger.py`** — Regenerates
  `docs/SECURITY_LEDGER.md` from `.harness/security/timeline.json`.
  Must be run after every security scan.
- **`docs/CANARY_STATE.md`** — Project ledger. Log setup
  completion here.

## Success Criteria

- `harness validate` exits cleanly with no violations
- All five CI workflows exist and pass on a clean push
- The security ledger (`docs/SECURITY_LEDGER.md`) exists and
  is not stale
- `.harness/hooks/` is committed and present in the repo
- A setup entry exists in `docs/CANARY_STATE.md`

## Rationalizations to Reject

| Rationalization | Why It Is Wrong |
| --- | --- |
| "CI is red but the code is fine, I'll add `--no-verify`" | Skipping hooks defeats the entire purpose of the harness. Fix the root cause. |
| "I'll set up the workflows later — the config is good enough" | A config with no CI enforcement is ornamental. The gates only protect the team when they run on every PR. |
| "The security ledger step seems redundant — the scan already ran" | The scan writes to a JSON timeline; the ledger script produces the human-readable summary. Both are needed. |
| "I'll commit the hooks directory but not review the files" | Hook files run on every developer's machine. Review them before committing — they're executable scripts. |

## Examples

### Example: Fresh install on a new fork

**Scenario:** `cap-canary` is a new fork of `canary-test-ai-agent`.
It has no harness config yet.

**Steps:**

1. Clone the fork and run `harness init`.
2. Review `harness.config.json` — layers match `llm`, `core`,
   `cli`. Entrypoints set to `agent`.
3. Copy the five CI workflow files from upstream.
4. Run the security scan, generate the baseline ledger, commit.
5. Push. All five gates pass. Log to `CANARY_STATE.md`.

### Example: Re-aligning a drift after harness update

**Scenario:** A harness CLI update added a new hook file to
`.harness/hooks/`. The local copy doesn't have it.

**Steps:**

1. Run `npx --yes -p @harness-engineering/cli harness update`.
2. Review the diff in `.harness/hooks/` — confirm the new
   file is expected.
3. Stage and commit the new hook file.
4. Push. CI passes.

## Escalation

- **When `harness init` fails or produces unexpected output:**
  Check the harness CLI version. A major version mismatch
  between the CLI and the `harness.config.json` schema is the
  most common cause.
- **When a CI gate fails after a clean setup:** Don't assume
  the setup is wrong. Read the failure output — it often points
  to a pre-existing issue in the repo that the harness is now
  surfacing for the first time.
- **When a fork needs company-specific config injected:**
  Set up the base harness using this skill, then apply the
  company-specific overrides as a follow-up commit. Don't
  mix upstream setup with fork-specific changes.
- **When the wiki-sync workflow fails on first run:** The
  GitHub wiki is a separate git repository that GitHub creates
  lazily — it doesn't exist until someone saves the first page
  via the UI. Go to the repo → Wiki → create any placeholder
  page. After that, the wiki-sync workflow handles the wiki
  repo correctly on all subsequent runs. Each new fork needs
  this one-time step.
