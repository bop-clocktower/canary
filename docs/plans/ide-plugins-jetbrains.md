# Implementation Plan — Oracle JetBrains Plugin

**Spec:** [docs/specs/ide-plugins-jetbrains.md](../specs/ide-plugins-jetbrains.md)
**Repo:** `oracle-intellij` (separate repository)
**Target:** IntelliJ Platform 2023.1+ (build 231) | Kotlin | Gradle

## Decisions Made in This Plan

| # | Decision | Choice | Rationale |
| --- | ---------- | ------ | --------- |
| D1 | Tool Window content type | `ConsoleView` | ANSI colors, clickable stack traces, and process console filters come for free; setup cost is worth it |
| D2 | Threading for user actions | `Task.Backgroundable` | Surfaces a cancellable progress bar in the IDE status bar at zero extra cost; `executeOnPooledThread` reserved for version-probe and short background checks |
| D3 | macOS login-shell PATH probe | Implement with 3 s timeout | Acceptable latency during project open; avoids forcing users to set `oracle.cliPath` on pyenv/asdf machines |
| D4 | Supported product codes | `com.intellij.modules.platform` | Broadest reach (IDEA, PyCharm, WebStorm, GoLand, Rider); no PSI APIs needed |
| D5 | Keybinding for `oracle.run` | No default | Same call as VS Code D1 — conflict risk too high; users assign via keymap |

## File Map

```text
oracle-intellij/
├── .github/workflows/
│   ├── ci.yml                   # build + test on PR
│   └── publish.yml              # sign + publish on tag
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties            # pluginVersion, platformVersion
├── gradle/wrapper/
├── src/
│   ├── main/
│   │   ├── kotlin/com/oracle/intellij/
│   │   │   ├── OraclePlugin.kt          # ProjectActivity — startup probe
│   │   │   ├── actions/
│   │   │   │   ├── GenerateAction.kt
│   │   │   │   ├── RunAction.kt
│   │   │   │   ├── InitAction.kt
│   │   │   │   ├── MigrateAction.kt
│   │   │   │   └── OpenOutputAction.kt
│   │   │   ├── toolwindow/
│   │   │   │   ├── OracleToolWindowFactory.kt
│   │   │   │   └── OracleToolWindowPanel.kt
│   │   │   ├── statusbar/
│   │   │   │   ├── OracleStatusBarWidgetFactory.kt
│   │   │   │   └── OracleStatusBarWidget.kt
│   │   │   ├── settings/
│   │   │   │   ├── OracleSettingsState.kt
│   │   │   │   └── OracleSettingsConfigurable.kt
│   │   │   └── runner/
│   │   │       ├── CliResult.kt
│   │   │       ├── CliRunner.kt
│   │   │       └── CliResolver.kt
│   │   └── resources/META-INF/
│   │       └── plugin.xml
│   └── test/
│       └── kotlin/com/oracle/intellij/
│           ├── runner/
│           │   ├── CliResolverTest.kt
│           │   └── CliRunnerTest.kt
│           └── actions/
│               ├── GenerateActionTest.kt
│               ├── RunActionTest.kt
│               ├── InitActionTest.kt
│               └── MigrateActionTest.kt
└── README.md
```

## Tasks

---

### Task 1 — Project Scaffold

**Inputs:** None
**Outputs:** `oracle-intellij/` repo with Gradle build, empty plugin stub,
CI skeleton

**`settings.gradle.kts`:**

```kotlin
rootProject.name = "oracle-intellij"
```

**`gradle.properties`:**

```properties
pluginVersion=0.1.0
platformVersion=2023.1
sinceBuild=231
untilBuild=251.*
```

**`build.gradle.kts`** (key excerpts):

```kotlin
plugins {
    id("org.jetbrains.kotlin.jvm") version "1.9.23"
    id("org.jetbrains.intellij.platform") version "2.3.0"
}

group = "com.oracle"
version = providers.gradleProperty("pluginVersion")

kotlin { jvmToolchain(17) }

intellijPlatform {
    pluginConfiguration {
        name = "Oracle"
        ideaVersion {
            sinceBuild = providers.gradleProperty("sinceBuild")
            untilBuild = providers.gradleProperty("untilBuild")
        }
    }
    signing {
        certificateChain = System.getenv("CERTIFICATE_CHAIN")
        privateKey = System.getenv("PRIVATE_KEY")
        password = System.getenv("PRIVATE_KEY_PASSWORD")
    }
    publishing {
        token = System.getenv("PUBLISH_TOKEN")
    }
    instrumentationTools()
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity(providers.gradleProperty("platformVersion"))
        bundledPlugins("com.intellij.java")
        pluginVerifier()
        zipSigner()
    }
}
```

