# Oracle Knowledge Map

## Project Overview

**Oracle** is an AI-powered test automation agent that transforms natural
language requirements into high-quality, framework-aware test code. It follows
strict harness engineering practices for layer isolation and architectural
integrity.

## Documentation

- Main docs: `README.md`
- Roadmap: `docs/roadmap.md`
- State: `docs/ORACLE_STATE.md`
- Engineering Learnings: `docs/ORACLE_LEARNINGS.md`

## Repository Structure

- **Entry Point:** `agent/cli.py`
- **Orchestrator:** `agent/core/orchestrator.py`
- **LLM Abstraction:** `agent/llm/`
- **Framework Registry:** `agent/frameworks/registry.json`

## Integration with Harness

Oracle integrates with the **Harness Engineering Ecosystem** by:

1. **Programmatic Access:** Exposing a `--json` flag for machine-readable
   generation outputs
2. **Layered Architecture:** Strictly separating LLM calls from core
   orchestration and CLI logic
3. **Mechanical Verification:** Supporting dry-runs via `--recommend-only` for
   early validation by other harness agents (like `harness-planner`)

## Development Workflow

1. **Requirement Analysis:** User provides natural language requirements.
2. **Classification:** Oracle identifies the target testing framework and
   language.
3. **Scaffolding:** Oracle generates the initial test structure and
   implementation.
4. **Execution:** Tests are executed using the identified framework.
5. **Iteration:** Based on test results, the process repeats until
   requirements are met.

## Key Agents

- **Oracle:** The primary test generator.
- **Harness Sub-agents:** Used for architectural enforcement, planning, and
  verification of Oracle's own codebase.
