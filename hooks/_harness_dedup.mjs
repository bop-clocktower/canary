// Shared dedup guard for canary's plugin hooks.
//
// Canary ships hooks (wired via `.claude-plugin/hooks.json`) that overlap with
// harness's JS hooks (wired via `.claude/settings.json`). When both the canary
// plugin *and* harness are active in the same project, each overlapping hook
// would fire twice. Single source of truth: the harness JS hooks stay
// authoritative for the overlapping surfaces, so each canary hook calls
// `harnessHookPresent` and defers (no-ops) when its harness counterpart is
// wired. Hooks that own *unique* surface defer only the overlapping slice.
//
// "Present" = the harness hook file exists under `<project>/.harness/hooks/`.
// Claude Code runs hooks with the project root as cwd, so `process.cwd()` is the
// right anchor.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** True when the harness JS counterpart hook is wired in this project. */
export function harnessHookPresent(jsBasename, cwd) {
  const root = cwd ?? process.cwd();
  const p = resolve(root, '.harness', 'hooks', jsBasename);
  return existsSync(p) && statSync(p).isFile();
}

/** True when a standalone ruff config file exists in this project. */
export function ruffConfigPresent(cwd) {
  const root = cwd ?? process.cwd();
  const isFile = (name) => {
    const p = resolve(root, name);
    return existsSync(p) && statSync(p).isFile();
  };
  return isFile('.ruff.toml') || isFile('ruff.toml');
}
