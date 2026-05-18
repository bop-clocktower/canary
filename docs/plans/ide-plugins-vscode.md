# Implementation Plan — Oracle VS Code Extension

**Spec:** [docs/specs/ide-plugins.md](../specs/ide-plugins.md)
**Repo:** `oracle-vscode` (separate repository)
**Target:** VS Code >= 1.85.0 | TypeScript | `vsce` packaging

## Decisions Made in This Plan

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Keybinding for `oracle.run` | No default | Too much conflict risk; users assign via keymap |
| D2 | Multi-root workspace target for `oracle.migrate` | Active editor's workspace folder, fallback to first | Most ergonomic — matches where the user is working |
| D3 | Framework inference for `oracle.run` | Probe `playwright.config.*`, `vitest.config.*`, `pytest.ini`, `pyproject.toml [tool.pytest.ini_options]`, `k6.config.js` in workspace root; Quick Pick fallback | Mirrors CLI detection logic for consistency |
| D4 | Version warning deduplication | Store `warnedVersion` in `extensionContext.globalState` | Avoids re-showing on every activation |

## File Map

```
oracle-vscode/
├── .github/workflows/
│   ├── ci.yml                   # lint + typecheck + test on PR
│   └── publish.yml              # vsce package + publish on tag
├── src/
│   ├── extension.ts             # activate() / deactivate()
│   ├── config.ts                # oracle.* settings reader
│   ├── cliResolver.ts           # oracle version detection + PATH probing
│   ├── outputChannel.ts         # OracleOutputChannel + terminal link provider
│   ├── statusBar.ts             # OracleStatusBar (5 states)
│   ├── runner.ts                # child process wrapper (spawn, timeout, env)
│   └── commands/
│       ├── generate.ts          # oracle.generate
│       ├── run.ts               # oracle.run
│       ├── init.ts              # oracle.init
│       ├── migrate.ts           # oracle.migrate
│       └── openOutput.ts        # oracle.openOutput
├── src/test/
│   ├── runTest.ts               # VS Code test runner bootstrap
│   └── suite/
│       ├── extension.test.ts    # activation smoke test
│       ├── cliResolver.test.ts
│       ├── runner.test.ts
│       └── commands/
│           ├── generate.test.ts
│           ├── run.test.ts
│           ├── init.test.ts
│           └── migrate.test.ts
├── package.json                 # manifest: commands, config, menus, engines
├── tsconfig.json
├── .eslintrc.json
├── .vscodeignore
└── README.md
```

## Tasks

---

### Task 1 — Project Scaffold

**Inputs:** None  
**Outputs:** `oracle-vscode/` repo with all config files and empty `src/extension.ts`

Create the `oracle-vscode` directory and initialize:

**`package.json`** — key fields:
```json
{
  "name": "oracle-vscode",
  "displayName": "Oracle",
  "description": "AI-powered test generation via the Oracle CLI",
  "version": "0.1.0",
  "engines": { "vscode": "^1.85.0" },
  "activationEvents": ["onCommand:oracle.generate", "onCommand:oracle.run",
    "onCommand:oracle.init", "onCommand:oracle.migrate", "onCommand:oracle.openOutput"],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      { "command": "oracle.generate", "title": "Oracle: Generate Test" },
      { "command": "oracle.run",      "title": "Oracle: Run Test" },
      { "command": "oracle.init",     "title": "Oracle: Init Framework" },
      { "command": "oracle.migrate",  "title": "Oracle: Migrate Harness Project" },
      { "command": "oracle.openOutput","title": "Oracle: Show Output" }
    ],
    "menus": {
      "explorer/context": [
        { "command": "oracle.generate", "when": "!explorerResourceIsFolder", "group": "oracle" }
      ],
      "editor/title": [
        { "command": "oracle.run",
          "when": "resourceFilename =~ /\\.(spec|test)\\./", "group": "oracle" }
      ]
    },
    "configuration": { "title": "Oracle", "properties": {
      "oracle.cliPath":               { "type": "string",  "default": "" },
      "oracle.provider":              { "type": "string",  "default": "",
        "enum": ["", "anthropic", "openai", "gemini", "codex", "mock"] },
      "oracle.defaultReportFormat":   { "type": "string",  "default": "",
        "enum": ["", "json", "sarif"] },
      "oracle.showStatusBar":         { "type": "boolean", "default": true },
      "oracle.autoOpenGeneratedFile": { "type": "boolean", "default": true }
    }}
  },
  "devDependencies": {
    "@types/vscode": "^1.85.0",
    "@types/node": "^20.0.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@vscode/test-cli": "^0.0.9",
    "@vscode/test-electron": "^2.3.9",
    "typescript": "^5.4.0"
  }
}
```

