# Oracle — Roadmap Status

## ✅ Completed / Implemented Core

- **Framework Registry:** JSON-based with multi-extension and execution support.
- **Intelligence Pipeline:** Rule-based classifier + engineering recommender.
- **LLM Abstraction:** Provider-agnostic factory (OpenAI, Mock) with lazy loading.
- **CLI Interface:** `oracle generate` (with `--run`, `--json`) and `oracle run`.
- **Execution Feedback Loop:** MVP self-healing (1 retry) with error feedback.
- **Harness Integration:** Full adoption of "Bombshell" engineering constraints.

## ⏭️ Milestone: Project Intelligence (Context-Awareness)

### TICKET-029 — Metadata Scanning
- Detect local `package.json`, `tsconfig.json`, or `requirements.txt`.
- Align generation with project-specific library versions.

### TICKET-030 — Pattern Matching
- Analyze existing tests in the project.
- Match project-specific coding styles, naming conventions, and helper functions.

### TICKET-031 — Recursive Domain Knowledge
- Scan project directories to understand available components/APIs.
- Inject domain context into generation prompts.

## ⏭️ Milestone: CI/CD & Ecosystem Integration

### TICKET-032 — GitHub Action
- Build an official Oracle GitHub Action.
- Automatically generate tests for new features/bug fixes on PR.

### TICKET-033 — Standardized Reporting
- Export execution results to JSON/SARIF.
- Integrate with external dashboards (Datadog, SonarQube).

### TICKET-034 — Headless Optimizations
- Add CLI flags for CI-specific execution modes.
- Optimize log output for pipeline readability.

## ⏭️ Milestone: Advanced Self-Healing

### TICKET-035 — Multi-step Debugging
- Enable Oracle to search local code or documentation to resolve complex failures.
- Implement iterative debugging (multiple fix attempts).

### TICKET-036 — Visual/DOM Self-Healing
- Use visual snapshots or DOM trees to fix brittle UI selectors automatically.

## ⏭️ Milestone: Developer Experience & Onboarding

### TICKET-037 — Oracle Init (Scaffolding)
- Implement `oracle init <framework>` command.
- Automatically detect environment (`package.json`, `pyproject.toml`).
- Scaffold "Gold Standard" config files and directory structures.
- Ensure alignment with `harness.config.json` layers.

## 🧭 Product Stage

Oracle is currently:
> Autonomous developer CLI tool for test generation and self-healing

Target:
> Fully integrated SDLC partner (CI/CD integration, IDE plugins)
