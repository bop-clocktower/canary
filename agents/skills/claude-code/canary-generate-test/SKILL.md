---
name: canary-generate-test
description: >
  Generate a framework-appropriate test from a natural-language requirement by
  routing through Canary's classify → recommend → generate CLI pipeline
  (`python -m agent.cli generate`), writing the test under `tests/generated/`
  and optionally executing it. Use for "write a test for X", "I need an API
  test that does Y", "scaffold a new test from this description", or
  triaging a bug report into a regression test — when a CLI batch pipeline
  run (not an interactive session-generated file) is what's wanted. See
  `agents/canary-test-author.md` (interactive, session-generated, wired to
  `/canary-write-test`) and `agents/canary-test-generator.md` (MCP
  write_test_file retry loop) for the other two "write a test" paths. Not for
  editing existing tests or choosing between frameworks abstractly.
---

# Canary: Generate Test

> Generate a framework-appropriate test from a natural-language
> requirement. Routes through Canary's classify → recommend → generate
> pipeline, writes the test under `tests/generated/`, and optionally
> executes it.

## When to Use

- When the user asks to scaffold a new test from a natural-language
  description ("write a test for X", "I need an API test that does Y")
- When triaging a bug report into a regression test
- When extending an existing test suite with a new case but the
  framework choice is ambiguous
- NOT for editing existing tests — use the project's normal edit flow
- NOT for choosing between frameworks abstractly — use the
  framework-registry docs, not this skill
- NOT for running existing tests — use the framework's CLI directly

### Relative to the other "write a test" paths

This skill is the **CLI batch pipeline** (`python -m agent.cli generate`) —
use it for scripted/CI-driven generation runs consumed programmatically from
`tests/generated/`. For an interactive, session-generated test with a human
reviewing framework and code before it lands, use
`agents/canary-test-author.md` (wired to `/canary-write-test`). For a
single-file, automatic write-run-revise loop via MCP tools, use
`agents/canary-test-generator.md`.

## Process

### Phase 1: CLARIFY — Resolve the Requirement

1. **Confirm test type if ambiguous.** If the prompt doesn't clearly
   indicate `unit | api | e2e | performance`, ask one targeted question
   before invoking the pipeline. The classifier will guess, but a wrong
   guess costs a regeneration.
2. **Confirm target framework if the user has a preference.** The
   recommender will pick by category from the registry; if the user
   explicitly wants Playwright but the registry would pick Cypress for
   the category, surface that mismatch now.
3. **Capture concrete inputs.** Endpoint URL, payload shape, expected
   status, selectors, performance thresholds — whatever the test
   actually needs. Vague prompts produce vague tests.

### Phase 2: GENERATE — Run the Pipeline

1. **Invoke the orchestrator** via CLI or programmatically:

   ```bash
   python -m agent.cli generate "<requirement>"
   ```

2. **Read the printed classification + recommendation.** Verify the
   resolved `test_type` and `framework` match intent. If they don't,
   refine the prompt and re-run — do not hand-edit the generated file
   to compensate for a misclassification.
3. **Locate the output.** The CLI prints an absolute path under
   `tests/generated/<category>/`. The orchestrator return dict's
   `output_path` is authoritative.

### Phase 3: VALIDATE — Execute or Dry-Run

1. **Run the generated test** with the framework's CLI (or pass
   `--execute` to the generator). For api/e2e tests, run against a
   known-good environment first.
2. **If execution fails, classify the failure:**
   - **Generation error** (syntax, wrong API shape) → regenerate with
     a more specific prompt; don't hand-fix unless trivial
   - **Environment error** (missing creds, wrong base URL) → fix the
     env, rerun
   - **Real assertion failure** (the SUT behaves differently than the
     prompt asserted) → this is a useful signal; review with the
     requester before changing the test
3. **Log the run.** Append the requirement, classification, framework,
   and pass/fail to `docs/CANARY_STATE.md` so downstream sessions can
   pick up context.