**`tsconfig.json`:**
```json
{ "compilerOptions": { "module": "Node16", "target": "ES2022",
    "outDir": "out", "strict": true, "sourceMap": true },
  "include": ["src"], "exclude": ["node_modules", ".vscode-test"] }
```

**`src/extension.ts`** stub:
```typescript
import * as vscode from 'vscode';
export function activate(_ctx: vscode.ExtensionContext): void {}
export function deactivate(): void {}
```

**Verify:** `npm install && npx tsc --noEmit` exits 0.

---

### Task 2 — Configuration Module

**Depends on:** Task 1  
**Outputs:** `src/config.ts`

```typescript
import * as vscode from 'vscode';

export interface OracleConfig {
  cliPath: string;
  provider: string;
  defaultReportFormat: string;
  showStatusBar: boolean;
  autoOpenGeneratedFile: boolean;
}

export function getConfig(): OracleConfig {
  const cfg = vscode.workspace.getConfiguration('oracle');
  return {
    cliPath:               cfg.get<string>('cliPath', ''),
    provider:              cfg.get<string>('provider', ''),
    defaultReportFormat:   cfg.get<string>('defaultReportFormat', ''),
    showStatusBar:         cfg.get<boolean>('showStatusBar', true),
    autoOpenGeneratedFile: cfg.get<boolean>('autoOpenGeneratedFile', true),
  };
}
```

**Verify:** `npx tsc --noEmit` exits 0.

---

### Task 3 — CLI Resolver

**Depends on:** Task 2  
**Outputs:** `src/cliResolver.ts`

```typescript
export type CliStatus =
  | { found: true;  path: string; version: string; tooOld: boolean }
  | { found: false; path: string };

const MIN_VERSION = '0.1';
const FALLBACK_PATHS = [
  `${process.env.HOME}/.local/bin/oracle`,
  '/usr/local/bin/oracle',
];
```

`resolve(configuredPath: string): Promise<CliStatus>`:
1. Candidate list: `[configuredPath || null, 'oracle', ...FALLBACK_PATHS]` — skip nulls.
2. For each candidate, spawn `<candidate> version` with `{ timeout: 5000 }`.
3. First success → parse stdout for semver, compare to `MIN_VERSION`, return `CliStatus`.
4. All fail → return `{ found: false, path: configuredPath || 'oracle' }`.

Helper `compareVersions(a: string, b: string): number` — simple major.minor comparison is sufficient (no patch needed for `0.1` baseline).

**Verify:** `npx tsc --noEmit` exits 0. Unit test: mock `child_process.spawn` returning success/failure.

---

### Task 4 — Output Channel

**Depends on:** Task 1  
**Outputs:** `src/outputChannel.ts`

```typescript
export class OracleOutputChannel {
  private readonly ch: vscode.OutputChannel;
  private linkProviderDisposable?: vscode.Disposable;

  constructor() {
    this.ch = vscode.window.createOutputChannel('Oracle');
    this.registerLinkProvider();
  }

  append(text: string): void {
    const ts = new Date().toISOString();
    this.ch.append(`[${ts}] ${text}`);
  }

  appendLine(text: string): void { this.append(text + '\n'); }
  show(): void  { this.ch.show(true); }
  clear(): void { this.ch.clear(); }
  dispose(): void {
    this.linkProviderDisposable?.dispose();
    this.ch.dispose();
  }
}
```

Terminal link provider: register `vscode.window.registerTerminalLinkProvider` that matches
absolute file paths (`/abs/path/to/file.ts:42`) and opens them with
`vscode.workspace.openTextDocument` + `vscode.window.showTextDocument`.

**Verify:** `npx tsc --noEmit` exits 0.

---

### Task 5 — Status Bar

**Depends on:** Task 1  
**Outputs:** `src/statusBar.ts`

