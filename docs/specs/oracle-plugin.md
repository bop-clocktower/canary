# Oracle Claude Code Plugin Specification

Oracle becomes a Claude Code plugin: an MCP server exposing analysis and
execution tools, three skills (`oracle:generate`, `oracle:init`,
`oracle:migrate`), and three thin agents. The Claude Code agent handles test
generation using its own session — no API key required for plugin users. The
existing CLI and GitHub Action are unchanged.

## Scope

**In scope:**

- `agent/mcp_server.py` — FastMCP server exposing six Oracle tools
- `.claude-plugin/plugin.json` — plugin manifest wiring the MCP server,
  skills, and agents
- `.claude-plugin/agents/` — three agent definitions
  (`oracle-test-generator`, `oracle-initializer`, `oracle-migrator`)
- `agents/skills/oracle:generate`, `oracle:init`, `oracle:migrate` — three
  slash-command skills
- CI: JSON Schema validation of `plugin.json` against the Claude Code plugin
  schema
- `tests/unit/test_mcp_server.py` — unit tests for all six MCP tools

**Out of scope:**

- Changes to `oracle generate`, `oracle run`, `oracle init`, `oracle migrate`,
  `oracle setup` CLI commands
- Changes to the GitHub Action
- Changes to oracle-vscode or oracle-intellij plugins
- Hooks (PostToolUse auto-trigger on file write) — follow-on
- Additional skills beyond the initial three — follow-on
- Integration tests that invoke Claude Code with the live plugin — follow-on
- Self-healing in the plugin path — handled by the agent's own reasoning loop,
  no special code required

## Assumptions

- FastMCP (Python MCP SDK) is used for the server; added to `pyproject.toml`
  as a dependency.
- The plugin MCP server runs as a subprocess spawned by Claude Code using
  `python -m agent.mcp_server` from the plugin root.
- `CLAUDE_PLUGIN_ROOT` is set by Claude Code when the plugin is active; the
  MCP server uses it as the working directory.
- CLI users continue to need `ANTHROPIC_API_KEY` — identical to the harness
  orchestrator's Anthropic backend pattern.
- Plugin users need no API key — Claude Code's session provides the LLM.
- The existing `agent/intelligence/`, `agent/frameworks/`, and
  `agent/core/` modules are called directly by the MCP server tools; no
  logic is duplicated.

## Architecture

```text
Claude Code session
│
├── oracle:generate skill  ──► oracle-test-generator agent
├── oracle:init skill      ──► oracle-initializer agent        ◄── user
├── oracle:migrate skill   ──► oracle-migrator agent
│
└── Oracle MCP server (subprocess, python -m agent.mcp_server)
    ├── oracle__analyze_file
    ├── oracle__write_test_file
    ├── oracle__run_tests
    ├── oracle__init_suite
    ├── oracle__list_frameworks
    └── oracle__migrate
         │
         └── agent/intelligence/, agent/frameworks/, agent/core/
              (shared with CLI path — no duplication)

CLI path (unchanged)
└── oracle generate / init / migrate / run / setup
     └── OracleOrchestrator ──► ANTHROPIC_API_KEY ──► Anthropic API
```

## MCP Server Tools

**Location:** `agent/mcp_server.py`

All tools return structured dicts. Errors are returned as MCP error responses
rather than raising Python exceptions — the agent decides how to handle them.

### `oracle__analyze_file`

Input: `file_path: str`

Output:

```json
{
  "framework": "playwright",
  "test_type": "e2e",
  "imports": ["React", "useState"],
  "functions": ["LoginForm", "handleSubmit"],
  "existing_tests": ["tests/login.spec.ts"],
  "context_snippets": ["...relevant source lines..."]
}
```

Calls `MetadataScanner`, `PatternMatcher`, and `DomainScanner` from
`agent/intelligence/`. Returns everything the agent needs to write a
well-targeted test.

### `oracle__write_test_file`

Input: `file_path: str, content: str, framework: str`

Output:

```json
{ "written_path": "tests/login.spec.ts" }
```

Creates parent directories if needed. Overwrites if file already exists.
Framework is used to infer the correct file extension if the path has none.

### `oracle__run_tests`

Input: `test_file: str`

Output:

```json
{
  "passed": 3,
  "failed": 1,
  "output": "...",
  "exit_code": 1
}
```

Never raises on test failure — exit code and output are returned for the agent
to interpret. Uses `OracleTestExecutor` from `agent/core/executor.py`.

### `oracle__init_suite`

Input: `framework: str, target_dir: str`

Output:

```json
{
  "files_created": ["playwright.config.ts", "tests/example.spec.ts"],
  "framework": "playwright"
}
```

Delegates to the same scaffolding logic as `oracle init`. `target_dir`
defaults to `cwd` when empty.

### `oracle__list_frameworks`

Input: none

Output:

```json
{
  "frameworks": ["playwright", "vitest", "pytest", "k6"]
}
```

Returns all frameworks registered in `agent/frameworks/registry.json`.

### `oracle__migrate`

Input: `target_dir: str, apply: bool`

Output:

