#!/usr/bin/env node
/**
 * Stage the TypeScript engine (`../ts`, package `@canary/engine-ts`) into this
 * npm package so `canary-test-cli` ships and runs the engine directly instead
 * of downloading a per-OS PyInstaller binary (canary v6 cutover, stage 1).
 *
 * Pipeline (all output lands under `dist/engine/`, which `package.json#files`
 * already ships via `dist/`):
 *   1. Ensure the engine's own deps are installed (`npm ci` in ../ts, only when
 *      node_modules is absent) and compile it (`npm run build` -> ts/dist).
 *   2. Copy the compiled `*.js` from ts/dist -> dist/engine (runtime only; the
 *      .d.ts/.map are left behind to keep the tarball lean).
 *   3. The engine is ESM (`"type": "module"`) but this npm package is CommonJS,
 *      so drop a `dist/engine/package.json` marking the bundle as ESM.
 *   4. The compiled `cli.js` only *exports* `createCanaryCommand` -- it is not
 *      runnable on its own. Rename it to `cli.core.js` and generate a runnable
 *      `cli.js` entry (the shim's `enginePath`) that mirrors ts/bin/canary.js
 *      but reads the published version from THIS package's package.json.
 *   5. The engine's `FrameworkRegistry` resolves `registry.json` as
 *      `../data/frameworks/registry.json` relative to its own compiled location
 *      (`dist/engine/core`). `ts/dist/data/` already contains it (the engine's
 *      own build copies `src/data` -> `dist/data`), so staging `.json` files
 *      alongside the compiled `.js` bundles it at the matching location with no
 *      Python and no separate copy step.
 *   6. Stage `agents/skills` -> `<pkg>/agents/skills`, the bundled-skill root
 *      the engine's `SkillRegistry` resolves three directories above its own
 *      compiled location. Without it an installed CLI sees zero skills (#757).
 */
'use strict';

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const npmRoot = resolve(scriptDir, '..');
const repoRoot = resolve(npmRoot, '..');
const tsRoot = resolve(repoRoot, 'ts');
const tsDist = resolve(tsRoot, 'dist');
const engineOut = resolve(npmRoot, 'dist', 'engine');

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (res.status !== 0) {
    throw new Error(
      `\`${cmd} ${args.join(' ')}\` (in ${cwd}) exited ${res.status}`,
    );
  }
}

function buildEngine() {
  if (!existsSync(tsRoot)) {
    throw new Error(
      `engine source not found at ${tsRoot}; cannot bundle @canary/engine-ts`,
    );
  }

  // 1. Install the engine's deps only when missing (keeps repeat local builds
  //    fast); always recompile so dist/engine is never stale.
  if (!existsSync(resolve(tsRoot, 'node_modules'))) {
    process.stdout.write('[build-engine] installing engine deps (npm ci)...\n');
    run('npm', ['ci'], tsRoot);
  }
  process.stdout.write('[build-engine] compiling engine (npm run build)...\n');
  run('npm', ['run', 'build'], tsRoot);

  if (!existsSync(resolve(tsDist, 'cli.js'))) {
    throw new Error(`engine build produced no cli.js at ${tsDist}`);
  }

  // 2. Stage compiled JS.
  rmSync(engineOut, { recursive: true, force: true });
  mkdirSync(engineOut, { recursive: true });
  cpSync(tsDist, engineOut, {
    recursive: true,
    // Copy directories (to recurse), runtime .js, and data .json (e.g.
    // data/frameworks/registry.json); skip .d.ts/.map and the compiled
    // *.test.js (tsc emits them from src but they never run here).
    filter: (src) =>
      statSync(src).isDirectory() ||
      (src.endsWith('.js') && !src.endsWith('.test.js')) ||
      src.endsWith('.json'),
  });

  // 3. Mark the bundle as ESM.
  writeFileSync(
    resolve(engineOut, 'package.json'),
    `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`,
  );

  // 4. Make cli.js runnable: keep the compiled command module as cli.core.js
  //    and write the executable wrapper as cli.js.
  renameSync(resolve(engineOut, 'cli.js'), resolve(engineOut, 'cli.core.js'));
  writeFileSync(resolve(engineOut, 'cli.js'), RUNNER);

  // 5. The framework registry (data/frameworks/registry.json) was already
  //    staged in step 2 alongside the compiled .js -- see the header comment.
  if (!existsSync(resolve(engineOut, 'data', 'frameworks', 'registry.json'))) {
    throw new Error(
      `framework registry missing from staged engine at ${engineOut}/data`,
    );
  }

  process.stdout.write(`[build-engine] engine staged at ${engineOut}\n`);

  stageSkills();
}

