# npm Binary Distribution (Volta-compatible) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `harness:tdd`
> (recommended) or `harness:execution` to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `@harness-engineering/cli` to npm so
`volta install @harness-engineering/cli` installs a self-contained `canary`
binary — no Python or pipx required.

**Architecture:** PyInstaller compiles the Python CLI into
platform-specific native binaries (linux-x64, darwin-arm64, win32-x64)
uploaded as GitHub Release assets. An npm package
`@harness-engineering/cli` ships a Node.js `bin` shim + a `postinstall`
script that detects the current platform and downloads the right binary
from GitHub Releases. Volta installs the shim, which `execFileSync`s the
native binary at runtime.

**Tech Stack:** PyInstaller 6.x, Node.js 22 (npm package), GitHub Actions
matrix (3 runners), `node:https` (zero extra npm deps in the shim package)

---

## File Map

| Path | Status | Purpose |
| ------ | -------- | --------- |
| `npm/package.json` | Create | npm package manifest (`@harness-engineering/cli`) |
| `npm/.npmignore` | Create | Exclude dev files from published tarball |
| `npm/scripts/install.js` | Create | postinstall — detects platform, downloads binary from GH Releases |
| `npm/bin/canary.js` | Create | Runtime shim — `execFileSync`s the native binary |
| `npm/scripts/__tests__/install.test.js` | Create | Unit tests for install.js (platform detection + download logic) |
| `npm/scripts/__tests__/canary.test.js` | Create | Unit tests for bin wrapper (spawn logic) |
| `canary.spec` | Create | PyInstaller spec — bundles agent + frameworks/*.json |
| `.github/workflows/release.yml` | Create | Build matrix → GH Release → npm publish |
| `scripts/check_version_sync.py` | Create | CI guard: pyproject.toml version == npm/package.json version |
| `.github/workflows/docs-lint.yml` | Modify | Add version-sync job |
| `pyproject.toml` | Modify | Add `[project.optional-dependencies] dev = ["pyinstaller>=6"]` |
| `README.md` | Modify | Add Volta install as primary method |
| `CHANGELOG.md` | Modify | Document new distribution |

---

## Task 1: PyInstaller spec file

**Files:**

- Create: `canary.spec`
- Modify: `pyproject.toml`

- [ ] **Step 1: Add PyInstaller as a dev dependency**

  Edit `pyproject.toml` — add after the existing `[project]` block:

  ```toml
  [project.optional-dependencies]
  dev = [
      "pyinstaller>=6,<7",
  ]
  ```

- [ ] **Step 2: Install PyInstaller locally**

  ```bash
  pip install pyinstaller>=6
  ```

  Expected: `Successfully installed pyinstaller-6.x.x`

- [ ] **Step 3: Write the PyInstaller spec**

  Create `canary.spec` at repo root:

  ```python
  # canary.spec
  import sys
  from pathlib import Path
  from PyInstaller.utils.hooks import collect_data_files, collect_submodules

  block_cipher = None

  # Bundle frameworks JSON data files
  datas = [
      ("agent/frameworks/*.json", "agent/frameworks"),
  ]
  # fastmcp may have data files (e.g. schema stubs)
  datas += collect_data_files("fastmcp")

  hiddenimports = (
      collect_submodules("agent")
      + collect_submodules("typer")
      + collect_submodules("rich")
      + collect_submodules("fastmcp")
      + ["openpyxl.cell._writer"]  # openpyxl lazy import that PyInstaller misses
  )

  a = Analysis(
      ["agent/cli.py"],
      pathex=["."],
      binaries=[],
      datas=datas,
      hiddenimports=hiddenimports,
      hookspath=[],
      hooksconfig={},
      runtime_hooks=[],
      excludes=["tests", "docs", "scripts"],
      win_no_prefer_redirects=False,
      win_private_assemblies=False,
      cipher=block_cipher,
      noarchive=False,
  )

  pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

  exe = EXE(
      pyz,
      a.scripts,
      a.binaries,
      a.zipfiles,
      a.datas,
      [],
      name="canary",
      debug=False,
      bootloader_ignore_signals=False,
      strip=False,
      upx=False,        # UPX causes false-positive AV hits — keep off
      console=True,
      disable_windowed_traceback=False,
      target_arch=None,
      codesign_identity=None,
      entitlements_file=None,
  )
  ```

- [ ] **Step 4: Do a local test build**

  ```bash
  pyinstaller canary.spec --clean
  ```

  Expected: `dist/canary` binary appears (or `dist/canary.exe` on Windows).

- [ ] **Step 5: Smoke-test the local binary**

  ```bash
  ./dist/canary --version
  ./dist/canary recommend "a login form"
  ```

  Expected: version banner prints; recommend command runs without Python
  import errors.

  > **If you see `ModuleNotFoundError` for a hidden import:** add the
  > missing module to `hiddenimports` in `canary.spec` and repeat Step 4.

- [ ] **Step 6: Add dist/ to gitignore**

  `dist/` is already in most `.gitignore` templates, but confirm:

  ```bash
  grep -r "dist/" .gitignore || echo "dist/" >> .gitignore
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add canary.spec pyproject.toml .gitignore
  git commit -m "build: add PyInstaller spec for native binary packaging"
  ```

---

## Task 2: npm package scaffold

**Files:**

- Create: `npm/package.json`
- Create: `npm/.npmignore`

- [ ] **Step 1: Write the failing test** (there is no logic yet — skip to scaffold)

  Create the directory:

  ```bash
  mkdir -p npm/scripts/__tests__ npm/bin
  ```

- [ ] **Step 2: Write `npm/package.json`**

  ```json
  {
    "name": "@harness-engineering/cli",
    "version": "5.0.0",
    "description": "Canary — AI-powered test automation agent",
    "license": "MIT",
    "repository": {
      "type": "git",
      "url": "https://github.com/bop-clocktower/canary.git"
    },
    "bin": {
      "canary": "./bin/canary.js"
    },
    "scripts": {
      "postinstall": "node scripts/install.js",
      "test": "node --test scripts/__tests__/install.test.js scripts/__tests__/canary.test.js"
    },
    "engines": {
      "node": ">=18"
    },
    "files": [
      "bin/",
      "scripts/install.js"
    ]
  }
  ```

  > **Version note:** Keep this in sync with `pyproject.toml`. Task 6
  > adds a CI guard that fails if they diverge.

- [ ] **Step 3: Write `npm/.npmignore`**

  ```text
  scripts/__tests__/
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add npm/
  git commit -m "build(npm): scaffold @harness-engineering/cli package"
  ```

---

## Task 3: postinstall downloader (`install.js`)

**Files:**

- Create: `npm/scripts/install.js`
- Create: `npm/scripts/__tests__/install.test.js`

- [ ] **Step 1: Write the failing tests first**

  Create `npm/scripts/__tests__/install.test.js`:

  ```js
  // Uses Node.js built-in test runner (node --test), no extra deps.
  const { describe, it, mock, beforeEach } = require("node:test");
  const assert = require("node:assert/strict");

  // We test the pure functions extracted from install.js
  const { getPlatformKey, getBinaryName, getDownloadUrl } = require("../install.js");

  describe("getPlatformKey", () => {
    it("returns linux-x64 on linux x64", () => {
      assert.equal(getPlatformKey("linux", "x64"), "linux-x64");
    });
    it("returns darwin-arm64 on macOS arm64", () => {
      assert.equal(getPlatformKey("darwin", "arm64"), "darwin-arm64");
    });
    it("returns win32-x64 on Windows x64", () => {
      assert.equal(getPlatformKey("win32", "x64"), "win32-x64");
    });
    it("throws on unsupported platform", () => {
      assert.throws(
        () => getPlatformKey("freebsd", "x64"),
        /Unsupported platform/
      );
    });
  });

  describe("getBinaryName", () => {
    it("appends .exe on windows", () => {
      assert.equal(getBinaryName("win32-x64"), "canary-win32-x64.exe");
    });
    it("no extension on unix", () => {
      assert.equal(getBinaryName("linux-x64"), "canary-linux-x64");
    });
  });

  describe("getDownloadUrl", () => {
    it("builds the correct GitHub release asset URL", () => {
      const url = getDownloadUrl("5.0.0", "canary-linux-x64");
      assert.equal(
        url,
        "https://github.com/bop-clocktower/canary/releases/download/v5.0.0/canary-linux-x64"
      );
    });
  });
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  cd npm && node --test scripts/__tests__/install.test.js
  ```

  Expected: `Error: Cannot find module '../install.js'`

- [ ] **Step 3: Write `npm/scripts/install.js`**

  ```js
  #!/usr/bin/env node
  "use strict";

  const https = require("node:https");
  const fs = require("node:fs");
  const path = require("node:path");

  const SUPPORTED = {
    "linux-x64": true,
    "darwin-arm64": true,
    "win32-x64": true,
  };

  function getPlatformKey(platform, arch) {
    const key = `${platform}-${arch}`;
    if (!SUPPORTED[key]) {
      throw new Error(
        `Unsupported platform: ${key}. Supported: ${Object.keys(SUPPORTED).join(", ")}`
      );
    }
    return key;
  }

  function getBinaryName(platformKey) {
    return platformKey.startsWith("win32")
      ? `canary-${platformKey}.exe`
      : `canary-${platformKey}`;
  }

  function getDownloadUrl(version, binaryName) {
    return `https://github.com/bop-clocktower/canary/releases/download/v${version}/${binaryName}`;
  }

  function download(url, destPath, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      if (redirectsLeft === 0) return reject(new Error("Too many redirects"));
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return resolve(download(res.headers.location, destPath, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
      }).on("error", reject);
    });
  }

  async function main() {
    const pkg = require("../package.json");
    const version = pkg.version;
    const platformKey = getPlatformKey(process.platform, process.arch);
    const binaryName = getBinaryName(platformKey);
    const url = getDownloadUrl(version, binaryName);
    const destDir = path.join(__dirname, "..", "bin");
    const destName = process.platform === "win32" ? "canary.exe" : "canary";
    const destPath = path.join(destDir, destName);

    fs.mkdirSync(destDir, { recursive: true });

    process.stdout.write(`Downloading canary ${version} for ${platformKey}...\n`);
    await download(url, destPath);
    fs.chmodSync(destPath, 0o755);
    process.stdout.write(`Done. Binary at: ${destPath}\n`);
  }

  // Export pure functions for testing; run main() only when executed directly.
  module.exports = { getPlatformKey, getBinaryName, getDownloadUrl };
  if (require.main === module) main().catch((e) => { process.stderr.write(e.message + "\n"); process.exit(1); });
  ```

- [ ] **Step 4: Run tests to confirm they pass**

  ```bash
  cd npm && node --test scripts/__tests__/install.test.js
  ```

  Expected: all 6 tests pass, no failures.

- [ ] **Step 5: Commit**

  ```bash
  git add npm/scripts/install.js npm/scripts/__tests__/install.test.js
  git commit -m "feat(npm): postinstall binary downloader with platform detection"
  ```

---

## Task 4: runtime bin shim (`canary.js`)

**Files:**

- Create: `npm/bin/canary.js`
- Create: `npm/scripts/__tests__/canary.test.js`

- [ ] **Step 1: Write the failing tests**

  Create `npm/scripts/__tests__/canary.test.js`:

  ```js
  const { describe, it } = require("node:test");
  const assert = require("node:assert/strict");
  const path = require("node:path");
  const { getBinaryPath } = require("../../bin/canary.js");

  describe("getBinaryPath", () => {
    it("returns path ending in canary on unix", () => {
      const p = getBinaryPath("linux");
      assert.ok(p.endsWith("canary"), `expected path to end with 'canary', got ${p}`);
    });
    it("returns path ending in canary.exe on windows", () => {
      const p = getBinaryPath("win32");
      assert.ok(p.endsWith("canary.exe"), `expected 'canary.exe', got ${p}`);
    });
    it("returned path is inside the bin/ directory", () => {
      const p = getBinaryPath("linux");
      assert.ok(p.includes(`${path.sep}bin${path.sep}`));
    });
  });
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  cd npm && node --test scripts/__tests__/canary.test.js
  ```

  Expected: `Error: Cannot find module '../../bin/canary.js'`

- [ ] **Step 3: Write `npm/bin/canary.js`**

  ```js
  #!/usr/bin/env node
  "use strict";

  const { execFileSync } = require("node:child_process");
  const path = require("node:path");
  const fs = require("node:fs");

  function getBinaryPath(platform) {
    const name = platform === "win32" ? "canary.exe" : "canary";
    return path.join(__dirname, name);
  }

  function main() {
    const binaryPath = getBinaryPath(process.platform);
    if (!fs.existsSync(binaryPath)) {
      process.stderr.write(
        `canary binary not found at ${binaryPath}.\n` +
        `Try reinstalling: volta install @harness-engineering/cli\n`
      );
      process.exit(1);
    }
    try {
      execFileSync(binaryPath, process.argv.slice(2), { stdio: "inherit" });
    } catch (err) {
      process.exit(err.status ?? 1);
    }
  }

  module.exports = { getBinaryPath };
  if (require.main === module) main();
  ```

- [ ] **Step 4: Make the shim executable**

  ```bash
  chmod +x npm/bin/canary.js
  ```

- [ ] **Step 5: Run tests to confirm they pass**

  ```bash
  cd npm && node --test scripts/__tests__/canary.test.js
  ```

  Expected: all 3 tests pass.

- [ ] **Step 6: Run full npm test suite**

  ```bash
  cd npm && node --test scripts/__tests__/install.test.js scripts/__tests__/canary.test.js
  ```

  Expected: all 9 tests pass.

- [ ] **Step 7: Commit**

  ```bash
  git add npm/bin/canary.js npm/scripts/__tests__/canary.test.js
  git commit -m "feat(npm): runtime bin shim that executes native canary binary"
  ```

---

## Task 5: GitHub Actions release workflow

**Files:**

- Create: `.github/workflows/release.yml`

This workflow triggers on a version tag (`v*`), builds 3 platform binaries
in a matrix, uploads them to the GitHub Release, then publishes the npm
package.

- [ ] **Step 1: Write `.github/workflows/release.yml`**

  ```yaml
  name: Release

  on:
    push:
      tags:
        - "v*"

  permissions:
    contents: write   # needed to create/upload release assets
    id-token: write   # needed for npm provenance

  jobs:
    build-binaries:
      name: Build (${{ matrix.os }})
      runs-on: ${{ matrix.os }}
      strategy:
        matrix:
          include:
            - os: ubuntu-22.04
              platform_key: linux-x64
              binary_name: canary-linux-x64
            - os: macos-14
              platform_key: darwin-arm64
              binary_name: canary-darwin-arm64
            - os: windows-2022
              platform_key: win32-x64
              binary_name: canary-win32-x64.exe

      steps:
        - uses: actions/checkout@v6

        - uses: actions/setup-python@v6
          with:
            python-version: "3.12"

        - name: Install dependencies + PyInstaller
          run: pip install -e ".[dev]"

        - name: Build binary
          run: pyinstaller canary.spec --clean

        - name: Rename binary to platform name
          shell: bash
          run: |
            if [[ "${{ matrix.platform_key }}" == "win32-x64" ]]; then
              mv dist/canary.exe dist/${{ matrix.binary_name }}
            else
              mv dist/canary dist/${{ matrix.binary_name }}
            fi

        - name: Upload binary as artifact
          uses: actions/upload-artifact@v4
          with:
            name: ${{ matrix.binary_name }}
            path: dist/${{ matrix.binary_name }}

    publish:
      name: Publish to GitHub Releases + npm
      needs: build-binaries
      runs-on: ubuntu-latest

      steps:
        - uses: actions/checkout@v6

        - name: Download all binaries
          uses: actions/download-artifact@v4
          with:
            path: dist/

        - name: Create GitHub Release and upload assets
          uses: softprops/action-gh-release@v2
          with:
            files: dist/**/*
            generate_release_notes: true

        - uses: actions/setup-node@v6
          with:
            node-version: "22"
            registry-url: "https://registry.npmjs.org"

        - name: Publish npm package
          working-directory: npm
          run: npm publish --access public --provenance
          env:
            NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  ```

  > **Secrets needed:** Add `NPM_TOKEN` (an npm automation token scoped
  > to `@harness-engineering`) to the repo's GitHub Secrets before running
  > this workflow.

- [ ] **Step 2: Validate workflow YAML syntax**

  ```bash
  python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo "valid"
  ```

  Expected: `valid`

- [ ] **Step 3: Commit**

  ```bash
  git add .github/workflows/release.yml
  git commit -m "ci: add release workflow — builds platform binaries and publishes to npm"
  ```

---

## Task 6: Version sync guard

Prevents `pyproject.toml` and `npm/package.json` from drifting out of sync
between releases.

**Files:**

- Create: `scripts/check_version_sync.py`
- Modify: `.github/workflows/docs-lint.yml`

- [ ] **Step 1: Write `scripts/check_version_sync.py`**

  ```python
  #!/usr/bin/env python3
  """Fail CI if pyproject.toml and npm/package.json versions diverge."""
  import json
  import sys
  from pathlib import Path

  try:
      import tomllib
  except ImportError:
      try:
          import tomli as tomllib
      except ImportError:
          import subprocess
          subprocess.run([sys.executable, "-m", "pip", "install", "tomli"], check=True)
          import tomli as tomllib

  root = Path(__file__).parent.parent

  pyproject_version = tomllib.loads((root / "pyproject.toml").read_text())["project"]["version"]
  npm_version = json.loads((root / "npm" / "package.json").read_text())["version"]

  if pyproject_version != npm_version:
      print(f"ERROR: version mismatch!")
      print(f"  pyproject.toml : {pyproject_version}")
      print(f"  npm/package.json: {npm_version}")
      print("Update both files to the same version before merging.")
      sys.exit(1)

  print(f"OK: versions match ({pyproject_version})")
  ```

- [ ] **Step 2: Run it locally to verify it passes**

  ```bash
  python3 scripts/check_version_sync.py
  ```

  Expected: `OK: versions match (5.0.0)`

- [ ] **Step 3: Verify it fails when versions differ**

  ```bash
  # Temporarily break it
  python3 -c "
  import json, pathlib
  p = pathlib.Path('npm/package.json')
  d = json.loads(p.read_text())
  d['version'] = '9.9.9'
  p.write_text(json.dumps(d, indent=2))
  "
  python3 scripts/check_version_sync.py
  # Expected: non-zero exit + ERROR message
  # Restore
  python3 -c "
  import json, pathlib
  p = pathlib.Path('npm/package.json')
  d = json.loads(p.read_text())
  d['version'] = '5.0.0'
  p.write_text(json.dumps(d, indent=2) + '\n')
  "
  ```

- [ ] **Step 4: Add version-sync job to `.github/workflows/docs-lint.yml`**

  Append this job to the existing jobs in `docs-lint.yml`:

  ```yaml
    version-sync:
      name: npm/pyproject version parity
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v6
        - uses: actions/setup-python@v6
          with:
            python-version: "3.12"
        - name: Check version sync
          run: python3 scripts/check_version_sync.py
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/check_version_sync.py .github/workflows/docs-lint.yml
  git commit -m "ci: version-sync guard between pyproject.toml and npm/package.json"
  ```

---

## Task 7: README + CHANGELOG update

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update README install section**

  Find the `## 🛠 Installation` section in `README.md`. Replace the entire
  section with:

  ````markdown
  ## 🛠 Installation

  ### Volta (recommended)

  ```bash
  volta install @harness-engineering/cli
  ```

  Installs a self-contained `canary` binary — no Python or pipx required.
  Volta handles version pinning and per-project switching automatically.

  ### npm / npx

  ```bash
  npm install -g @harness-engineering/cli
  # or one-shot:
  npx @harness-engineering/cli recommend "a login page"
  ```

  ### pipx (Python users)

  ```bash
  pipx install git+https://github.com/bop-clocktower/canary@latest
  ```

  ### From source

  ```bash
  git clone https://github.com/bop-clocktower/canary.git
  cd canary
  pip install -e .
  ```

  ````

  > Keep the Claude Code plugin section that follows — only replace the
  > install block above it.

