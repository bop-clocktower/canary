# IDE Plugins — JetBrains Specification

Phase 2 of the Oracle IDE Plugins initiative. Mirrors the feature surface of
the VS Code extension ([ide-plugins.md](ide-plugins.md)) using IntelliJ
Platform APIs.

## Overview

**Goals:**

1. **In-editor test generation** — Developers generate tests from a natural
   language description without leaving IntelliJ-based IDEs, via Find Action or
   right-click context menu.
2. **Zero-context-switch test execution** — The active test file can be run with
   one action; stdout/stderr streams to the Oracle Tool Window.
3. **Framework scaffolding and migration** — `oracle.init` and `oracle.migrate`
   are accessible from the action system; migration shows a preview before
   applying.
4. **Persistent status visibility** — A status bar widget reflects Oracle's
   current state (Idle / Running / Pass / Fail / Not installed) and opens the
   Tool Window on click.
5. **Native settings UI** — Oracle configuration is exposed through
   **Preferences > Tools > Oracle** using IntelliJ's `Configurable` API.

## Success Criteria

1. **Generate roundtrip:** `oracle.generate` invoked with a non-empty prompt
   produces a file opened in an editor tab; the Oracle Tool Window shows exit
   code 0.
2. **Run result in status bar:** `oracle.run` on a test file updates the status
   bar widget to Pass or Fail within 10 seconds of process exit.
3. **CLI not found — graceful degradation:** When `oracle` is not detected by
   any probe (cliPath, `which`, fallback dirs), all actions are disabled;
   status bar shows "Oracle: not found" with an install-docs notification.
4. **Migration preview:** `oracle.migrate` shows a read-only preview
   (`LightVirtualFile` or scratch file) before applying; no files are modified
   until **Apply Migration** is clicked.
5. **Timeout kill:** `handler.waitFor(120_000L)` returns false → `handler.
   destroyProcess()` is called; a warning balloon is shown; no EDT block.
6. **EDT safety:** No CLI invocation runs on the Event Dispatch Thread; all
   long-running tasks use `Task.Backgroundable` or `executeOnPooledThread`.

## Scope

**Platform:** IntelliJ Platform — IDEA Community/Ultimate, PyCharm, WebStorm,
GoLand, Rider, and any other IntelliJ-based IDE.

**Repository:** `oracle-intellij` (separate repo, mirrors `oracle-vscode`
structure).

**Language:** Kotlin. **Build:** Gradle + IntelliJ Platform Gradle Plugin
(`org.jetbrains.intellij.platform`).

The plugin is intentionally thin: it shells out to the installed `oracle` CLI.
No LLM code lives in the plugin.

## Assumptions

- **Minimum platform version:** IntelliJ Platform 2023.1 (build 231.x).
  Set `since-build = "231"` in `plugin.xml`. This covers IDEA 2023.1,
  PyCharm 2023.1, WebStorm 2023.1, and their contemporaries.
- **`oracle` CLI installed separately:** Users install `oracle` via
  `pip install oracle` or from source. The plugin does not bundle or install
  the CLI.
- **Oracle CLI version:** >= 0.1 (see CLI Resolution for behavior on older
  versions).
- **macOS PATH:** IntelliJ on macOS launches without a login shell; child
  processes do not inherit shell-managed PATH entries (pyenv, asdf, `~/.local/
  bin`). The plugin probes `~/.local/bin` and `/usr/local/bin` as fallbacks.
  Users whose `oracle` is installed via a shell version manager must set
  `oracle.cliPath` explicitly in plugin settings.
- **Java compatibility:** Plugin compiled against JDK 17 (IntelliJ Platform
  2023.1 baseline). `jvmToolchain(17)` in `build.gradle.kts`.
- **Kotlin coroutines:** The plugin uses `kotlinx-coroutines-core` (bundled
  with IntelliJ Platform 2023.1+) for background dispatch. No additional
  coroutines dependency required.

## User Stories

Same U1–U7 as the VS Code spec.

