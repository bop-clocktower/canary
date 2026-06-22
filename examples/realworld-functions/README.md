# Real-World Function Examples

Scenarios based on functions you might actually write — a collection
reconciler, a price normaliser, an access-control checker. No synthetic
"login form" or "checkout endpoint": real domain logic, real edge cases.

Each example is **prompt-only**: the directory contains the prompt to
give Canary plus a README describing the expected shape. No generated
test files are committed — run `/canary-write-test` in Claude Code to
produce fresh output.

## Catalog

| Example | Type | Framework | What it demonstrates |
| ------- | ---- | --------- | -------------------- |
| [lego-tracker-reconcile-collection](lego-tracker-reconcile-collection/) | Unit | Pytest | Pure dict-in / dict-out reconciliation across two data sources |

## How these differ from the top-level examples

The top-level [`examples/`](../) directory shows framework mechanics
(Playwright page-object model, k6 load profiles). These examples start
from **domain logic** — a function signature and its invariants — and let
Canary pick the test approach.

Good for:

- Teams who already know their stack and want to test a specific helper
- Prompts where "just write pytest" is obvious but coverage design is hard
- Demonstrating that Canary understands pure-function contracts, not just
  HTTP interactions

## Adding an example

Copy any existing directory, update `prompt.txt` and `README.md`, and
add a row to this table and to [`examples/README.md`](../README.md).