**`plugin.xml`** stub (full registrations added in later tasks):

```xml
<idea-plugin>
  <id>com.oracle.intellij</id>
  <name>Oracle</name>
  <vendor>bri-stevenski</vendor>
  <depends>com.intellij.modules.platform</depends>
  <description>AI-powered test generation via the Oracle CLI.</description>
</idea-plugin>
```

**`OraclePlugin.kt`** stub:

```kotlin
package com.oracle.intellij

class OraclePlugin : com.intellij.openapi.startup.ProjectActivity {
    override suspend fun execute(project: com.intellij.openapi.project.Project) {}
}
```

**Verify:** `./gradlew buildPlugin` exits 0 (produces a valid ZIP).

---

### Task 2 — Settings State and Configurable

**Depends on:** Task 1
**Outputs:** `settings/OracleSettingsState.kt`,
`settings/OracleSettingsConfigurable.kt`

**`OracleSettingsState.kt`:**

```kotlin
package com.oracle.intellij.settings

import com.intellij.openapi.components.*

@State(name = "OracleSettings", storages = [Storage("oracle.xml")])
@Service(Service.Level.APP)
class OracleSettingsState : PersistentStateComponent<OracleSettingsState.State> {

    data class State(
        var cliPath: String = "",
        var provider: String = "",
        var defaultReportFormat: String = "",
        var showStatusBar: Boolean = true,
        var autoOpenGeneratedFile: Boolean = true,
    )

    private var state = State()

    override fun getState(): State = state
    override fun loadState(s: State) { state = s }

    companion object {
        fun getInstance(): OracleSettingsState =
            service<OracleSettingsState>()
    }
}
```

**`OracleSettingsConfigurable.kt`** (key structure):

```kotlin
class OracleSettingsConfigurable : Configurable {
    private val panel = OracleSettingsPanel()

    override fun getDisplayName() = "Oracle"
    override fun createComponent(): JComponent = panel.root
    override fun isModified(): Boolean = panel.isModified(settings())
    override fun apply() { panel.applyTo(settings()) }
    override fun reset() { panel.resetFrom(settings()) }

    private fun settings() = OracleSettingsState.getInstance().state
}
```

`OracleSettingsPanel` is a `JPanel` with:

- `JTextField` for `cliPath` (labeled "CLI path")
- `JComboBox<String>` for `provider`
  (`["", "anthropic", "openai", "gemini", "codex", "mock"]`)
- `JComboBox<String>` for `defaultReportFormat` (`["", "json", "sarif"]`)
- `JCheckBox` for `showStatusBar`
- `JCheckBox` for `autoOpenGeneratedFile`

Register in `plugin.xml`:

```xml
<extensions defaultExtensionNs="com.intellij">
  <applicationService
      serviceImplementation="com.oracle.intellij.settings.OracleSettingsState"/>
  <applicationConfigurable
      instance="com.oracle.intellij.settings.OracleSettingsConfigurable"
      displayName="Oracle"
      groupId="tools"/>
</extensions>
```

**Verify:** `./gradlew buildPlugin` exits 0. Settings panel appears in
**Preferences > Tools > Oracle**.

---

### Task 3 — CLI Resolver

**Depends on:** Task 2
**Outputs:** `runner/CliResolver.kt`

```kotlin
package com.oracle.intellij.runner

import com.intellij.openapi.util.SystemInfo
import java.io.File

data class CliResolution(
    val found: Boolean,
    val path: String,
    val version: String = "",
    val tooOld: Boolean = false,
)

object CliResolver {

    private val FALLBACKS = listOf(
        "${System.getProperty("user.home")}/.local/bin/oracle",
        "/usr/local/bin/oracle",
    )
    private const val MIN_VERSION = "0.1"

    fun resolve(configuredPath: String): CliResolution {
        val candidates = buildList {
            if (configuredPath.isNotBlank()) add(configuredPath)
            add(if (SystemInfo.isWindows) "oracle.exe" else "oracle")
            addAll(FALLBACKS)
            if (SystemInfo.isMac) add(loginShellProbe())
        }.filterNotNull().distinct()

        for (candidate in candidates) {
            val ver = probe(candidate) ?: continue
            return CliResolution(
                found = true,
                path = candidate,
                version = ver,
                tooOld = compareVersions(ver, MIN_VERSION) < 0,
            )
        }
        return CliResolution(found = false, path = configuredPath.ifBlank { "oracle" })
    }

    private fun probe(path: String): String? = runCatching {
        val proc = ProcessBuilder(path, "version")
            .redirectErrorStream(true)
            .start()
        val ok = proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
        if (!ok || proc.exitValue() != 0) return null
        proc.inputStream.bufferedReader().readLine()?.trim()
    }.getOrNull()

    private fun loginShellProbe(): String? = runCatching {
        val proc = ProcessBuilder("bash", "-l", "-c", "which oracle")
            .redirectErrorStream(true)
            .start()
        val ok = proc.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)
        if (!ok || proc.exitValue() != 0) return null
        proc.inputStream.bufferedReader().readLine()?.trim()
    }.getOrNull()

    private fun compareVersions(a: String, b: String): Int {
        fun parts(v: String) = v.split(".").mapNotNull { it.toIntOrNull() }
        val ap = parts(a); val bp = parts(b)
        for (i in 0 until maxOf(ap.size, bp.size)) {
            val diff = (ap.getOrElse(i) { 0 }) - (bp.getOrElse(i) { 0 })
            if (diff != 0) return diff
        }
        return 0
    }
}
```

