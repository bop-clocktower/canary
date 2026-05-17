# IDE Plugins Specification

Expose Oracle's generate / run / init / migrate commands directly inside VS Code
and JetBrains IDEs. The plugins are intentionally thin: they shell out to the
`oracle` CLI already installed on the developer's machine and display results in
native IDE UI (output panels, editor tabs, notifications). No LLM code lives in
the plugin.

## Scope

**Phase 1 — VS Code** (TypeScript, VS Code Extension API)
**Phase 2 — JetBrains** (Kotlin, IntelliJ Platform SDK)

Both phases expose the same feature surface. VS Code ships first because the
extension API is simpler, the marketplace has broader reach, and the team already
works in a TypeScript-capable environment.

## Assumptions

- **VS Code minimum version:** >= 1.85.0 (December 2023 LTS baseline). Set
  `engines.vscode` to `^1.85.0` in `package.json`.
- **`oracle` CLI installed separately:** Users install `oracle` via `pip install
  oracle` or from source before installing the plugin. The plugin does not bundle
  or install the CLI.
- **Oracle CLI version:** >= 0.1 (see CLI Resolution for behavior on older versions).

## User Stories

| # | As a developer I want to… | So that… |
|---|--------------------------|----------|
| U1 | generate a test from a natural language description without leaving the editor | I don't break flow context switching to a terminal |
| U2 | right-click a source file and generate a test for it | Oracle can pre-fill the prompt with the file name and detected component names |
| U3 | run the currently open test file with one keystroke | I get immediate feedback without remembering the exact CLI flags |
| U4 | scaffold a new test suite from the command palette | I don't have to look up `oracle init` syntax |
| U5 | migrate a harness project from within the IDE | I can review what would change in the editor before applying |
| U6 | see Oracle's status (connected provider, last result) in the status bar | I know at a glance which LLM backend is active |
| U7 | configure Oracle settings in the IDE's native settings UI | I don't have to edit JSON or env vars manually |

## Commands

All commands are registered in the Command Palette under the `Oracle:` prefix.

| Command ID | Label | Entry Points |
|---|---|---|
| `oracle.generate` | Oracle: Generate Test | Palette, right-click on source file |
| `oracle.run` | Oracle: Run Test | Palette, editor toolbar (`.spec.*`, `.test.*` files), keybinding |
| `oracle.init` | Oracle: Init Framework | Palette |
| `oracle.migrate` | Oracle: Migrate Harness Project | Palette |
| `oracle.recommendOnly` | Oracle: Recommend Framework | Palette |
| `oracle.openOutput` | Oracle: Show Output | Palette, status bar click |

### `oracle.generate` flow

1. If invoked via right-click on a source file, pre-populate the input box with:
   `Generate tests for <filename> — ` and place cursor after the dash.
2. Show an input box: `Describe the test you want Oracle to generate`.
   If the user dismisses or submits an empty/whitespace-only prompt, silently no-op.
3. Run `oracle generate "<prompt>" --json` in a child process.
4. On success: open the generated file path (from JSON output) in a new editor
   tab. Show a success notification with "Open File" and "Run Now" actions.
5. On error: show the error in the Oracle Output panel and a warning notification.

### `oracle.run` flow

1. If no file argument, use the active editor's file path. If there is no active
   editor, show an error notification: "No test file selected. Open a test file or
   right-click one in the Explorer." If the active file is not a test file (no
   `.spec.` or `.test.` in the name), prompt to select one.
2. Prompt for framework if not auto-detectable from file extension or workspace
   config; otherwise infer silently.
3. Run `oracle run "<file>" <framework> --json`.
4. Stream stdout/stderr to the Oracle Output panel in real time.
5. Show pass/fail in the status bar for 10 seconds after completion.

### `oracle.init` flow

1. Show a Quick Pick: `playwright | vitest | pytest | k6`.
2. Run `oracle init <framework>`.
3. Display scaffold result (created files/dirs) in the Oracle Output panel.

### `oracle.migrate` flow

1. If no workspace folder is open (`vscode.workspace.workspaceFolders` is
   undefined), show an error notification: "oracle migrate requires an open
   workspace folder." Exit.
   Run `oracle migrate --path <workspaceRoot> --json` (dry run).
2. Display the JSON report in a read-only preview editor tab (`Oracle Migration
   Preview`).
3. Show "Apply Migration" and "Cancel" buttons in a notification.
4. If "Apply Migration": run `oracle migrate --path <workspaceRoot> --apply --json`.
5. Refresh the file explorer after apply.

## Configuration

Settings are exposed under the `oracle.*` namespace in VS Code settings /
JetBrains plugin settings.

