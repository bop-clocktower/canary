# Oracle — Engineering Learnings

## 1. Registry-driven architecture is foundational

Framework selection is data-driven via registry.json rather than hardcoded logic.

## 2. Separation of concerns is critical

System is split into:

- classifier (intent detection)
- recommender (framework selection)
- orchestrator (workflow engine)
- LLM client (model abstraction)

This prevents logic entanglement and improves extensibility.

## 3. Orchestrator is the system kernel

All execution flows through orchestrator:
User input → classification → recommendation → generation → output

## 4. LLM abstraction is mandatory early

Abstracting model access enables:

- model swapping
- future caching
- prompt centralization
- cleaner architecture

## 6. Lazy LLM initialization is crucial for DX

Coupling module imports to API credential checks breaks non-generative commands
(like `--version`) and unit tests. Initializing the LLM client only at the
moment of execution (lazy loading) ensures the tool remains usable in
restricted or non-connected environments.

## 7. Recommendation-only mode bridges the trust gap

Providing a `--recommend-only` flag allows users to validate Oracle's
engineering decisions before committing to a full generation cycle. This
transparency builds trust and saves tokens.

## 8. Classifier intents must round-trip through the registry

The classifier and the framework registry form an implicit contract: every
`test_type` the classifier can emit must resolve to at least one framework.
When `api` was added to the classifier but no framework declared
`category: "api"`, the recommender silently returned `framework: None` and
the orchestrator wrote `None_test_*.ts` files. Two guardrails now exist:

- Frameworks may declare a `categories` array (in addition to `category`)
  so one framework can serve multiple intents (pytest covers both
  `python_unit` and `api`).
- The orchestrator raises a `ValueError` when the recommender returns
  no framework — failing loudly instead of producing garbage artifacts.

When adding a new classifier branch, add a regression test that asserts the
resulting `framework` is non-null.

## 9. Generated artifacts belong in `.gitignore`

`tests/generated/` is a build output, not source. Committed artifacts
accumulate, churn diffs, and leak prompt content into git history. Keep the
directory tracked (so the orchestrator can write to it) by relying on the
ignore rule plus the orchestrator's `mkdir(parents=True, exist_ok=True)`.

## 10. Use sub-second precision for output filenames

The orchestrator writes one file per run with a timestamped name. Second
resolution (`%Y%m%d_%H%M%S`) collides when tests or scripted runs invoke
generation back-to-back, overwriting prior output. Microsecond resolution
(`%Y%m%d_%H%M%S_%f`) is cheap and removes the foot-gun.