**Verify:** `./gradlew test --tests "*.CliResolverTest"` green. Unit tests
cover: found on PATH; not found all candidates; found in fallback; tooOld
when version `"0.0.9"`.

---

### Task 4 — CliResult and CliRunner

**Depends on:** Task 2
**Outputs:** `runner/CliResult.kt`, `runner/CliRunner.kt`

**`CliResult.kt`:**

```kotlin
package com.oracle.intellij.runner

data class CliResult(
    val exitCode: Int,
    val stdout: String,
    val stderr: String,
    val timedOut: Boolean = false,
)
```

**`CliRunner.kt`:**

```kotlin
package com.oracle.intellij.runner

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.*
import com.oracle.intellij.settings.OracleSettingsState
import java.util.concurrent.TimeUnit

object CliRunner {

    fun run(
        args: List<String>,
        workDir: String?,
        onText: (String) -> Unit = {},
    ): CliResult {
        val settings = OracleSettingsState.getInstance().state
        val binary = settings.cliPath.ifBlank { "oracle" }

        val cmd = GeneralCommandLine(listOf(binary) + args)
            .withCharset(Charsets.UTF_8)
            .apply {
                if (workDir != null) withWorkDirectory(workDir)
                if (settings.provider.isNotBlank())
                    withEnvironment("ORACLE_LLM_PROVIDER", settings.provider)
                // inject defaultReportFormat when running generate
                if (args.firstOrNull() == "generate"
                        && settings.defaultReportFormat.isNotBlank()) {
                    // appended via args at call site (see GenerateAction)
                }
            }

        val stdout = StringBuilder()
        val stderr = StringBuilder()

        return try {
            val handler = OSProcessHandler(cmd)
            handler.addProcessListener(object : ProcessAdapter() {
                override fun onTextAvailable(e: ProcessEvent, type: Key<*>) {
                    val text = e.text
                    if (type === ProcessOutputTypes.STDERR) stderr.append(text)
                    else stdout.append(text)
                    onText(text)
                }
            })
            handler.startNotify()

            val finished = handler.waitFor(120_000L)
            if (!finished) {
                handler.destroyProcess()
                return CliResult(-1, stdout.toString(), stderr.toString(),
                    timedOut = true)
            }
            CliResult(handler.exitCode ?: -1, stdout.toString(),
                stderr.toString())
        } catch (ex: ExecutionException) {
            CliResult(-1, "", ex.message ?: "spawn failed")
        }
    }
}
```

**Verify:** `./gradlew test --tests "*.CliRunnerTest"` green. Tests (using
`ProcessBuilder` mock or a real `echo` subprocess): env injection, timeout
path, non-zero exit.

---

### Task 5 — Tool Window

**Depends on:** Task 1
**Outputs:** `toolwindow/OracleToolWindowFactory.kt`,
`toolwindow/OracleToolWindowPanel.kt`,
`toolwindow/OracleToolWindowService.kt`

**`OracleToolWindowPanel.kt`:**

```kotlin
package com.oracle.intellij.toolwindow

import com.intellij.execution.ui.ConsoleView
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.openapi.project.Project
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

class OracleToolWindowPanel(project: Project) {

    val consoleView: ConsoleView =
        com.intellij.execution.impl.ConsoleViewImpl(project, true)

    private val ts get() =
        LocalDateTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"))

    fun append(text: String) {
        consoleView.print("[$ts] $text", ConsoleViewContentType.NORMAL_OUTPUT)
    }

    fun appendError(text: String) {
        consoleView.print("[$ts] $text", ConsoleViewContentType.ERROR_OUTPUT)
    }

    fun clear() { consoleView.clear() }
}
```

**`OracleToolWindowFactory.kt`:**

