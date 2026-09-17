/**
 * Guards #988: `ts/src/cli.ts` imports its sub-app builders through the
 * `commands/cli.ts` barrel so its import count stops growing one per
 * subcommand. The refactor must be behavior-preserving, so the registered
 * top-level command set is pinned by name AND order (commander renders help in
 * registration order), captured from main before the barrel landed.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createCanaryCommand } from '../src/cli.js';

const CLI_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'cli.ts',
);

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
    const src = readFileSync(CLI_SRC, 'utf8');
    const modules = [...src.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map(
      (m) => m[1],
    );
    // commander, cli-common, cli-commands, commands barrel, main-deps. A new
    // sub-app belongs in src/commands/cli.ts, not here.
    expect(modules).toContain('./commands/cli.js');
    expect(modules.length).toBeLessThanOrEqual(5);
  });
});