```typescript
export type StatusBarState = 'idle' | 'running' | 'pass' | 'fail' | 'not-found';

export class OracleStatusBar {
  private readonly item: vscode.StatusBarItem;
  private resetTimer?: NodeJS.Timeout;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'oracle.openOutput';
    this.setState('idle');
  }

  setState(state: StatusBarState): void {
    clearTimeout(this.resetTimer);
    const states: Record<StatusBarState, { text: string; tooltip: string }> = {
      'idle':      { text: '$(beaker) Oracle',          tooltip: 'Oracle ready — click to open output' },
      'running':   { text: '$(sync~spin) Oracle',       tooltip: 'Oracle: running…' },
      'pass':      { text: '$(check) Oracle',           tooltip: 'Last run: passed' },
      'fail':      { text: '$(error) Oracle',           tooltip: 'Last run: failed — click to open output' },
      'not-found': { text: '$(warning) Oracle: not found',
                     tooltip: 'oracle CLI not found on PATH. Click to configure.' },
    };
    Object.assign(this.item, states[state]);
    this.item.show();
    if (state === 'pass' || state === 'fail') {
      this.resetTimer = setTimeout(() => this.setState('idle'), 10_000);
    }
  }

  hide(): void  { this.item.hide(); }
  dispose(): void { clearTimeout(this.resetTimer); this.item.dispose(); }
}
```

Respect `oracle.showStatusBar`: call `hide()` if false; re-check on config change event.

**Verify:** `npx tsc --noEmit` exits 0.

---

### Task 6 — Child Process Runner

**Depends on:** Tasks 2, 4  
**Outputs:** `src/runner.ts`

```typescript
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runOracle(
  args: string[],
  output: OracleOutputChannel,
  config: OracleConfig,
): Promise<RunResult>
```

Implementation:
1. Binary: `config.cliPath || 'oracle'`.
2. Env: inherit `process.env`; if `config.provider`, set `ORACLE_LLM_PROVIDER`.
3. If `config.defaultReportFormat` and first arg is `generate`, append
   `['--report-format', config.defaultReportFormat]`.
4. Spawn with `{ shell: false }`. Collect stdout + stderr to strings.
5. 120-second timeout → `child.kill()`, set `timedOut: true`.
6. On spawn error (ENOENT etc.): return `{ exitCode: -1, stdout: '', stderr: err.message, timedOut: false }`.
7. On completion: `output.appendLine(`Exit ${exitCode}`)`.

**Verify:** `npx tsc --noEmit` exits 0. Unit test: mock spawn, assert env injection and timeout kill.

---

### Task 7 — `oracle.generate` Command

**Depends on:** Task 6  
**Outputs:** `src/commands/generate.ts`

```typescript
export async function generateCommand(
  output: OracleOutputChannel,
  statusBar: OracleStatusBar,
  config: OracleConfig,
  uri?: vscode.Uri,          // set when invoked via right-click
): Promise<void>
```

Flow:
1. Pre-fill: if `uri`, value = `` `Generate tests for ${path.basename(uri.fsPath)} — ` ``.
2. `vscode.window.showInputBox({ prompt, value, valueSelection: [value.length, value.length] })`.
3. If result is undefined or blank → return.
4. `statusBar.setState('running')`.
5. `output.appendLine(`oracle generate "${prompt}" --json`)`.
6. `result = await runOracle(['generate', prompt, '--json', ...reportArgs], output, config)`.
7. If `result.timedOut`: notification warning "Oracle timed out after 120s." → `statusBar.setState('idle')` → return.
8. If `result.exitCode !== 0`: parse `result.stderr` or `result.stdout` for message, show error notification, `statusBar.setState('idle')` → return.
9. Parse JSON: `const json = JSON.parse(result.stdout)`. On parse failure: `output.appendLine(result.stdout)` → return.
10. `statusBar.setState('idle')`.
11. If `config.autoOpenGeneratedFile`: open `json.output_file` in new tab.
12. Show info notification "Test generated." with buttons "Open File" (open uri) and "Run Now" (execute `oracle.run` with that file).

**Verify:** `npx tsc --noEmit` exits 0. Test: mock runner returning success JSON, assert file open called.

---

### Task 8 — `oracle.run` Command

**Depends on:** Task 6  
**Outputs:** `src/commands/run.ts`

```typescript
export async function runCommand(
  output: OracleOutputChannel,
  statusBar: OracleStatusBar,
  config: OracleConfig,
  fileUri?: vscode.Uri,
): Promise<void>
```