```kotlin
class OracleToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, tw: ToolWindow) {
        val panel = OracleToolWindowPanel(project)
        project.getService(OracleToolWindowService::class.java)
            .initialize(panel)

        val content = ContentFactory.getInstance()
            .createContent(panel.consoleView.component, "", false)
        tw.contentManager.addContent(content)

        // Clear action in toolbar
        val clearAction = object : AnAction("Clear", "", AllIcons.Actions.GC) {
            override fun actionPerformed(e: AnActionEvent) { panel.clear() }
        }
        tw.setTitleActions(listOf(clearAction))
    }
}
```

**`OracleToolWindowService.kt`:**

```kotlin
package com.oracle.intellij.toolwindow

import com.intellij.openapi.application.invokeLater
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager

@Service(Service.Level.PROJECT)
class OracleToolWindowService(private val project: Project) {

    private var panel: OracleToolWindowPanel? = null

    fun initialize(p: OracleToolWindowPanel) { panel = p }

    // All methods guard with invokeLater — actions call these from
    // background threads (Task.Backgroundable).
    fun append(text: String) { invokeLater { panel?.append(text) } }
    fun appendError(text: String) { invokeLater { panel?.appendError(text) } }
    fun clear() { invokeLater { panel?.clear() } }
    fun show() {
        invokeLater {
            ToolWindowManager.getInstance(project)
                .getToolWindow("Oracle")?.show()
        }
    }
}
```

Register in `plugin.xml`:

```xml
<toolWindow id="Oracle" anchor="bottom" secondary="false"
            factoryClass="com.oracle.intellij.toolwindow.OracleToolWindowFactory"
            icon="/icons/oracle.svg"/>
<projectService
    serviceImplementation="com.oracle.intellij.toolwindow.OracleToolWindowService"/>
```

**Verify:** `./gradlew buildPlugin` exits 0. Tool window appears in the
bottom stripe when plugin is installed in a sandbox IDE.

---

### Task 6 — Status Bar Widget

**Depends on:** Task 1
**Outputs:** `statusbar/OracleStatusBarWidgetFactory.kt`,
`statusbar/OracleStatusBarWidget.kt`

```kotlin
package com.oracle.intellij.statusbar

import com.intellij.openapi.application.invokeLater
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.*
import java.util.Timer
import java.util.TimerTask

enum class OracleWidgetState { IDLE, RUNNING, PASS, FAIL, NOT_FOUND }

class OracleStatusBarWidget(private val project: Project)
    : StatusBarWidget, StatusBarWidget.TextPresentation {

    private var state = OracleWidgetState.IDLE
    private var statusBar: StatusBar? = null
    private var resetTimer: Timer? = null

    override fun ID() = "oracle.statusBar"
    override fun getPresentation() = this

    override fun getText() = when (state) {
        OracleWidgetState.IDLE      -> "Oracle"
        OracleWidgetState.RUNNING   -> "Oracle ↻"
        OracleWidgetState.PASS      -> "Oracle ✓"
        OracleWidgetState.FAIL      -> "Oracle ✗"
        OracleWidgetState.NOT_FOUND -> "Oracle: not found"
    }

    override fun getTooltipText() = when (state) {
        OracleWidgetState.IDLE      -> "Oracle ready — click to open output"
        OracleWidgetState.RUNNING   -> "Oracle: running…"
        OracleWidgetState.PASS      -> "Last run: passed"
        OracleWidgetState.FAIL      -> "Last run: failed — click to open output"
        OracleWidgetState.NOT_FOUND ->
            "oracle CLI not found on PATH. Click to configure."
    }

    override fun getClickConsumer() = com.intellij.util.Consumer<java.awt.event.MouseEvent> {
        com.intellij.openapi.wm.ToolWindowManager
            .getInstance(project).getToolWindow("Oracle")?.show()
    }

    fun setState(s: OracleWidgetState) {
        resetTimer?.cancel()
        state = s
        invokeLater { statusBar?.updateWidget(ID()) }
        if (s == OracleWidgetState.PASS || s == OracleWidgetState.FAIL) {
            resetTimer = Timer(true)
            resetTimer!!.schedule(object : TimerTask() {
                override fun run() { setState(OracleWidgetState.IDLE) }
            }, 10_000L)
        }
    }

    override fun install(bar: StatusBar) { statusBar = bar }
    override fun dispose() { resetTimer?.cancel() }
}

class OracleStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = "oracle.statusBar"
    override fun getDisplayName() = "Oracle"
    override fun isAvailable(project: Project) =
        OracleSettingsState.getInstance().state.showStatusBar
    override fun createWidget(project: Project) = OracleStatusBarWidget(project)
    override fun disposeWidget(widget: StatusBarWidget) = widget.dispose()
    override fun canBeEnabledOn(bar: StatusBar) = true
}
```

