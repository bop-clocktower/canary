/**
 * Guards #988: `ts/src/cli.ts` loops over the `commands/cli.ts` COMMANDS
 * registry array, fed by per-domain registries, so no module's import count
 * grows one per subcommand past the perf gate's 15 threshold. The refactor must be behavior-preserving, so the registered
 * top-level command set is pinned by name AND order (commander renders help in
 * registration order), captured from main before the barrel landed.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createCanaryCommand } from '../src/cli.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CLI_SRC = join(SRC, 'cli.ts');
const COMMANDS_DIR = join(SRC, 'commands');

/** Cap per registry module: 3 below the 15-import threshold, so it trips first. */
const MAX_REGISTRY_IMPORTS = 12;

function importedModules(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map(
    (m) => m[1] ?? '',
  );
}

const EXPECTED_COMMANDS = [
  'recommend',
  'frameworks',
  'feedback',
  'run',
  'init',
  'setup',
  'migrate',
  'review-test',
  'flake-check',
  'promote-check',
  'vacuity-check',
  'heal-test',
  'version',
  'upgrade',
  'overlay',
  'doctor',
  'uninstall',
  'ticket-update',
  'history',
  'analyze',
  'guardian',
  'skills',
  'workflow',
  'company-knowledge',
  'batwoman',
  'rewind',
  'order',
  'scaling-curve',
  'permission-matrix',
  'ci-ready',
  'inventory',
  'gen-data',
  'briefing',
];

describe('canary command registry (#988)', () => {
  it('registers the same top-level commands in the same order', () => {
    const names = createCanaryCommand({
      out: () => {},
      err: () => {},
    }).commands.map((c) => c.name());
    expect(names).toEqual(EXPECTED_COMMANDS);
  });

  it('keeps cli.ts module imports independent of the subcommand count', () => {
    const modules = importedModules(CLI_SRC);
    // commander, cli-common, cli-commands, commands registry, main-deps. A new
    // sub-app belongs in a domain registry under src/commands/, not here.
    expect(modules).toContain('./commands/cli.js');
    expect(modules.length).toBeLessThanOrEqual(5);
  });

  it('keeps every command registry module at or under 12 imports', () => {
    const registries = readdirSync(COMMANDS_DIR, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts'));
    // Denominator guard: the aggregator plus four domain registries.
    expect(registries.length).toBeGreaterThanOrEqual(5);
    for (const file of registries) {
      const count = importedModules(join(COMMANDS_DIR, file)).length;
      expect({ file, count }).toEqual({
        file,
        count: Math.min(count, MAX_REGISTRY_IMPORTS),
      });
    }
  });
});
