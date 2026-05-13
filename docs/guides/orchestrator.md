# Orchestrator Guide

The Oracle Orchestrator is the central execution engine that turns a
natural-language test requirement into a generated, validated test file.
It coordinates the three-stage pipeline — classify, recommend, generate —
and optionally executes the generated test against the recommended
framework.

## Core Concepts

### 1. The Pipeline

The Orchestrator runs a fixed three-stage pipeline per request:

1. **Classify.** A `TestClassifier` reads the user prompt and emits a
   `ClassificationResult` (intent, test_type, confidence). Rule-based
   today; LLM-augmented later.
2. **Recommend.** A `FrameworkRecommender` consults the framework registry
   and returns a concrete framework choice with file extension and
   reasoning.
3. **Generate.** The LLM provider produces the test source;
   `OracleOrchestrator.run` writes it under `tests/generated/`.

Optionally, when invoked with `execute=True`, a `TestExecutor` runs the
produced file using the framework's CLI.

### 2. Registry-Driven Framework Selection

Frameworks are not hard-coded in the orchestrator. They live in
`agent/frameworks/registry.json` and are looked up by `test_type`. The
contract: every classifier output must resolve to a framework — a null
framework is a registry bug and surfaces as a `ValueError` at runtime.

### 3. Pluggable LLM Providers

`agent/llm/factory.py` picks a provider at call time from
`ORACLE_LLM_PROVIDER` env config. Currently supported: `anthropic`
(default), `gemini`, `openai`, `mock`. Providers implement the
`agent/llm/providers/base.py` contract — input prompt and
provider-specific config in, completion string out.

### 4. Generated-Test Conventions

- All generated tests land under `tests/generated/<category>/<slug>.<ext>`
  where category and ext come from the recommender.
- Output is timestamped in the file header for traceability.
- Generated tests are gitignored by default — only commit them when
  intentionally promoting an artifact.

## Pipeline Output

`OracleOrchestrator.run(prompt, execute=False)` returns a dict with:

- `classification` — the `ClassificationResult` (intent, test_type,
  confidence)
- `recommendation` — framework, category, file extension, reasoning
- `output_path` — absolute path of the written test file
- `execution` — present only when `execute=True`: returncode, stdout,
  stderr

This shape is stable; downstream tools (CLI, future dashboard) consume it
directly.

## Getting Started

### 1. Configure Credentials

Set the provider's API key in your environment. For the default
(Anthropic):

```bash
export ANTHROPIC_API_KEY=...
```

### 2. Run a Generation

From the project root:

```bash
python -m agent.cli generate "Test that POST /v1/orders returns 201 with a valid payload"
```

### 3. Inspect the Output

Generated tests appear under `tests/generated/`. The CLI prints the
resolved framework, output path, and (when `--execute` is passed) the
framework's run output.

### 4. Run Generated Tests

Add `--execute` to the CLI invocation, or call
`OracleOrchestrator.run(prompt, execute=True)` programmatically. The
`TestExecutor` resolves the framework's run command from the registry and
invokes it with the generated file path as a single argv element
(path-with-spaces is preserved).

## Failure Modes

- **No framework resolved.** Raised as `ValueError` from `run`. Usually
  means the registry is missing an entry for the classifier's `test_type`
  — fix the registry, not the orchestrator.
- **LLM provider error.** Surfaces as the provider's exception type. The
  orchestrator does not retry — that lives in higher-level orchestration
  (future: self-healing loop).
- **Executor timeout.** Default 30s, configurable per call. Returns
  non-zero `returncode` with the partial stdout/stderr captured.

## Observability

Generated test runs are logged into `docs/ORACLE_STATE.md` for handoff
continuity. The self-healing loop (planned) will write structured failure
entries to `docs/ORACLE_LEARNINGS.md` so subsequent runs can avoid known
traps.

## Related

- [Framework Registry](./framework-registry.md) — registry schema and
  adding new frameworks
- [LLM Providers and Configuration][llm-providers] — provider selection,
  fallback, env vars
- [Self-Healing and Feedback Loop](../wiki/Self-Healing-and-Feedback-Loop.md)
  — failure capture and retry strategy

[llm-providers]: ../wiki/LLM-Providers-and-Configuration.md