| # | As a developer I want to… | So that… |
| --- | -------------------------- | -------- |
| U1 | generate a test from a natural language description without leaving the editor | I don't break flow context switching to a terminal |
| U2 | right-click a source file and generate a test for it | Oracle can pre-fill the prompt with the file name |
| U3 | run the currently open test file with one keystroke | I get immediate feedback without remembering the exact CLI flags |
| U4 | scaffold a new test suite from the action system | I don't have to look up `oracle init` syntax |
| U5 | migrate a harness project from within the IDE | I can review what would change before applying |
| U6 | see Oracle's status (connected provider, last result) in the status bar | I know at a glance which LLM backend is active |
| U7 | configure Oracle settings in the IDE's native settings UI | I don't have to edit JSON or env vars manually |

## Actions

All actions are registered in `plugin.xml` and appear under **Find Action**
(`⌘⇧A` / `Ctrl+Shift+A`) with the `Oracle:` prefix. Context-menu entries are
registered via `<add-to-group>` in `plugin.xml`.

| Action ID | Title | Entry Points |
| --- | --- | --- |
| `oracle.generate` | Oracle: Generate Test | Find Action, right-click on source file in Project view / editor |
| `oracle.run` | Oracle: Run Test | Find Action, right-click on test file, optional keymap |
| `oracle.init` | Oracle: Init Framework | Find Action |
| `oracle.migrate` | Oracle: Migrate Harness Project | Find Action |
| `oracle.openOutput` | Oracle: Show Output | Find Action, status bar click |

Each action is implemented as a Kotlin class extending `AnAction`. Actions
override `actionPerformed(e: AnActionEvent)` and `update(e: AnActionEvent)`.
Long-running work is dispatched off the EDT.

### `oracle.generate` flow

1. If invoked from a Project view or editor context-menu on a source file,
   pre-populate the dialog with:
   `Generate tests for <filename> —` (cursor after the dash).
2. Show `Messages.showInputDialog(project, "Describe the test you want Oracle
   to generate", "Oracle: Generate Test", ...)`. If the user cancels or
   submits blank/whitespace, silently no-op.
3. Dispatch a pooled-thread task (see Threading). Run:
   `oracle generate "<prompt>" --json`.
4. On success: parse JSON output for `output_file`. Open the file via
   `FileEditorManager.getInstance(project).openFile(virtualFile, true)`.
   Show a balloon notification: "Oracle: Test generated — `<filename>`" with
   an **Open File** action.
5. On error: append raw stderr to the Oracle Tool Window; show an error
   balloon notification.

### `oracle.run` flow

1. Use `e.getData(CommonDataKeys.VIRTUAL_FILE)` to get the active file. If
   null, show an error balloon: "No test file selected. Open a test file or
   right-click one in the Project view."
2. If the file name does not contain `.spec.` or `.test.`, prompt to confirm
   running a non-test file via `Messages.showYesNoDialog`.
3. Infer framework from file extension / workspace config; prompt via
   `Messages.showChooseDialog` if not auto-detectable.
4. Run `oracle run "<file>" <framework>` on a pooled thread.
5. Stream stdout/stderr to the Oracle Tool Window via
   `ProcessListener.onTextAvailable`.
6. On completion, update the status bar widget to Pass or Fail state for
   10 seconds.

### `oracle.init` flow

1. Show a framework chooser via `Messages.showChooseDialog`: `playwright`,
   `vitest`, `pytest`, `k6`.
2. Run `oracle init <framework>` on a pooled thread.
3. Append scaffold output to the Oracle Tool Window.
4. Refresh the project tree: `ProjectView.getInstance(project).refresh()`.

### `oracle.migrate` flow

1. Resolve `project.basePath`. If null (no open project), show error balloon
   and exit.
2. Run `oracle migrate --path <projectRoot> --json` (dry run) on a pooled
   thread.
3. Display the JSON report in a read-only editor tab: open a virtual
   scratch file named `Oracle Migration Preview` using
   `ScratchRootType.getInstance()` or a custom `LightVirtualFile`.
