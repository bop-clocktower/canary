# Harness Engineering Integration 🛡️

Canary is built using **Harness Engineering** principles. This ensures
that the AI agent operates within "mechanical constraints" that prevent
structural decay and architectural drift.

## Core Constraints

Canary uses a `harness.config.json` to enforce strict **Layered
Dependency Rules**:

- **LLM Layer:** Is isolated and forbidden from importing from `core`
  or `cli`.
- **Core Layer:** Depends on `llm` but is isolated from the `cli`.
- **CLI Layer:** Entry point that depends on `core`.

## Verification Protocols

Every milestone in Canary is verified using the **3-Tier Verification
Protocol**:

1. **EXISTS:** Confirming all artifacts are present on disk.
2. **SUBSTANTIVE:** Ensuring the implementation is real and not just a
   "stub" or "TODO."
3. **WIRED:** Verifying the component is integrated, tested, and
   passing all harness validation checks.

## The Knowledge Map (`AGENTS.md`)

The `AGENTS.md` file serves as the "index" for other AI agents to
understand how to interact with Canary. It defines:

- **Programmatic Entry Points:** Like the `--json` flag.
- **Dry-Run Capabilities:** Like the `--recommend-only` flag.
- **Architectural Boundaries:** Ensuring other agents don't violate
  Canary's internal structure.

---

*By adopting these constraints, Canary ensures it remains a robust,
enterprise-grade tool even as it evolves autonomously.*