| Key | Type | Default | Description |
|---|---|---|---|
| `oracle.cliPath` | string | `""` | Absolute path to the `oracle` binary. Empty = auto-detect via `which oracle` / PATH. |
| `oracle.provider` | enum | `""` | LLM provider override (`anthropic`, `openai`, `gemini`, `codex`, `mock`). Empty = use `ORACLE_LLM_PROVIDER` env var. |
| `oracle.defaultReportFormat` | enum | `""` | Auto-attach `--report-format` to generate calls (`json`, `sarif`, or empty for none). |
| `oracle.showStatusBar` | boolean | `true` | Show Oracle status bar item. |
| `oracle.autoOpenGeneratedFile` | boolean | `true` | Automatically open generated test file after `oracle.generate` succeeds. |

## Output Channel

A dedicated **Oracle** output channel (VS Code) / tool window (JetBrains) shows:
- Raw stdout/stderr from every CLI invocation
- Timestamps and exit codes
- Clickable file paths (VS Code terminal link provider)

The channel persists across invocations. A "Clear" button resets it.

## Status Bar Item (VS Code)

Positioned at the right side of the status bar. States:

| State | Text | Tooltip |
|---|---|---|
| Idle | `$(beaker) Oracle` | `Oracle ready — click to open output` |
| Running | `$(sync~spin) Oracle` | `Oracle: running…` |
| Pass | `$(check) Oracle` | `Last run: passed` |
| Fail | `$(error) Oracle` | `Last run: failed — click to open output` |
| Not installed | `$(warning) Oracle: not found` | `oracle CLI not found on PATH. Click to configure.` |

Clicking any state opens the Oracle Output channel.

## CLI Resolution

On activation the plugin runs `oracle --version` (or the configured `oracle.cliPath`).

- If the command succeeds: plugin activates normally.
- If not found: all commands are registered but disabled; the status bar shows
  "Oracle: not found" with a notification linking to install instructions.
- If the version is below the minimum supported (`0.1`): a one-time warning
  notification is shown; commands still work.

## Error Handling

- **Child process errors** (non-zero exit, spawn failure): displayed in the
  Output channel and as a VS Code error notification. Never throw unhandled
  exceptions.
- **Prompt cancellation**: silently no-op; do not show an error.
- **Timeout**: kill the child process after 120 seconds; show a timeout warning.
- **JSON parse failure**: fall back to displaying raw stdout in the Output channel
  rather than crashing.

## Phase 2 — JetBrains

The JetBrains plugin mirrors Phase 1 exactly. Implementation differences:

- Commands registered as `AnAction` subclasses; appear in the IDE's action system
  (right-click menus, Find Action, keymap settings).
- Output shown in a dedicated Tool Window panel (not an output channel).
- Settings exposed via a `Configurable` implementation in Preferences > Tools >
  Oracle.
- Child process management via `GeneralCommandLine` / `OSProcessHandler`.
- Status shown in the status bar widget (`StatusBarWidget`).
- File refresh after migrate uses `LocalFileSystem.getInstance().refresh()`.

Shared: the same JSON protocol with the CLI, the same config key names (mapped to
the JetBrains persistent state store), and the same error handling contract.

## Out of Scope

- Bundling the Oracle Python package inside the plugin. The CLI must be installed
  separately (`pip install oracle` or from source).
- IntelliJ IDEA language-specific test runners (JUnit, pytest integration via
  IntelliJ's built-in runner). Oracle runs tests via its own executor.
- Web/browser-based IDEs (Theia, Gitpod). May be addressed in a future spec.
- Automatic Oracle installation from within the plugin.

## Open Questions

1. **Keybinding defaults** — Should `oracle.run` have a default keybinding
   (e.g. `⌘⇧T`)? Risk of conflicting with existing bindings; may be better to
   ship with no default and let users assign.
2. **Multi-root workspaces** — When VS Code has multiple workspace folders, which
   root does `oracle migrate` target? Options: (a) always the first root, (b)
   prompt the user, (c) the root containing the active editor file.
3. **Streaming vs batch** — `oracle run` currently returns all output on exit.
   A future `--stream` flag on the CLI would enable real-time output in the
   plugin. Spec assumes batch for now; streaming is a follow-up.
4. **JetBrains marketplace tier** — Free plugin or freemium? Assumed free/open
   for now; revisit if distribution costs become a concern.

## Implementation Notes

- Both plugins should be separate repositories:
  `oracle-vscode` and `oracle-intellij`, each with their own CI.
- The VS Code extension entry point activates on the `oracle.*` command trigger
  (lazy activation), not on workspace open, to avoid startup cost.
- Use `vsce package` + GitHub Actions for VS Code marketplace publishing.
- Use Gradle + `publishPlugin` (JetBrains Marketplace) for IntelliJ.

## src Reference

_Populated once implementation begins._
