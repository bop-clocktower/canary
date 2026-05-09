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

## 5. Opinionated design improves quality

Oracle intentionally selects frameworks rather than offering all options.
