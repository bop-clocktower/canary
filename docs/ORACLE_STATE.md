# Oracle — Current State

## 🧠 System Status

Oracle is currently a working AI-assisted test automation architecture with an implemented internal intelligence pipeline, but no CLI interface yet.

## ✅ Implemented Components

- Framework registry (registry.json)
- Test classifier (rule-based intent detection)
- Framework recommender (engineering decision layer)
- Orchestrator (end-to-end pipeline)
- LLM abstraction layer (client + service wrapper)

## ⚙️ Architecture Summary

User Prompt → Classifier → Recommender → Orchestrator → LLM → Generated Test Output

## ❗ Current Limitation

System is not yet exposed as a CLI tool. It cannot be executed directly from terminal.

## 🎯 Next Step

Implement CLI layer:

- `oracle generate "<prompt>"`