Flow:
1. Resolve file: `fileUri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath`.
2. If no file: show error notification → return.
3. If not a test file (no `.spec.` or `.test.` in basename): `vscode.window.showOpenDialog` filtered to `*.spec.*,*.test.*`.
4. Infer framework: probe workspace root for `playwright.config.*` → `playwright`, `vitest.config.*` → `vitest`, `pytest.ini` / `pyproject.toml` with `[tool.pytest.ini_options]` → `pytest`, `k6.config.js` → `k6`.
5. If no framework detected: Quick Pick `['playwright','vitest','pytest','k6']`.
6. `statusBar.setState('running')`.
7. `result = await runOracle(['run', file, framework], output, config)`.
8. `statusBar.setState(result.exitCode === 0 ? 'pass' : 'fail')`.
9. If `result.timedOut`: show warning notification.

**Verify:** `npx tsc --noEmit` exits 0. Test: mock runner and framework probe, assert status bar state.

---

### Task 9 — `oracle.init` Command

**Depends on:** Task 6  
**Outputs:** `src/commands/init.ts`

```typescript
export async function initCommand(
  output: OracleOutputChannel,
  config: OracleConfig,
): Promise<void>
```

Flow:
1. Quick Pick `['playwright','vitest','pytest','k6']` with title "Select framework to scaffold".
2. If cancelled → return.
3. `output.appendLine(`oracle init ${framework}`)`.
4. `result = await runOracle(['init', framework], output, config)`.
5. `output.appendLine(result.stdout)`.
6. If `result.exitCode !== 0`: show error notification.

**Verify:** `npx tsc --noEmit` exits 0. Test: mock Quick Pick + runner.

---

### Task 10 — `oracle.migrate` Command

**Depends on:** Task 6  
**Outputs:** `src/commands/migrate.ts`

```typescript
export async function migrateCommand(
  output: OracleOutputChannel,
  config: OracleConfig,
): Promise<void>
```

Flow:
1. If `!vscode.workspace.workspaceFolders`: show error "oracle migrate requires an open workspace folder." → return.
2. Resolve target root: folder containing `vscode.window.activeTextEditor?.document.uri` if it belongs to a workspace folder; else `workspaceFolders[0]` (D2).
3. Dry run: `result = await runOracle(['migrate','--path',root,'--json'], output, config)`.
4. If error/timeout: show error notification → return.
5. Parse JSON report. On parse failure: `output.appendLine(result.stdout)` → return.
6. Open untitled read-only document:
   ```typescript
   const doc = await vscode.workspace.openTextDocument(
     { content: JSON.stringify(report, null, 2), language: 'json' });
   await vscode.window.showTextDocument(doc, { preview: true });
   ```
7. Show notification "Migration preview ready." with buttons "Apply Migration" and "Cancel".
8. If "Apply Migration": `await runOracle(['migrate','--path',root,'--apply','--json'], output, config)`.
9. Refresh explorer: `vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer')`.

**Verify:** `npx tsc --noEmit` exits 0. Test: mock workspace folders, runner; assert both notification buttons handled.

---

### Task 11 — `oracle.openOutput` Command

**Depends on:** Task 4  
**Outputs:** `src/commands/openOutput.ts`

```typescript
export function openOutputCommand(output: OracleOutputChannel): void {
  output.show();
}
```

**Verify:** `npx tsc --noEmit` exits 0.

---

### Task 12 — Extension Entry Point

**Depends on:** Tasks 3, 5, 7, 8, 9, 10, 11  
**Outputs:** `src/extension.ts` (replace stub)

```typescript
export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const config = getConfig();
  const output = new OracleOutputChannel();
  const statusBar = new OracleStatusBar();

  ctx.subscriptions.push(output, statusBar);

  // CLI resolution
  const cliStatus = await resolveCli(config.cliPath);
  if (!cliStatus.found) {
    statusBar.setState('not-found');
    vscode.window.showWarningMessage(
      'Oracle: CLI not found. Install with `pip install oracle` or set oracle.cliPath.',
      'Open Settings'
    ).then(choice => {
      if (choice === 'Open Settings')
        vscode.commands.executeCommand('workbench.action.openSettings', 'oracle.cliPath');
    });
  } else if (cliStatus.tooOld) {
    const warned = ctx.globalState.get<string>('warnedVersion');
    if (warned !== cliStatus.version) {
      ctx.globalState.update('warnedVersion', cliStatus.version);
      vscode.window.showWarningMessage(
        `Oracle: CLI version ${cliStatus.version} is below minimum 0.1. Commands may not work correctly.`);
    }
  }

  // Register commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand('oracle.generate',
      (uri?) => generateCommand(output, statusBar, getConfig(), uri)),
    vscode.commands.registerCommand('oracle.run',
      (uri?) => runCommand(output, statusBar, getConfig(), uri)),
    vscode.commands.registerCommand('oracle.init',
      () => initCommand(output, getConfig())),
    vscode.commands.registerCommand('oracle.migrate',
      () => migrateCommand(output, getConfig())),
    vscode.commands.registerCommand('oracle.openOutput',
      () => openOutputCommand(output)),
  );

  // Re-read config on change (showStatusBar toggle)
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('oracle.showStatusBar')) {
        getConfig().showStatusBar ? statusBar.show?.() : statusBar.hide();
      }
    })
  );
}

export function deactivate(): void {}
```

