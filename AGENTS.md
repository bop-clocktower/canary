# Oracle Knowledge Map

## About This Project

**Oracle** is an AI-powered test automation agent that transforms natural language
requirements into high-quality, framework-aware test code. It follows strict harness
engineering practices for layer isolation and architectural integrity.

## Documentation

- Main docs: `README.md`
- Roadmap: `docs/ORACLE_ROADMAP.md`
- State: `docs/ORACLE_STATE.md`
- Engineering Learnings: `docs/ORACLE_LEARNINGS.md`

## Source Code

- **Entry Point:** `agent/cli.py`
- **Orchestrator:** `agent/core/orchestrator.py`
- **LLM Abstraction:** `agent/llm/`
- **Framework Registry:** `agent/frameworks/registry.json`

## Integration with Harness

Oracle integrates with the **Harness Engineering Ecosystem** by:

1. **Programmatic Access:** Exposing a `--json` flag for machine-readable generation
   outputs
2. **Layered Architecture:** Strictly separating LLM calls from core orchestration
   and CLI logic
3. **Mechanical Verification:** Supporting dry-runs via `--recommend-only` for early
   validation by other harness agents (like `harness-planner`)

## Key Agents

- **Oracle:** The primary test generator.
- **Harness Sub-agents:** Used for architectural enforcement, planning, and
  verification of Oracle's own codebase.