```json
{
  "framework": "playwright",
  "files_created": ["playwright.config.ts"],
  "files_skipped": ["tests/existing.spec.ts"],
  "manual_followups": ["Remove harness.config.json after verifying migration"],
  "dry_run": true
}
```

`apply` defaults to `false` (dry-run), matching the existing CLI behaviour.
Delegates to `HarnessMigrator` from `agent/core/migrator.py`.

## Plugin Manifest

**Location:** `.claude-plugin/plugin.json`

```json
{
  "$schema": "https://raw.githubusercontent.com/anthropics/claude-code/main/schemas/plugin.schema.json",
  "name": "oracle",
  "version": "1.0.0",
  "description": "AI-powered test generation for Claude Code — generate, init, and migrate test suites via slash commands.",
  "skills": ["./agents/skills"],
  "agents": "./.claude-plugin/agents/",
  "mcpServers": {
    "oracle": {
      "command": "python",
      "args": ["-m", "agent.mcp_server"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}"
    }
  }
}
```

## Agents

Three agent markdown files in `.claude-plugin/agents/`. Each follows the
harness agent pattern: `name`, `description`, `tools` frontmatter, then
role and steps in the body.

### `oracle-test-generator`

Tools: `mcp__oracle__analyze_file`, `mcp__oracle__write_test_file`,
`mcp__oracle__run_tests`, Read, Bash

Steps:

1. Call `oracle__analyze_file` on the target file
2. Generate test content using the analysis output and the skill's prompt
   template
3. Call `oracle__write_test_file` to persist the content
4. Call `oracle__run_tests` on the written file
5. If tests fail, read the output, revise the content, repeat from step 3
   (up to 3 attempts)

### `oracle-initializer`

Tools: `mcp__oracle__init_suite`, `mcp__oracle__list_frameworks`

Steps:

1. If framework not specified, call `oracle__list_frameworks` and ask the
   user to choose
2. Call `oracle__init_suite` with the chosen framework
3. Report created files

### `oracle-migrator`

Tools: `mcp__oracle__migrate`, Read

Steps:

1. Call `oracle__migrate` with `apply=false` (dry-run) and show the plan
2. Ask the user to confirm before applying
3. Call `oracle__migrate` with `apply=true`
4. Report created files, skipped files, and manual follow-ups

## Skills

Three skill files under `agents/skills/`. Each is a short markdown file
with frontmatter (`name`, `description`) and instructions for the agent.

### `oracle:generate`

Invokes `oracle-test-generator` with the active editor file as the target.
Includes the prompt template the agent uses to generate test content:
framework-specific conventions, assertion style, naming patterns extracted
from `oracle__analyze_file`'s `context_snippets`.

### `oracle:init`

Invokes `oracle-initializer`. If the user typed `/oracle:init playwright`,
passes `playwright` directly; otherwise the agent prompts for a framework.

### `oracle:migrate`

Invokes `oracle-migrator` with `cwd` as the target directory.

## Error Handling

| Scenario | Behaviour |
| --- | --- |
| MCP server fails to start | Claude Code surfaces the subprocess error; user sees "oracle MCP server unavailable" |
| `oracle__analyze_file` — file not found | Returns `{error: "file not found: <path>"}` MCP error; agent reports and stops |
| `oracle__run_tests` — test runner not installed | Returns `{exit_code: 127, output: "command not found"}` ; agent advises installing the runner |
| `oracle__migrate` — no harness markers | Returns `{error: "no harness.config.json found"}` MCP error; agent reports |
| Agent test-fix loop exhausted (3 attempts) | Agent reports last failure output and suggests running `oracle run` manually |

## Test Coverage

New file `tests/unit/test_mcp_server.py` (~10 tests). All tool calls use
mocked intelligence modules and file I/O — no real files written.

| Test | What it checks |
| --- | --- |
| `test_analyze_file_returns_framework` | Returns correct framework for a known file |
| `test_analyze_file_missing_file` | Returns MCP error when file not found |
| `test_write_test_file_creates_dirs` | Creates parent directories if missing |
| `test_run_tests_pass` | Returns `exit_code=0` and passed count |
| `test_run_tests_fail` | Returns `exit_code=1` without raising |
| `test_init_suite_creates_files` | Returns list of created scaffold files |
| `test_list_frameworks_returns_all` | Returns all registry frameworks |
| `test_migrate_dry_run` | Returns plan without writing files |
| `test_migrate_apply` | Writes files when `apply=true` |
| `test_mcp_server_tool_error_response` | Tool errors return MCP error, not Python exception |

## src Reference

- [`agent/mcp_server.py`](../../agent/mcp_server.py) — MCP server (new)
- [`.claude-plugin/plugin.json`](../../.claude-plugin/plugin.json) — plugin
  manifest (new)
- [`.claude-plugin/agents/`](../../.claude-plugin/agents/) — agent
  definitions (new)
- [`agents/skills/`](../../agents/skills/) — skill files (new)
- [`tests/unit/test_mcp_server.py`](../../tests/unit/test_mcp_server.py) —
  unit tests (new)
