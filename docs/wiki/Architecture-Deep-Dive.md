# Architecture Deep Dive 🏗️

Oracle follows a strictly layered, modular pipeline. Each component has
a single responsibility, ensuring the system is extensible and
vendor-agnostic.

## The Intelligence Pipeline

### 1. Test Classifier (`agent/core/classifier.py`)

The entry point of intelligence. It uses rule-based intent detection to
analyze the user's prompt. It categorizes the request into test types
like `e2e_ui`, `api`, `performance`, or `unit`.

### 2. Framework Recommender (`agent/core/recommender.py`)

The decision engine. It consults the **Framework Registry**
(`agent/frameworks/registry.json`) to select the best tool for the
detected test type. It considers strengths, maturity, and ecosystem
alignment.

### 3. Orchestrator (`agent/core/orchestrator.py`)

The system kernel. It coordinates the entire flow:

- Receives input.
- Invokes Classifier & Recommender.
- Builds the LLM generation prompt.
- Calls the LLM Client.
- Writes the generated code to the filesystem.
- (Optional) Invokes the Executor for the feedback loop.

### 4. LLM Client & Factory (`agent/llm/`)

The abstraction layer.

- **Factory:** Dynamically selects the provider (OpenAI, Gemini, Mock).
- **Providers:** Implements specific vendor logic, ensuring the rest of
  the system never "speaks" directly to an API.

### 5. Test Executor (`agent/core/executor.py`)

The mechanical hand. It runs the generated code in a secure subprocess,
capturing exit codes and standard error for the self-healing loop.

## Data Flow Diagram

`User Prompt` → `CLI` → `Orchestrator` → `Classifier` → `Recommender` →
`LLM` → `Executor` → `Error Feedback` → `LLM (Fix)` → `Final Test
Output`

## Security & Sanitization

Oracle includes a `_sanitize_extension` layer to prevent path traversal
and ensure that all generated files follow a strict whitelist of allowed
extensions (`.ts`, `.py`, `.js`, etc.).