4. Show a notification with **Apply Migration** and **Cancel** actions
   (balloon `addAction`).
5. If Apply Migration: run
   `oracle migrate --path <projectRoot> --apply --json` on a pooled thread.
6. Refresh the VFS: `VirtualFileManager.getInstance().syncRefresh()`.

## Configuration

Settings are registered as a `Configurable` implementation under
**Preferences > Tools > Oracle**. State is stored via a project-level
`@State` / `@Storage` service (or application-level for non-project keys).

| Key | Type | Default | Description |
| --- | ---- | ------- | ----------- |
| `oracle.cliPath` | String | `""` | Absolute path to the `oracle` binary. Empty = auto-detect. |
| `oracle.provider` | Enum | `""` | LLM provider override (`anthropic`, `openai`, `gemini`, `codex`, `mock`). Empty = use `ORACLE_LLM_PROVIDER` env. |
| `oracle.defaultReportFormat` | Enum | `""` | Auto-attach `--report-format` (`json`, `sarif`, or empty). |
| `oracle.showStatusBar` | Boolean | `true` | Show Oracle status bar widget. |
| `oracle.autoOpenGeneratedFile` | Boolean | `true` | Open generated test file after `oracle.generate` succeeds. |

The settings UI is a standard `JPanel` with labeled fields constructed in
`createComponent()`. `isModified()` / `apply()` / `reset()` follow the
`Configurable` contract.

## Tool Window

A dedicated **Oracle** tool window is registered in `plugin.xml` as a
`ToolWindowFactory`. It appears in the bottom stripe of the IDE.

The tool window panel contains:

- A read-only `EditorTextField` (or `ConsoleView`) showing append-only output
- Timestamps and exit codes prepended to each invocation block
- A **Clear** action in the tool window toolbar
- Clickable file paths via IntelliJ's `HyperlinkListener` / console filter

Output persists across invocations for the IDE session. The tool window is
created lazily on first use.

## Status Bar Widget

Registered in `plugin.xml` as a `StatusBarWidgetFactory`. Positioned on the
right side of the status bar.

| State | Text | Tooltip |
| ----- | ---- | ------- |
| Idle | `Oracle` | `Oracle ready — click to open output` |
| Running | `Oracle ↻` | `Oracle: running…` |
| Pass | `Oracle ✓` | `Last run: passed` |
| Fail | `Oracle ✗` | `Last run: failed — click to open output` |
| Not installed | `Oracle: not found` | `oracle CLI not found on PATH. Click to configure.` |

Clicking any state opens the Oracle Tool Window. Widget updates are posted
to the EDT via `StatusBar.updateWidget` called after `invokeLater`.

## CLI Resolution

On project open the plugin's `ProjectManagerListener.projectOpened` (or a
`StartupActivity`) runs `oracle version` using the configured or
auto-detected CLI path.

- **Found:** plugin activates normally; version stored for one-time warning
  check.
- **Not found:** all actions are registered but their `update()` sets
  `e.presentation.isEnabled = false`. Status bar shows "Oracle: not found"
  with a notification linking to install docs.
- **Below minimum (0.1):** a one-time warning notification (stored in
  `PropertiesComponent` to suppress repeats); actions remain enabled.

Auto-detect probe order:

1. `oracle.cliPath` setting (if non-empty)
2. `which oracle` / `where oracle` via a quick shell probe
3. `~/.local/bin/oracle`
4. `/usr/local/bin/oracle`

On macOS, if steps 2–4 fail, the plugin optionally probes via a login shell
(`bash -l -c "which oracle"`) to resolve shell-manager-installed binaries.

## Threading

All CLI invocations run off the EDT:

```kotlin
ApplicationManager.getApplication().executeOnPooledThread {
    val result = runCli(cmd)
    ApplicationManager.getApplication().invokeLater {
        // update UI
    }
}
```

