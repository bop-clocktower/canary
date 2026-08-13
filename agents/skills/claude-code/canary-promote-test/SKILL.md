---
name: canary-promote-test
description: >
  Move a generated test from `tests/generated/` into the committed test suite —
  reviews it for correctness, drops the generation header, relocates it to the
  matching suite directory, and confirms it runs in the project's normal test
  flow. Use for "promote this test", "commit this generated test", "move this
  test into the suite", or "keep this test" — always after the generated test
  has been validated against the SUT, never before. Not for tests needing
  substantial rewriting (regenerate instead) or throwaway investigation tests
  (leave in `tests/generated/`).
---

# Canary: Promote Test

> Move a generated test from `tests/generated/` into the committed test suite.
> Reviews the test for correctness, drops the generation header, relocates it
> under the appropriate suite directory, and confirms it runs in the project's
> normal test flow.

## When to Use

- After `canary-generate-test` produced a file that has been validated against
  the SUT
- When a user explicitly asks to "commit", "save", or "keep" a generated test
- When extending an existing suite with a new case the team has agreed to
  maintain
- NOT before the generated test has been executed and reviewed — promotion is
  the _last_ step, not the first
- NOT for tests that need substantial rewriting — regenerate with a better
  prompt instead of hand-patching
- NOT for tests targeting throwaway investigations (perf spikes, ad-hoc bug
  triage) — leave those in `tests/generated/`

## Process

### Phase 0: GATE — Get the Structured Verdict First

Run this before reading the test. It is deterministic, takes no API key, and it
will refuse the drafts that are not worth your review time.

```bash
canary promote-check tests/generated/api/orders_post.py --json
```

| Exit | Verdict   | What it means                                                |
| ---- | --------- | ------------------------------------------------------------ |
| `0`  | `promote` | No gating defect. Advisory findings may remain — your call.  |
| `1`  | `block`   | A gating defect. **Do not promote.** Regenerate or fix.      |
| `3`  | `abstain` | No verdict could be produced. Promotion is **not** approved. |

**Which axes gate, and why only those.** Gating on all eight axes of a quality
critique would block nearly every promotion, so only deterministic defects do:

| Axis              | Rules                          | Gates | Reason                                                 |
| ----------------- | ------------------------------ | ----- | ------------------------------------------------------ |
| `soundness`       | `SOUND-001/002/003`            | yes   | Pins a value no correct implementation must produce    |
| `assertions`      | `LINT-006`                     | yes   | A test that asserts nothing always passes              |
| `flakiness`       | `FLAKE-001/002`                | yes   | A hardcoded sleep in a committed suite is a future red |
| `vacuity`         | `VAC-001/003`, annotated `002` | yes   | Cannot fail, or contradicts a declared `@covers`       |
| `selectors`       | `LINT-001/002/003`             | no    | Brittle, not wrong — a reviewer's call                 |
| `maintainability` | `LINT-005`, `FLAKE-003/004`    | no    | Style and softer signals                               |

**`VAC-002` gates only at `annotated` fidelity.** At `import-inferred` it is an
inference about which symbol the test meant to exercise, and a heuristic must
not be load-bearing on a promotion gate. If you want the gate to check the real
target, add the annotation to the generated test:

```ts
// @covers resolveOverlay
```

**An `abstain` is not a pass.** Exit 3 means the checker had no subject — an
unparseable extension, or a file with no test declarations. Promotion falls back
to the manual review below and is **not** approved by silence. Do not read a
missing verdict as either stricter or looser than one.

**An LLM judgement never gates.** `harness:test-craft` runs an 8-axis per-test
critique and remains exactly what step 5 below calls it: an optional deeper
audit for a human. Everything that blocks in this repo is deterministic, and
`promote-check` keeps it that way — the verdict has no field an LLM opinion
could arrive in.

### Phase 1: REVIEW — Confirm the Test Is Worth Keeping

1. **Read the test end-to-end.** Treat it like any other code review — naming,
   assertions, hardcoded values, missing edge cases. Generated tests are drafts,
   not finished artifacts.
2. **Run the test against the real SUT** (not just the env it was generated
   against). A test that only passes in one environment is a fixture-bound test,
   not a regression test.
3. **Check assertion strength.** A test that only asserts "status code 200" is
   weak; promote it only if that's genuinely the contract. If the SUT returns
   structured data, the test should assert on shape.
4. **Confirm no hardcoded secrets or environment-specific URLs.** Replace with
   fixtures or env-driven config before promoting.
5. **Optional: run `harness:test-craft` for a deeper quality audit.**
   `test-craft` runs an 8-axis per-test LLM critique (assertion density,
   flakiness risk, contract vs implementation, etc.). Use it when the generated
   test is substantial or when the team wants a second opinion before
   committing. Not required for simple happy-path tests, and **never a blocker**
   — see Phase 0.
6. **Triage the advisory findings** `promote-check` reported. They did not
   block; deciding whether they matter here is the review's job.
7. **Decide: promote, regenerate, or discard.** If review reveals more than ~3
   small fixes, regenerate with a sharper prompt instead.

### Phase 2: RELOCATE — Move into the Suite

1. **Identify the destination directory.** Mirror the suite's structure:
   - `tests/generated/api/foo.py` → `tests/api/foo.py`
   - `tests/generated/e2e/checkout.spec.ts` → `tests/e2e/checkout.spec.ts`
   - `tests/generated/unit/validator.py` → `tests/unit/validator.py`
2. **Match suite conventions.** Look at neighboring files for:
   - Import style (relative vs absolute)
   - Fixture/setup imports (most suites have a `conftest.py` or shared setup)
   - Naming conventions (`test_<feature>_<case>.py`, `<feature>.spec.ts`)