/**
 * Stage the bundled skill tree so an installed CLI can actually see it (#757).
 *
 * `SkillRegistry` resolves its bundled root three directories above the
 * compiled `core/` module -- `<pkg>/dist/engine/core` -> `<pkg>/agents/skills`.
 * That is the same arithmetic that lands on the repo root in a checkout, so it
 * was never wrong; the package simply never shipped an `agents/`. The result
 * was that `canary skills list` reported "No skills found." from every
 * directory including one holding 21 SKILL.md files, and `skills run` could
 * resolve none of them.
 *
 * What is copied is the runnable half: SKILL.md, the skill `scripts/`, the
 * shared `lib/`, and the flat slash-command `*.md`. The skill tree's own vitest
 * package (its `test/`, manifests and config) is development scaffolding and
 * stays behind.
 */
function stageSkills() {
  const from = resolve(repoRoot, 'agents', 'skills');
  const to = resolve(npmRoot, 'agents', 'skills');
  if (!existsSync(from)) {
    throw new Error(`bundled skills not found at ${from}; cannot stage them`);
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, filter: shipSkillFile });

  // The whole point of the step is that the tree is present at runtime, so a
  // staging that produced nothing must fail the build rather than publish an
  // empty directory that reproduces the bug it was added to fix.
  const staged = countSkillManifests(to);
  if (staged === 0) {
    throw new Error(`no SKILL.md staged into ${to}; the filter dropped them`);
  }
  process.stdout.write(
    `[build-engine] ${staged} bundled skill(s) staged at ${to}\n`,
  );
}

/** Development scaffolding inside the skill tree; never shipped. */
const SKILL_EXCLUDED_DIRS = new Set(['test', 'node_modules', '__pycache__']);
const SKILL_EXCLUDED_FILES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.ts',
]);

function shipSkillFile(src) {
  const name = basename(src);
  if (statSync(src).isDirectory()) return !SKILL_EXCLUDED_DIRS.has(name);
  if (SKILL_EXCLUDED_FILES.has(name)) return false;
  return !name.endsWith('.test.ts') && !name.endsWith('.d.ts');
}

/** How many `SKILL.md` files landed -- the staging step's denominator. */
function countSkillManifests(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      total += countSkillManifests(resolve(dir, entry.name));
    } else if (entry.name === 'SKILL.md') {
      total += 1;
    }
  }
  return total;
}

/**
 * Runnable entry generated at dist/engine/cli.js. Mirrors ts/bin/canary.js: it
 * builds the command with the published version injected and maps the CLI's
 * business/usage exits to a process exit code. `../../package.json` resolves to
 * this package's manifest (dist/engine/cli.js -> npm/package.json).
 */
const RUNNER = `#!/usr/bin/env node
// GENERATED by npm/scripts/build-engine.mjs -- do not edit by hand.
// Executable counterpart of the compiled command module (cli.core.js), which
// only exports createCanaryCommand. Mirrors ts/bin/canary.js.
import { createRequire } from 'node:module';

import { CommanderError } from 'commander';

import { createCanaryCommand } from './cli.core.js';
import { CliExitError } from './cli-common.js';

const require = createRequire(import.meta.url);

function readVersion() {
  try {
    return require('../../package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const program = createCanaryCommand({ pkgVersion: () => readVersion() });

try {
  await program.parseAsync(process.argv.slice(2), { from: 'user' });
} catch (err) {
  if (err instanceof CliExitError) process.exit(err.code);
  if (err instanceof CommanderError) process.exit(err.exitCode);
  console.error(err);
  process.exit(1);
}
`;

try {
  buildEngine();
} catch (err) {
  process.stderr.write(`[build-engine] ${err.message}\n`);
  process.exit(1);
}