Alternatively, actions can launch a `Task.Backgroundable` (shows progress in
the IDE status bar with cancel support):

```kotlin
object : Task.Backgroundable(project, "Oracle: generating test…", true) {
    override fun run(indicator: ProgressIndicator) {
        val result = runCli(cmd, indicator)
        invokeLater { updateUi(result) }
    }
}.queue()
```

`Task.Backgroundable` is preferred for long-running commands (generate, run,
migrate) because it surfaces a cancellable progress indicator. `executeOnPool
edThread` is acceptable for fast probes (version check, CLI resolution).

## Child Process

CLI invocations use `GeneralCommandLine` + `OSProcessHandler`:

```kotlin
val cmd = GeneralCommandLine(resolvedCliPath, *args)
    .withWorkDirectory(workDir)
    .withEnvironment("ORACLE_LLM_PROVIDER", provider)
    .withCharset(Charsets.UTF_8)

val handler = OSProcessHandler(cmd)
handler.addProcessListener(object : ProcessAdapter() {
    override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
        appendToToolWindow(event.text)
    }
    override fun processTerminated(event: ProcessEvent) {
        handleExit(event.exitCode)
    }
})
handler.startNotify()

// 120-second timeout
if (!handler.waitFor(120_000L)) {
    handler.destroyProcess()
    showTimeoutWarning()
}
```

The `ORACLE_LLM_PROVIDER` environment variable is injected from the
`oracle.provider` setting (if non-empty); otherwise the variable is omitted
and the CLI picks it up from the system environment.

## Error Handling

- **Non-zero exit / spawn failure:** append raw output to Tool Window; show
  error balloon notification. Never throw unhandled exceptions.
- **Prompt cancellation:** silently no-op; do not show an error.
- **Timeout (120 s):** call `handler.destroyProcess()`; show a warning balloon
  "Oracle timed out after 120 seconds."
- **JSON parse failure:** fall back to displaying raw stdout in the Tool
  Window rather than crashing. Log the parse error at `DEBUG` level.
- **`ExecutionException` on spawn:** catch and display the message in a
  balloon; log at `WARN`.

## Architecture

### Project Structure

```text
oracle-intellij/
  build.gradle.kts
  settings.gradle.kts
  gradle/
    wrapper/
  src/
    main/
      kotlin/com/oracle/intellij/
        OraclePlugin.kt          # plugin-level service / startup
        actions/
          GenerateAction.kt
          RunAction.kt
          InitAction.kt
          MigrateAction.kt
          OpenOutputAction.kt
        toolwindow/
          OracleToolWindowFactory.kt
          OracleToolWindowPanel.kt
        statusbar/
          OracleStatusBarWidgetFactory.kt
          OracleStatusBarWidget.kt
        settings/
          OracleSettingsConfigurable.kt
          OracleSettingsState.kt
        runner/
          CliRunner.kt           # GeneralCommandLine wrapper + timeout
          CliResult.kt           # data class: exitCode, stdout, stderr
        util/
          CliResolver.kt         # auto-detect oracle binary
          EnvUtil.kt             # ORACLE_LLM_PROVIDER injection
      resources/META-INF/
        plugin.xml
    test/
      kotlin/com/oracle/intellij/
        runner/CliRunnerTest.kt
        util/CliResolverTest.kt
```

### `plugin.xml` Registrations