- [ ] **Step 2: Add CHANGELOG entry**

  In `CHANGELOG.md`, under `## [Unreleased]`, add:

  ```markdown
  ### Added
  - `volta install @harness-engineering/cli` — self-contained native binary distribution
    via npm. No Python required. Binaries built for linux-x64, darwin-arm64, win32-x64.
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add README.md CHANGELOG.md
  git commit -m "docs: add Volta install as primary install method"
  ```

---

## Task 8: End-to-end smoke test (local simulation)

Validates the full postinstall → shim → binary chain locally before pushing.

**Files:** none new — uses binaries from Task 1's `dist/` build.

- [ ] **Step 1: Simulate postinstall by copying the local binary into npm/bin/**

  ```bash
  cp dist/canary npm/bin/canary
  chmod +x npm/bin/canary
  ```

- [ ] **Step 2: Run the shim directly**

  ```bash
  node npm/bin/canary.js --version
  node npm/bin/canary.js recommend "a login page"
  ```

  Expected: version banner prints; recommend output appears. No Python import errors.

- [ ] **Step 3: Simulate `volta install` by linking the package locally**

  ```bash
  cd npm && npm link
  canary --version
  canary recommend "a checkout flow"
  ```

  Expected: `canary` resolves to the Node shim, which calls the local native binary.

- [ ] **Step 4: Run full npm test suite one final time**

  ```bash
  cd npm && node --test scripts/__tests__/install.test.js scripts/__tests__/canary.test.js
  ```

  Expected: all 9 tests pass.

- [ ] **Step 5: Clean up npm link**

  ```bash
  cd npm && npm unlink
  rm npm/bin/canary  # remove the local copy; CI will place the real one
  ```

- [ ] **Step 6: Final commit**

  ```bash
  git add -A
  git commit -m "test: end-to-end smoke test for npm binary distribution"
  ```

---

## Pre-PR checklist

Before opening the PR, run:

```bash
# Version sync
python3 scripts/check_version_sync.py

# npm unit tests
cd npm && node --test scripts/__tests__/install.test.js scripts/__tests__/canary.test.js

# Local PyInstaller build + smoke
pyinstaller canary.spec --clean
./dist/canary --version

# Docs lint (markdownlint on changed .md files)
npx markdownlint README.md CHANGELOG.md
```

---

## One-time setup before first release

1. Create npm org `@harness-engineering` at npmjs.com (if not done)
2. Generate an npm **Automation token** (bypasses 2FA for CI)
3. Add it as GitHub repo secret: `Settings → Secrets → NPM_TOKEN`
4. Ensure the GitHub Actions `GITHUB_TOKEN` has `contents: write` —
   already set in `release.yml` permissions block

To trigger the first release:

```bash
git tag v5.0.0
git push origin v5.0.0
```

The workflow builds binaries, creates the GitHub Release with assets, then
publishes the npm package. After it completes:

```bash
volta install @harness-engineering/cli
canary --version  # should print the golden bird banner
```
