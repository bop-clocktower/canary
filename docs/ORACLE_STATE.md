# Oracle — Current State

## 🧠 System Status

Oracle is a functional, autonomous test automation CLI. It can classify
user intent, recommend frameworks, generate production-ready code, and
automatically execute/fix tests via its feedback loop.

## ✅ Implemented Components

- **Framework Registry:** registry.json with execution commands and
  multi-extension support.
- **Test Classifier:** Rule-based intent detection.
- **Framework Recommender:** Engineering decision layer.
- **Orchestrator:** End-to-end pipeline with integrated self-healing
  loop.
- **LLM Abstraction:** Provider-agnostic factory (OpenAI, Mock) with
  lazy loading.
- **CLI Interface:** `oracle generate` (with `--run`, `--json`),
  `oracle run`, `oracle version`.
- **Test Executor:** Subprocess-based execution with error capture.

## ⚙️ Architecture Summary

User Prompt → CLI → Orchestrator → Classifier → Recommender → LLM →
Executor → Error Feedback → LLM (Fix) → Final Test Output

## ❗ Current Limitation

Self-healing is limited to 1 retry attempt in the MVP.

## 🎯 Next Step

Deeper integration with the Engineering Harness and CI/CD pipelines.