```xml
<idea-plugin>
  <id>com.oracle.intellij</id>
  <name>Oracle</name>
  <version>0.1.0</version>
  <depends>com.intellij.modules.platform</depends>

  <extensions defaultExtensionNs="com.intellij">
    <toolWindow id="Oracle" anchor="bottom"
                factoryClass="...OracleToolWindowFactory"/>
    <statusBarWidgetFactory id="oracle.statusBar"
                            implementation="...OracleStatusBarWidgetFactory"/>
    <applicationConfigurable instance="...OracleSettingsConfigurable"
                             displayName="Oracle"
                             groupId="tools"/>
    <projectService serviceImplementation="...OracleSettingsState"/>
  </extensions>

  <actions>
    <action id="oracle.generate" class="...GenerateAction"
            text="Oracle: Generate Test">
      <add-to-group group-id="ProjectViewPopupMenu" anchor="last"/>
      <add-to-group group-id="EditorPopupMenu" anchor="last"/>
    </action>
    <action id="oracle.run" class="...RunAction"
            text="Oracle: Run Test">
      <add-to-group group-id="EditorPopupMenu" anchor="last"/>
    </action>
    <action id="oracle.init" class="...InitAction"
            text="Oracle: Init Framework"/>
    <action id="oracle.migrate" class="...MigrateAction"
            text="Oracle: Migrate Harness Project"/>
    <action id="oracle.openOutput" class="...OpenOutputAction"
            text="Oracle: Show Output"/>
  </actions>
</idea-plugin>
```

## Build and Distribution

- **Build system:** Gradle with `org.jetbrains.intellij.platform` plugin
  (version 2.x).
- **`build.gradle.kts`** declares `intellijPlatform { instrumentationTools() }`
  and sets `sinceBuild = "231"`.
- **Signing:** use `signPlugin { ... }` task with JetBrains marketplace
  certificates (stored as GitHub Actions secrets).
- **Publishing:** `publishPlugin { token = ... }` targets the JetBrains
  Marketplace. CI pipeline: build → test → sign → publish on tag push.
- **CI:** GitHub Actions workflow in `oracle-intellij/.github/workflows/` —
  mirrors the `oracle-vscode` pattern (lint, build, test on push/PR; publish
  on release tag).
- **Versioning:** SemVer, matching the oracle-vscode extension version where
  feasible. `pluginVersion` in `gradle.properties`.

## Out of Scope

- Bundling the Oracle Python package inside the plugin.
- IntelliJ's built-in test runners (JUnit, pytest integration). Oracle runs
  tests via its own executor.
- Web/browser-based IDEs (Theia, Gitpod).
- Automatic Oracle installation from within the plugin.
- `oracle.recommendOnly` / *Oracle: Recommend Framework* action. Deferred per
  S6-001 resolution.
- Android Studio (not an IntelliJ Platform IDE in the same distribution sense;
  may be addressed separately).

## Open Questions

1. **Supported product codes** — Should the plugin declare
   `<depends>com.intellij.modules.java</depends>` (limits to JVM IDEs) or
   stick with `com.intellij.modules.platform` (all IDEs including PyCharm,
   WebStorm)? Platform-only is broader but loses Java PSI utilities.
2. **Tool Window content type** — Plain `EditorTextField` (lightweight) vs
   `ConsoleView` (richer: ANSI colors, clickable stack traces, process filter).
   `ConsoleView` is more powerful but heavier to set up.
3. **macOS login-shell PATH probe** — Should the plugin try
   `bash -l -c "which oracle"` as a fallback? This adds latency on activation
   and may show a terminal flash. Alternative: require explicit `oracle.cliPath`
   and document prominently.
4. **JetBrains Marketplace tier** — Free / open-source plugin or freemium?
   Assumed free for now; revisit if distribution costs become a concern.

## Shared Contract with VS Code Extension

The following are identical in both plugins and must stay in sync:

- **CLI JSON protocol:** same `--json` output shape consumed by both plugins.
- **Config key names:** `oracle.cliPath`, `oracle.provider`,
  `oracle.defaultReportFormat`, `oracle.showStatusBar`,
  `oracle.autoOpenGeneratedFile` — same names, different storage backends.
- **Error handling contract:** 120 s timeout, silent cancel no-op, JSON parse
  fallback, no unhandled exceptions.
- **Status states:** Idle / Running / Pass / Fail / Not installed — same
  semantics, different UI widgets.
- **CLI Resolution probe order:** `cliPath` setting → `which oracle` →
  `~/.local/bin` → `/usr/local/bin` → (macOS) login-shell probe.

## src Reference

*Populated once implementation begins.*