Register in `plugin.xml`:

```xml
<statusBarWidgetFactory
    id="oracle.statusBar"
    implementation="com.oracle.intellij.statusbar.OracleStatusBarWidgetFactory"
    order="last"/>
```

**Verify:** `./gradlew buildPlugin` exits 0. Status bar item appears at
right of status bar in sandbox IDE.

---

### Task 7 — `OracleGenerateAction`

**Depends on:** Tasks 4, 5, 6
**Outputs:** `actions/GenerateAction.kt`

```kotlin
class GenerateAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val prefill = if (file != null && !file.isDirectory)
            "Generate tests for ${file.name} — " else ""

        val prompt = Messages.showInputDialog(
            project,
            "Describe the test you want Oracle to generate",
            "Oracle: Generate Test",
            null, prefill, null,
        ) ?: return
        if (prompt.isBlank()) return

        val settings = OracleSettingsState.getInstance().state
        val extraArgs = if (settings.defaultReportFormat.isNotBlank())
            listOf("--report-format", settings.defaultReportFormat) else emptyList()

        val tw = project.getService(OracleToolWindowService::class.java)
        val sb = project.getService(OracleStatusBarService::class.java)

        object : Task.Backgroundable(project, "Oracle: generating test…", false) {
            override fun run(indicator: ProgressIndicator) {
                sb.setState(OracleWidgetState.RUNNING)
                val result = CliRunner.run(
                    listOf("generate", prompt, "--json") + extraArgs,
                    project.basePath,
                ) { tw.append(it) }

                invokeLater {
                    sb.setState(OracleWidgetState.IDLE)
                    when {
                        result.timedOut -> showWarning(project,
                            "Oracle timed out after 120 seconds.")
                        result.exitCode != 0 -> {
                            tw.appendError(result.stderr)
                            showError(project, "Oracle generation failed. See Oracle output.")
                        }
                        else -> handleSuccess(project, result.stdout, settings, tw)
                    }
                }
            }
        }.queue()
    }

    private fun handleSuccess(
        project: Project, stdout: String,
        settings: OracleSettingsState.State,
        tw: OracleToolWindowService,
    ) {
        val json = runCatching {
            com.google.gson.JsonParser.parseString(stdout).asJsonObject
        }.getOrElse {
            tw.append(stdout); return
        }
        val outputFile = json.get("output_file")?.asString ?: return
        val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
            .refreshAndFindFileByPath(outputFile) ?: return

        if (settings.autoOpenGeneratedFile) {
            FileEditorManager.getInstance(project).openFile(vf, true)
        }

        NotificationGroupManager.getInstance()
            .getNotificationGroup("Oracle")
            .createNotification("Test generated: ${vf.name}",
                NotificationType.INFORMATION)
            .addAction(object : AnAction("Open File") {
                override fun actionPerformed(e: AnActionEvent) {
                    FileEditorManager.getInstance(project).openFile(vf, true)
                }
            })
            .notify(project)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled =
            project.getService(OracleStatusBarService::class.java).isCliFound()
    }
}
```

Register in `plugin.xml` (under `<actions>`):

```xml
<action id="oracle.generate" class="...GenerateAction"
        text="Oracle: Generate Test"
        description="Generate a test using the Oracle CLI">
  <add-to-group group-id="ProjectViewPopupMenu" anchor="last"/>
  <add-to-group group-id="EditorPopupMenu" anchor="last"/>
</action>
```

**Verify:** `./gradlew test --tests "*.GenerateActionTest"` green. Key test
cases: empty prompt is no-op; right-click pre-fill; success opens file;
JSON parse failure falls back to raw output; timeout shows warning.

---

### Task 8 — `OracleRunAction`

**Depends on:** Tasks 4, 5, 6
**Outputs:** `actions/RunAction.kt`

Flow mirrors spec §`oracle.run` flow. Framework inference probe order:
`playwright.config.*` → `playwright`, `vitest.config.*` → `vitest`,
`pytest.ini` / `pyproject.toml [tool.pytest.ini_options]` → `pytest`,
`k6.config.js` → `k6`.