Note: `getConfig()` is called fresh on each command invocation so config changes take effect without reload.

**Verify:** `npx tsc --noEmit` exits 0. Smoke test: extension activates without throwing.

---

### Task 13 — Tests

**Depends on:** Task 12  
**Outputs:** `src/test/suite/*.test.ts`

Use `@vscode/test-cli` + `mocha`. Mock `vscode` API with `sinon` stubs where needed (no real VS Code process required for unit tests).

**Required test coverage:**

| File | Key cases |
|------|-----------|
| `cliResolver.test.ts` | found on PATH; not found; found in fallback path; tooOld when version < 0.1 |
| `runner.test.ts` | provider env injection; 120s timeout kill; spawn ENOENT → exitCode -1; defaultReportFormat appended to generate |
| `generate.test.ts` | empty prompt no-op; right-click pre-fill; success → opens file; JSON parse failure → raw output; timeout warning |
| `run.test.ts` | no active editor → error notification; test file inferred; framework Quick Pick when not detected; pass/fail status bar |
| `init.test.ts` | Quick Pick cancelled → no-op; framework passed to runner |
| `migrate.test.ts` | no workspace → error; dry-run preview tab opened; Apply writes files; Cancel is no-op; explorer refreshed after apply |
| `extension.test.ts` | activates without throwing; not-found shows warning; tooOld shows once per version |

**Verify:** `npm test` exits 0 with all cases green.

---

### Task 14 — CI / CD

**Depends on:** Task 13  
**Outputs:** `.github/workflows/ci.yml`, `.github/workflows/publish.yml`

**`ci.yml`** — triggers on PR and push to `main`:
```yaml
- run: npm ci
- run: npx tsc --noEmit
- run: npm test
```

**`publish.yml`** — triggers on tag `v*`:
```yaml
- run: npm ci
- run: npx vsce package
- run: npx vsce publish
  env:
    VSCE_PAT: ${{ secrets.VSCE_PAT }}
```

**Verify:** CI passes on a draft PR with no code changes since Task 13.

---

## Dependency Graph

```
T1 ──┬── T2 ── T3 ──────────────────────┐
     ├── T4 ──────────────────── T11 ───┤
     │    └───────── T6 ── T7 ──────────┤
     │         T2 ──┘     T8 ──────────┤
     │                    T9 ──────────┤
     └── T5 ──────────────T10 ─────────┤
                                        T12 ── T13 ── T14
```

**Parallel batches:**

| Batch | Tasks | Gate |
|-------|-------|------|
| 1 | T1 | — |
| 2 | T2, T4, T5 | T1 done |
| 3 | T3, T6 | T2+T4 done |
| 4 | T7, T8, T9, T10, T11 | T6 done (T11 needs T4) |
| 5 | T12 | T3+T5+T7–T11 done |
| 6 | T13 | T12 done |
| 7 | T14 | T13 done |

## Checkpoints

- **After T6:** `npx tsc --noEmit` on the full project — no type errors before commands are built.
- **After T12:** Manual smoke test — open VS Code, install extension (`F5` debug), verify command palette lists all 5 commands, status bar appears.
- **After T13:** `npm test` green — all unit cases pass.
- **After T14:** Draft PR CI green.

## Out of Scope for This Plan

- JetBrains plugin (Phase 2 — separate plan)
- VS Code marketplace listing copy / icon / screenshots
- `oracle.recommendOnly` command (removed from Phase 1 scope)
- Streaming output (`oracle run --stream`) — deferred per Open Question #3
