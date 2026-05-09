# Oracle — Roadmap Status

## 🚧 Completed / Implemented Core

- Framework registry (JSON-based)
- Test classifier (rule-based MVP)
- Framework recommender engine
- Orchestrator pipeline
- LLM abstraction layer

## 🚧 Current State

System is fully architected and internally functional.

Missing:

- CLI interface (terminal usability layer)

## ⏭️ Next Milestone: CLI Integration

### TICKET-027 — CLI Interface

- `oracle generate "<prompt>"`
- Connect CLI → orchestrator
- Print structured output
- Write generated files

### TICKET-028 — Execution Feedback Loop (future)

- Run generated tests
- Capture failures
- Feed results back into Oracle for improvement

## 🧭 Product Stage

Oracle is currently:
> Internal AI engineering pipeline (non-user-facing)

Target:
> Fully usable developer CLI tool for test generation and debugging