```kotlin
class RunAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val vf = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: run {
            showError(project, "No test file selected."); return
        }
        if (!vf.name.contains(".spec.") && !vf.name.contains(".test.")) {
            val ok = Messages.showYesNoDialog(
                project, "Run ${vf.name} as a test file?",
                "Oracle: Run Test", null)
            if (ok != Messages.YES) return
        }

        val framework = inferFramework(project) ?: Messages.showChooseDialog(
            project, "Select framework", "Oracle: Run Test", null,
            arrayOf("playwright", "vitest", "pytest", "k6"), "playwright",
        ) ?: return

        val tw = project.getService(OracleToolWindowService::class.java)
        val sb = project.getService(OracleStatusBarService::class.java)
        tw.show()

        object : Task.Backgroundable(project, "Oracle: running test…", false) {
            override fun run(indicator: ProgressIndicator) {
                sb.setState(OracleWidgetState.RUNNING)
                val result = CliRunner.run(
                    listOf("run", vf.path, framework),
                    project.basePath,
                ) { tw.append(it) }
                invokeLater {
                    val next = if (result.timedOut || result.exitCode != 0)
                        OracleWidgetState.FAIL else OracleWidgetState.PASS
                    sb.setState(next)
                    if (result.timedOut)
                        showWarning(project, "Oracle timed out after 120 seconds.")
                }
            }
        }.queue()
    }

    private fun inferFramework(project: Project): String? {
        val base = project.basePath ?: return null
        val root = java.io.File(base)
        return when {
            root.walk().maxDepth(1).any { it.name.startsWith("playwright.config") }
                -> "playwright"
            root.walk().maxDepth(1).any { it.name.startsWith("vitest.config") }
                -> "vitest"
            root.resolve("pytest.ini").exists()
                || (root.resolve("pyproject.toml").exists()
                    && root.resolve("pyproject.toml").readText()
                        .contains("[tool.pytest.ini_options]"))
                -> "pytest"
            root.resolve("k6.config.js").exists() -> "k6"
            else -> null
        }
    }
}
```

Register in `plugin.xml`:

```xml
<action id="oracle.run" class="...RunAction" text="Oracle: Run Test">
  <add-to-group group-id="EditorPopupMenu" anchor="last"/>
</action>
```

**Verify:** `./gradlew test --tests "*.RunActionTest"` green. Cases: no
file → error; framework inferred; Quick Pick when not detected; pass/fail
state set.

---

### Task 9 — `OracleInitAction`

**Depends on:** Tasks 4, 5
**Outputs:** `actions/InitAction.kt`

```kotlin
class InitAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val framework = Messages.showChooseDialog(
            project,
            "Select framework to scaffold",
            "Oracle: Init Framework",
            null,
            arrayOf("playwright", "vitest", "pytest", "k6"),
            "playwright",
        ) ?: return

        val tw = project.getService(OracleToolWindowService::class.java)
        object : Task.Backgroundable(project, "Oracle: scaffolding…", false) {
            override fun run(indicator: ProgressIndicator) {
                val result = CliRunner.run(
                    listOf("init", framework), project.basePath
                ) { tw.append(it) }
                invokeLater {
                    if (result.exitCode != 0)
                        showError(project, "oracle init failed. See Oracle output.")
                    else
                        ProjectView.getInstance(project).refresh()
                }
            }
        }.queue()
    }
}
```

Register in `plugin.xml`:

```xml
<action id="oracle.init" class="...InitAction"
        text="Oracle: Init Framework"/>
```

**Verify:** `./gradlew test --tests "*.InitActionTest"` green. Cases:
chooser cancelled → no-op; framework passed to runner; project tree
refreshed on success.

---

### Task 10 — `OracleMigrateAction`

**Depends on:** Tasks 4, 5
**Outputs:** `actions/MigrateAction.kt`

```kotlin
class MigrateAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val root = project.basePath ?: run {
            showError(project, "oracle migrate requires an open project."); return
        }
        val tw = project.getService(OracleToolWindowService::class.java)

        object : Task.Backgroundable(project, "Oracle: dry-run migrate…", false) {
            override fun run(indicator: ProgressIndicator) {
                val dry = CliRunner.run(
                    listOf("migrate", "--path", root, "--json"),
                    root,
                ) { tw.append(it) }

                if (dry.timedOut || dry.exitCode != 0) {
                    invokeLater { showError(project,
                        "oracle migrate failed. See Oracle output.") }
                    return
                }

                val pretty = runCatching {
                    val obj = com.google.gson.JsonParser.parseString(dry.stdout)
                    com.google.gson.GsonBuilder().setPrettyPrinting()
                        .create().toJson(obj)
                }.getOrElse { dry.stdout }

                invokeLater { showPreview(project, root, pretty, tw) }
            }
        }.queue()
    }

    private fun showPreview(
        project: Project, root: String,
        pretty: String, tw: OracleToolWindowService,
    ) {
        val vf = com.intellij.testFramework.LightVirtualFile(
            "Oracle Migration Preview", pretty)
        FileEditorManager.getInstance(project).openFile(vf, true)

        NotificationGroupManager.getInstance()
            .getNotificationGroup("Oracle")
            .createNotification("Migration preview ready.",
                NotificationType.INFORMATION)
            .addAction(object : AnAction("Apply Migration") {
                override fun actionPerformed(e: AnActionEvent) {
                    object : Task.Backgroundable(project,
                        "Oracle: applying migration…", false) {
                        override fun run(indicator: ProgressIndicator) {
                            CliRunner.run(
                                listOf("migrate", "--path", root,
                                    "--apply", "--json"),
                                root,
                            ) { tw.append(it) }
                            invokeLater {
                                VirtualFileManager.getInstance().syncRefresh()
                            }
                        }
                    }.queue()
                }
            })
            .notify(project)
    }
}
```

