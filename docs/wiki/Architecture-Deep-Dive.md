# Architecture Deep Dive 🏗️

Canary follows a strictly layered, modular pipeline. Each component has a single
responsibility, ensuring the system is extensible and vendor-agnostic.

## The Intelligence Pipeline

### 1. Test Classifier (`ts/src/core/classifier.ts`)

The entry point of intelligence. It uses rule-based intent detection to analyze
the user's prompt. It categorizes the request into test types like `e2e_ui`,
`api`, `performance`, or `unit`.

### 2. Framework Recommender (`ts/src/core/recommender.ts`)

The decision engine. It consults the **Framework Registry**
(`ts/src/data/frameworks/registry.json`) to select the best tool for the
detected test type. It considers strengths, maturity, and ecosystem alignment.

### 3. Orchestrator (`ts/src/core/`)

The system kernel. It coordinates the entire flow:

- Receives input.
- Invokes Classifier & Recommender.
- Builds the LLM generation prompt.
- Calls the LLM Client.
- Writes the generated code to the filesystem.
- (Optional) Invokes the Executor for the feedback loop.

### 4. LLM Generation (removed in v3.0)

The old provider abstraction layer (factory + vendor providers) was removed in
v3.0. LLM generation now runs through the host Claude Code session via the
`/canary-write-test` slash command — no provider factory, no vendor clients, and
no API key to configure.

### 5. Test Executor (`ts/src/core/executor.ts`)

The mechanical hand. It runs the generated code in a secure subprocess,
capturing exit codes and standard error for the self-healing loop.

## Data Flow Diagram

`User Prompt` → `CLI` → `Orchestrator` → `Classifier` → `Recommender` → `LLM` →
`Executor` → `Error Feedback` → `LLM (Fix)` → `Final Test Output`

## Security & Sanitization

Canary includes a `_sanitize_extension` layer to prevent path traversal and
ensure that all generated files follow a strict whitelist of allowed extensions
(`.ts`, `.py`, `.js`, etc.).