3. **Move with `git mv`** so the history is preserved if anyone later runs
   `git log --follow`.
4. **Update imports** if the file referenced anything by relative path from
   `tests/generated/`.

### Phase 3: CLEAN — Drop Generation Artifacts

1. **Remove the timestamped generation header.** The "Generated by Canary on
   [date]" comment is useful in scratch space — meaningless in a committed test
   and rots immediately.
2. **Remove any placeholder TODOs.** The generator sometimes emits
   `# TODO: adjust selector` or similar — either resolve them or stop the
   promotion and regenerate.
3. **Tighten formatting.** Run the project's formatter (`black`, `prettier`,
   etc.) so the file matches surrounding style.
4. **Strip dead code.** Imports the generator added "just in case" but the test
   doesn't use.

### Phase 4: VERIFY — Run in the Project's Normal Flow

1. **Run the suite that owns this test:**
   - Python: `pytest tests/api/test_orders_post.py`
   - Playwright: `npx playwright test tests/e2e/checkout.spec.ts`
   - Match whatever CI runs.
2. **Run the full suite** to confirm no collateral failure (shared fixtures,
   port conflicts, ordering issues).
3. **Confirm CI configuration picks it up.** If the suite has a glob in CI
   config, verify the new path matches. If not, add it.
4. **Log the promotion.** Append a one-line entry to `docs/CANARY_STATE.md` so
   the project ledger tracks which generated tests have been promoted.

## Canary Integration

- **`tests/generated/`** — Source for promotion. Gitignored; nothing here is
  ever a final artifact.
- **`tests/<suite>/`** — Destination. Each suite has its own conventions; never
  invent a new top-level dir during promotion.
- **`docs/CANARY_STATE.md`** — Append a promotion entry: requirement, generated
  path, promoted path, date.

## Success Criteria

- The promoted test passes when run via the project's normal test command
- The full suite passes (no collateral breakage)
- The file matches the surrounding code style (formatter clean, lint clean)
- No generation artifacts remain (timestamp header, placeholder TODOs, unused
  imports)
- CI picks up the new test on the next push

## Rationalizations to Reject

| Rationalization                                                           | Why It Is Wrong                                                                                                                                                             |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "`promote-check` exited 3, so nothing was wrong"                          | Exit 3 is an abstention — the checker had no subject at all. It is the one outcome that proves nothing, so it can never stand in for approval.                              |
| "`promote-check` blocked on VAC-002, but the test is fine"                | Only an `annotated` VAC-002 blocks, which means the file's own `@covers` names a symbol the test never touches. Either the annotation is wrong or the test is.              |
| "I'll wire `harness:test-craft` into the gate for better coverage"        | An 8-axis LLM critique gating a promotion would block nearly everything and would make a judgement load-bearing. Deterministic verdicts gate; critiques inform.             |
| "The test works, I'll skip the review and just commit it"                 | Generated code looks plausible but commonly has weak assertions or hardcoded values. Review is the whole point — promotion without review just imports debt into the suite. |
| "I'll fix the 6 issues I found in the review by editing the test"         | Six issues means the prompt was wrong. Regenerate; hand-edits won't transfer to the next similar test.                                                                      |
| "I'll leave the timestamp header so we know when it was generated"        | Git history already records when the file was committed. The header rots and creates noise.                                                                                 |
| "It passes against staging, that's good enough"                           | If the test only passes in one environment, it's a fixture-bound smoke check, not a regression test. Either parametrize the env or don't promote it.                        |
| "I'll commit it without running the full suite — I only changed one test" | New tests can break shared fixtures, conflict on ports, leak state. Always run the full suite once before commit.                                                           |

## Examples

### Example: Clean promotion

**Source:** `tests/generated/api/orders_post_201.py`, validated, single status
assertion is exactly the contract.

**Action:**

1. `git mv tests/generated/api/orders_post_201.py tests/api/test_orders_post_201.py`
2. Drop the `# Generated by Canary...` header.
3. Adjust import to match `tests/api/conftest.py` fixtures.
4. Run `pytest tests/api/` → passes.
5. Append to `CANARY_STATE.md`: promoted `orders_post_201.py` →
   `tests/api/test_orders_post_201.py` on [date].

### Example: Promotion abandoned — regenerate instead

**Source:** `tests/generated/e2e/checkout.spec.ts`. Review finds: hardcoded test
user creds, no wait for navigation, weak assertion (`expect(true).toBe(true)`),
TODO comments left in three places.

**Action:** Stop. Regenerate with a sharper prompt that names the real fixture
user, specifies the wait condition, and asserts the actual checkout success
state. Do not commit the broken draft.

### Example: Test for throwaway investigation

**Source:** `tests/generated/performance/spike_search_50rps.js`. Used once to
confirm a single perf hypothesis. No ongoing value.

**Action:** Do not promote. Leave in `tests/generated/`. If the team wants
ongoing perf monitoring, generate a _new_ test with a sustainable RPS profile
and promote that.

## Escalation

- **When the review reveals the SUT itself is broken:** Don't promote the test
  that passes against the broken SUT. File a bug; only promote the test once the
  SUT is fixed and the assertion has a real contract behind it.
- **When the suite has no existing convention to match:** This usually means the
  test belongs in a new sub-suite. Ask the user to confirm the suite structure
  before inventing one.
- **When CI doesn't pick up the new path:** Don't merge until CI config matches.
  A test that exists but isn't run is worse than no test — it implies coverage
  that doesn't exist.
- **When the promoted test starts flaking after merge:** Treat as a real
  regression in the test (or the SUT). Don't quarantine in `tests/generated/` —
  fix or delete.