Register in `plugin.xml`:

```xml
<action id="oracle.migrate" class="...MigrateAction"
        text="Oracle: Migrate Harness Project"/>
```

**Verify:** `./gradlew test --tests "*.MigrateActionTest"` green. Cases:
null basePath → error; dry run preview opened; Apply runs apply command;
VFS refreshed; Cancel is no-op.

---

### Task 11 — `OracleOpenOutputAction`

**Depends on:** Task 5
**Outputs:** `actions/OpenOutputAction.kt`

```kotlin
class OpenOutputAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ToolWindowManager.getInstance(project).getToolWindow("Oracle")?.show()
    }
}
```

Register in `plugin.xml`:

```xml
<action id="oracle.openOutput" class="...OpenOutputAction"
        text="Oracle: Show Output"/>
```

**Verify:** `./gradlew buildPlugin` exits 0.

---

### Task 12 — Plugin Startup (`OraclePlugin`)

**Depends on:** Tasks 3, 6
**Outputs:** `OraclePlugin.kt` (replace stub),
`statusbar/OracleStatusBarService.kt`

```kotlin
package com.oracle.intellij

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.oracle.intellij.runner.CliResolver
import com.oracle.intellij.settings.OracleSettingsState
import com.oracle.intellij.statusbar.*
import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class OraclePlugin : ProjectActivity {

    override suspend fun execute(project: Project) {
        val settings = OracleSettingsState.getInstance().state
        val resolution = withContext(Dispatchers.IO) {
            CliResolver.resolve(settings.cliPath)
        }

        val sb = project.getService(OracleStatusBarService::class.java)

        if (!resolution.found) {
            sb.setState(OracleWidgetState.NOT_FOUND)
            NotificationGroupManager.getInstance()
                .getNotificationGroup("Oracle")
                .createNotification(
                    "Oracle CLI not found. Install with `pip install oracle`" +
                        " or set the CLI path in Preferences > Tools > Oracle.",
                    NotificationType.WARNING)
                .notify(project)
            return
        }

        sb.setState(OracleWidgetState.IDLE)
        sb.setCliFound(true)

        if (resolution.tooOld) {
            val key = "oracle.warnedVersion"
            val warned = PropertiesComponent.getInstance().getValue(key)
            if (warned != resolution.version) {
                PropertiesComponent.getInstance().setValue(key, resolution.version)
                NotificationGroupManager.getInstance()
                    .getNotificationGroup("Oracle")
                    .createNotification(
                        "Oracle CLI version ${resolution.version} is below" +
                            " minimum 0.1. Commands may not work correctly.",
                        NotificationType.WARNING)
                    .notify(project)
            }
        }
    }
}
```

Register in `plugin.xml`:

```xml
<extensions defaultExtensionNs="com.intellij">
  <postStartupActivity
      implementation="com.oracle.intellij.OraclePlugin"/>
  <notificationGroup id="Oracle"
                     displayType="BALLOON"
                     isLogByDefault="true"/>
</extensions>
```

**`OracleStatusBarService.kt`** — add to `statusbar/` package alongside Task 6 files:

```kotlin
package com.oracle.intellij.statusbar

import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project

@Service(Service.Level.PROJECT)
class OracleStatusBarService(private val project: Project) {

    @Volatile private var cliFound = false
    private var widget: OracleStatusBarWidget? = null

    fun isCliFound(): Boolean = cliFound
    fun setCliFound(found: Boolean) { cliFound = found }

    // Called by OracleStatusBarWidget.install() to register itself.
    internal fun setWidget(w: OracleStatusBarWidget) { widget = w }

    fun setState(state: OracleWidgetState) {
        widget?.setState(state)
    }
}
```

Also add to `plugin.xml`:

```xml
<projectService
    serviceImplementation="com.oracle.intellij.statusbar.OracleStatusBarService"/>
```

And in `OracleStatusBarWidget.install()` (Task 6), add one line so the widget
registers itself with the service:

