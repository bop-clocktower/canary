---
name: canary-add-framework
description: >
  Add a new testing framework to Canary's registry end-to-end — aligns the
  classifier↔registry contract, authors the `agent/frameworks/registry.json`
  entry, validates the execution command, and ensures every classifier
  `test_type` still resolves to a non-null framework. Use for "add support for
  a new framework", "add k6", "support cypress", "we need Locust", or when a
  classifier `test_type` exists with no framework backing it (registry gap).
  Not for choosing between existing frameworks at runtime (that's the
  recommender's job) or adding a one-off framework name with no real CLI.
---

# Canary: Add Framework

> Add a new testing framework to Canary's registry end-to-end. Confirms
> the classifier↔registry contract, authors the registry entry,
> validates the execution command, and ensures every classifier
> `test_type` still resolves to a non-null framework.

## When to Use

- When the user asks to add support for a new framework ("add k6",
  "support cypress", "we need Locust")
- When a classifier `test_type` exists but has no framework backing it
  (registry gap)
- When migrating from a deprecated framework — adding the new entry
  before removing the old one
- NOT for choosing between existing frameworks at runtime — that's the
  recommender's job
- NOT for adding a one-off LLM-generated framework name that doesn't
  exist as a real tool — frameworks must be real, runnable CLIs

## Process

### Phase 1: SCOPE — Confirm the Framework Belongs in the Registry

1. **Verify the framework is real and installable.** It needs a runnable
   CLI invocation (the `execution_command` template). If you can't write
   a one-line shell command that runs a single test file, it doesn't fit
   Canary's model.
2. **Identify the category.** Match to an existing `category` value
   (`e2e_ui`, `python_unit`, `api`, `performance`, `frontend_unit`,
   etc.). New categories require a coordinated classifier update — see
   Phase 2.
3. **Check for overlap.** Is there already a `preferred` framework in
   this category? If yes, decide intentionally: is the new framework a
   replacement (demote the old to `legacy`), a peer (add as
   `supported`), or the new preference (demote the old, mark new as
   `preferred`)?
4. **Confirm the user wants this maintained.** Each registry entry is a
   maintenance commitment. A framework added casually but never
   validated rots into a routing trap.

### Phase 2: ALIGN — Classifier ↔ Registry Contract

1. **Find the classifier rule that emits this `test_type`.** Open
   `agent/core/classifier.py` and locate the heuristic block that
   produces the target category.
2. **If no classifier rule exists for the category:** Add one *before*
   the registry entry. A framework with no routing path is a dead entry.
   Add a heuristic that maps natural-language signals (keywords,
   phrases) to the new `test_type`.
3. **If the category exists but the classifier never emits it
   confidently:** Strengthen the rule's heuristics. Confidence below 0.7
   should trigger a clarification, not a generation.
4. **Run the contract tests:**

   ```bash
   pytest tests/unit/test_orchestrator.py
   ```

   Every `test_type` the classifier can emit must resolve to ≥1
   framework via `get_by_category` — the orchestrator tests assert
   non-null framework resolution per category. This is the gate.

### Phase 3: AUTHOR — Write the Registry Entry

1. **Open `agent/frameworks/registry.json`.** Add a new object to
   `frameworks[]`. Required fields:
   - `name` (unique slug)
   - `display_name`
   - `category` (must match the classifier emission)
   - `languages`
   - `file_extensions`
   - `execution_command` (with `{file}` placeholder)
   - `status` (`preferred` / `supported` / `legacy`)
2. **Add recommended metadata.** `maturity`, `community_size`,
   `recommended_for`, `strengths`, `avoid_when`, `ecosystems`. These
   show up in the recommender's reasoning string — sparse entries
   produce sparse recommendations.
3. **Validate the `execution_command`.** It must run a single test file
   when `{file}` is substituted. Test manually:

   ```bash
   echo '<minimal test>' > /tmp/sample.<ext>
   <execution_command with /tmp/sample.<ext> substituted>
   ```

   Confirm exit code 0 (or expected non-zero) and no missing-config
   errors.
4. **Confirm the `{file}` placeholder is the only substitution.** The
   executor tokenizes the template with `shlex.split` before
   substituting `{file}`, so the file path stays a single argv element;
   paths with spaces must remain intact.

### Phase 4: VERIFY — Generate, Execute, Promote-Dry

1. **Generate a test that should route to the new framework:**

   ```bash
   python -m agent.cli generate "<prompt that should hit the new test_type>"
   ```

2. **Check the trace.** Classification matches the expected category,
   recommendation picks the new framework (or the existing preferred —
   confirm this matches your intent), output file has the right
   extension.
3. **Execute with `--execute`.** Confirm the framework's CLI actually
   runs the generated file. A passing execution validates the
   `execution_command` template under the real Canary invocation path.
4. **Don't promote.** This is a registry-validation run, not a real test
   promotion. Leave the artifact in `tests/generated/`.

### Phase 5: DOCUMENT — Update Guides and State

1. **Update `docs/guides/framework-registry.md`** if you added a new
   category, changed the contract surface, or introduced a new optional
   field schema.
2. **Update the LLM-providers guide** if the new framework only works
   with specific provider output styles (rare; flag this as a smell if
   it's true).
3. **Log to `docs/CANARY_STATE.md`.** One line: framework name,
   category, status, date added. This is the project ledger; future
   maintainers grep here first.
4. **Open a PR.** Title: `feat(registry): add <framework-name> support`.
   Body should include the validation steps you ran and the
   generated/executed sample.

## Canary Integration

- **`agent/frameworks/registry.json`** — Source of truth for entries.
- **`agent/core/framework_registry.py`** — Loader and lookup methods.
  Don't add lookup helpers here unless the existing five
  (`get_all_frameworks`, `get_by_category`, `get_preferred_by_category`,
  `find_by_name`, `match_by_language`) genuinely don't fit.
- **`agent/core/classifier.py`** — Routing rules. Coordinate changes
  with registry entries.
- **`tests/unit/test_orchestrator.py`** — Contract enforcement. Non-null
  resolution per `test_type` (api → pytest, e2e_ui → playwright,
  performance → k6, etc.) is asserted here. `tests/unit/test_factory.py`
  separately enforces the LLM provider matrix.

## Success Criteria

- New entry validates against the contract test (no orphaned `test_type`
  in classifier, no null framework resolution in registry)
- `python -m agent.cli generate "<routing prompt>"` resolves to the new
  framework
- `--execute` runs the generated file successfully via the new
  `execution_command`
- `framework-registry.md` documents any new category or schema field
- `CANARY_STATE.md` ledger entry is present
- PR includes the validation transcript

## Rationalizations to Reject

| Rationalization | Why It Is Wrong |
| --- | --- |
| "I'll add the registry entry now and update the classifier later" | Orphaned registry entries are routing traps. Either both land together or neither does. |
| "Marking it `preferred` is fine, no need to demote the existing entry" | Multiple `preferred` entries in one category means `get_preferred_by_category` picks by registry order, not by merit. Demote the loser explicitly. |
| "I tested the command with my path — Canary's substitution will work too" | Test the substituted command with a path that contains spaces. The executor's `shlex.split`-then-substitute order exists specifically to handle this case; a broken template will silently corrupt argv. |
| "It only needs to work for the happy-path prompt I tried" | If the classifier emits this `test_type` with confidence ≥0.7 for *any* phrasing, the framework must handle the resulting generated file. Test at least two distinct prompts that route to the new entry. |
| "Sparse metadata is fine, we can fill it in later" | The recommender's reasoning string is read by humans and agents. Sparse metadata produces unhelpful recommendations — fill it in now while you have the context. |

## Examples

### Example: Adding Cypress as a peer to Playwright

**Scope:** Cypress already has community demand and a CI image. Category
`e2e_ui` already has Playwright as `preferred`. Decision: add Cypress as
`supported`, keep Playwright as `preferred`.

**Classifier:** Already emits `test_type=e2e_ui` on UI-test prompts. No
classifier change needed.

**Entry (abridged):**

```json
{
  "name": "cypress",
  "display_name": "Cypress",
  "category": "e2e_ui",
  "languages": ["javascript", "typescript"],
  "file_extensions": ["cy.ts", "cy.js"],
  "execution_command": "npx --yes cypress run --spec {file}",
  "status": "supported",
  "strengths": ["Time-travel debugging", "Strong DX for UI tests"],
  "avoid_when": ["Cross-browser parity required (Playwright is stronger)"]
}
```

**Validation:** Generated a UI test prompt, confirmed recommender still
picked Playwright (correct — `preferred` wins). Verified Cypress is
accessible by routing a prompt with explicit Cypress mention through a
future explicit-framework override.

### Example: Adding k6 to a new performance category

**Scope:** Performance category doesn't exist in the registry yet.
Classifier emits `test_type=performance` on load/stress prompts, but the
registry has no matching entry — this is the orphan case.

**Phase 2 first:** Confirmed `agent/core/classifier.py` already has the
performance rule (`if "performance" in p or "load test" in p ...`). No
classifier change needed.

**Phase 3:**

```json
{
  "name": "k6",
  "display_name": "k6",
  "category": "performance",
  "languages": ["javascript"],
  "file_extensions": ["js"],
  "execution_command": "k6 run {file}",
  "status": "preferred",
  "recommended_for": ["HTTP load testing", "Stress and spike tests"],
  "avoid_when": ["Browser-level performance (use Playwright tracing)"]
}
```

**Validation:** `python -m agent.cli generate "Load test /v1/search at
200 RPS for 5 minutes" --execute`. Confirmed classifier emits
`test_type=performance` at 0.95 confidence, recommender picks k6, k6
CLI runs the generated file without error.

## Escalation

- **When the framework requires a non-trivial config file (e.g.,
  `playwright.config.ts`):** Document the setup in `avoid_when` or in
  `recommended_for`. If Canary is expected to generate the config too,
  that's a scaffolder change, not just a registry change.
- **When two frameworks legitimately should both be `preferred` for
  different sub-cases:** Split the category. A single category should
  have a single `preferred`. If the split isn't clean, surface this to
  the user as a design decision rather than fudging the registry.
- **When the classifier doesn't reliably emit the target `test_type`:**
  Don't add the registry entry yet. Strengthen the classifier first — an
  unreachable entry is dead weight.
- **When the framework's CLI doesn't accept a single-file argument:**
  Canary's model is one-test-per-file generation. Frameworks that only
  run by directory or by tag don't fit cleanly; raise this with the user
  before forcing a workaround.