### Phase 4: PROMOTE — Move from Generated to Committed

If the generated test passes review and belongs in the committed suite,
use the [`canary-promote-test`](../canary-promote-test/SKILL.md) skill.
Promotion is its own workflow — don't collapse it into this one.

## Canary Integration

- **`python -m agent.cli generate <prompt>`** — Primary entry. Runs the
  full pipeline; supports `--execute` to immediately run the generated
  test.
- **`CanaryOrchestrator.run(prompt, execute=False)`** — Programmatic
  entry. Returns the structured pipeline-result dict.
- **`agent/frameworks/registry.json`** — Maps `test_type` → framework.
  Edit here when adding a new framework; never hard-code framework
  choices in callers.
- **Generation runs in your Claude Code session** — there is no LLM
  provider layer or API key to configure (the `agent/llm/` layer was
  removed in v3.0).

## Success Criteria

- The generated file parses and runs under its framework's CLI
- The classifier's `test_type` matches the user's actual intent
- The recommender's framework choice resolves from the registry (no
  nulls)
- The execution result is captured in the return dict (when
  `execute=True`)
- A promoted test passes review and runs cleanly in CI

## Rationalizations to Reject

| Rationalization | Why It Is Wrong |
| --- | --- |
| "The classifier picked the wrong type but I'll hand-fix the output" | The hand-fix masks a real classifier gap. Refine the prompt or file a classifier issue — don't paper over routing bugs in the generated file. |
| "I'll commit the generated test as-is, it's good enough" | Generated tests live in `tests/generated/` for a reason — they're unreviewed scratch. Promote intentionally. |
| "The registry doesn't have an entry for this test_type, I'll add `framework: null`" | Null breaks the contract. Every `test_type` must map to a framework. Add a real entry or change the classifier output. |
| "I'll skip the validation phase, the test looks right" | LLM output that looks right and runs are different things. Always execute (or dry-run) before promoting. |

## Examples

### Example: API test for a known endpoint

**Prompt:** `Test that POST /v1/orders returns 201 with a valid payload`

**Pipeline trace:**

```text
Classification: intent=generate_tests, test_type=api, confidence=0.85
Recommendation: framework=requests-pytest, ext=.py, category=api
Output: tests/generated/api/orders_post_201.py
Execution: returncode=0, 1 passed in 0.42s
```

**Action:** Review the generated file, promote to
`tests/api/orders_post_201.py`, drop the timestamped header.

### Example: Ambiguous prompt — clarification first

**Prompt:** `Test the new orders feature`

**Action:** Do NOT invoke the pipeline yet. Ask: "Is this an end-to-end
UI test of the checkout flow, an API contract test for `/v1/orders`, or
a unit test of the order-validation function?" Only after the user picks
should you run `generate`.

### Example: Performance test with thresholds

**Prompt:** `Load test /v1/search at 200 RPS for 5 minutes, p95 latency < 300ms`

**Pipeline trace:**

```text
Classification: test_type=performance, confidence=0.95
Recommendation: framework=k6, ext=.js, category=performance
Output: tests/generated/performance/search_load.js
```

**Validation:** Run against a staging environment, not prod. Compare p95
to the threshold; if the test passes locally but the threshold was
unrealistic, surface that to the requester before promoting.

## Escalation

- **When the registry has no entry for the classified `test_type`:**
  Stop and file a registry update. Do not invent a framework name.
- **When the generated test repeatedly fails to parse:** This usually
  means the prompt is under-specified. Narrow it to a single behavior
  and regenerate before assuming a bug.
- **When execution requires creds you don't have:** Surface the
  missing-cred error to the user; never embed dummy creds in a generated
  test to make it "run".
- **When the classifier's confidence is below 0.7:** Treat as a
  clarification trigger, not a generation trigger. Loop back to Phase 1.