```kotlin
override fun install(bar: StatusBar) {
    statusBar = bar
    project.getService(OracleStatusBarService::class.java).setWidget(this)
}
```

**Verify:** `./gradlew buildPlugin` exits 0. In sandbox IDE: plugin probes
CLI on project open; status bar shows correct state; one-time version warning
fires for `0.0.9` and is suppressed on second open.

---

### Task 13 — Tests

**Depends on:** Task 12
**Outputs:** `test/kotlin/com/oracle/intellij/**/*Test.kt`

Use the IntelliJ Platform test framework (`LightPlatformTestCase` /
`BasePlatformTestCase`) for integration tests. Pure-logic classes (`CliRunner`,
`CliResolver`, framework inference) are tested with plain JUnit 5 + MockK.

**Required test coverage:**

| File | Key cases |
| ---- | --------- |
| `CliResolverTest.kt` | found on PATH; not found; found in fallback `~/.local/bin`; `tooOld` when version `"0.0.9"`; login-shell fallback (macOS only) |
| `CliRunnerTest.kt` | env injection of `ORACLE_LLM_PROVIDER`; 120 s timeout → `timedOut = true`; non-zero exit captured; `ExecutionException` → `exitCode = -1` |
| `GenerateActionTest.kt` | blank prompt → no-op; right-click pre-fill populated; success opens file; JSON parse failure → raw stdout in tool window; timeout notification shown |
| `RunActionTest.kt` | no active file → error notification; framework inferred from `playwright.config.ts`; Quick Pick when not detected; pass/fail widget state set |
| `InitActionTest.kt` | chooser cancelled → no-op; selected framework passed to runner; project tree refreshed on success |
| `MigrateActionTest.kt` | null basePath → error; dry-run preview tab opened; Apply runs apply invocation; VFS refreshed; notification Cancel is no-op |

**Verify:** `./gradlew test` exits 0 with all cases green.

---

### Task 14 — CI / CD

**Depends on:** Task 13
**Outputs:** `.github/workflows/ci.yml`, `.github/workflows/publish.yml`

**`ci.yml`** — triggers on PR and push to `main`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }
      - uses: gradle/actions/setup-gradle@v3
      - run: ./gradlew check
      - run: ./gradlew buildPlugin
```

**`publish.yml`** — triggers on tag `v*`:

```yaml
name: Publish
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }
      - uses: gradle/actions/setup-gradle@v3
      - run: ./gradlew signPlugin publishPlugin
        env:
          CERTIFICATE_CHAIN: ${{ secrets.CERTIFICATE_CHAIN }}
          PRIVATE_KEY: ${{ secrets.PRIVATE_KEY }}
          PRIVATE_KEY_PASSWORD: ${{ secrets.PRIVATE_KEY_PASSWORD }}
          PUBLISH_TOKEN: ${{ secrets.PUBLISH_TOKEN }}
```

**Verify:** CI passes on a draft PR with no changes since Task 13.

---

## Dependency Graph

```text
T1 ──┬── T2 ── T3 ──────────────────────────────────────┐
     │    └─── T4 ──┬── T7 ──────────────────────────────┤
     │              ├── T8 ──────────────────────────────┤
     │              ├── T9 ──────────────────────────────┤
     │              └── T10 ─────────────────────────────┤
     ├── T5 ─────────── T7, T8, T9, T10, T11 ──────────┤
     │    └── T6 ─────── T7, T8, T12 ──────────────────┤
     └── T11 ────────────────────────────────────────────┤
                                                         T12 ── T13 ── T14
```

**Parallel batches:**

| Batch | Tasks | Gate |
| ----- | ----- | ---- |
| 1 | T1 | — |
| 2 | T2, T5 | T1 done |
| 3 | T3, T4, T6, T11 | T2 done |
| 4 | T7, T8, T9, T10 | T4 + T5 + T6 done |
| 5 | T12 | T3 + T7–T11 done |
| 6 | T13 | T12 done |
| 7 | T14 | T13 done |

## Checkpoints

- **After T4:** `./gradlew buildPlugin` — plugin ZIP builds without errors
  before any actions exist.
- **After T12:** Manual smoke test — install plugin in sandbox IDE
  (`./gradlew runIde`). Verify: tool window appears, status bar shows "Oracle",
  all 5 actions appear in Find Action, CLI probe fires on project open.
- **After T13:** `./gradlew test` green — all unit cases pass.
- **After T14:** Draft PR CI green.

## Out of Scope for This Plan

- VS Code extension (Phase 1 — complete)
- JetBrains Marketplace listing copy / icon / screenshots
- `oracle.recommendOnly` action (removed from scope per S6-001)
- Streaming output (`oracle run --stream`) — deferred
- Android Studio support
