/**
 * Discovery-driven skill-CLI conformance suite (#479).
 *
 * The per-skill copies of these assertions are what drifted: canary-fail-fast's
 * inline prototype test was structurally unreachable and passed against the
 * buggy code, and canary-katana's used an argv where 2 of its 3 assertions
 * passed against the buggy code -- in the skill with the largest blast radius.
 * canary-shadow then shipped with a different `--help` contract, no
 * unknown-flag rejection, and the same prototype hole, and nobody noticed
 * because there was no shared contract to violate.
 *
 * So this suite does not enumerate skills. It DISCOVERS them: every SKILL.md
 * declaring `cli:` is a row, and a new skill is covered the moment it lands
 * rather than when someone remembers to add a seventh copy.
 *
 * The bridge between discovery and the per-skill flag set is `CLI_SPEC`: each
 * cli.mjs exports the spec it hands to `createParser`, and this suite generates
 * that skill's cases from it. A CLI that hand-rolls its parser again exports no
 * spec and fails the first assertion below.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { describe, it, expect, vi, afterEach } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.join(HERE, '..', 'claude-code');

/** Exit code argparse (and therefore this family) reserves for usage errors. */
const EXIT_USAGE = 2;

interface Row {
  name: string;
  dir: string;
  cli: string;
}

/** Every skill whose SKILL.md declares a `cli:` entry point. */
function discover(): Row[] {
  const rows: Row[] = [];
  for (const name of fs.readdirSync(SKILL_ROOT).sort()) {
    const skillMd = path.join(SKILL_ROOT, name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const declared = /^cli:\s*(\S+)\s*$/m.exec(
      fs.readFileSync(skillMd, 'utf8'),
    );
    if (!declared) continue;
    rows.push({
      name,
      dir: path.join(SKILL_ROOT, name),
      cli: path.join(SKILL_ROOT, name, declared[1]),
    });
  }
  return rows;
}

const ROWS = discover();

afterEach(() => vi.restoreAllMocks());

/** Call a skill's exported `main`, capturing everything it writes. */
function callMain(
  main: (argv: string[]) => number,
  argv: string[],
): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(
    (...a: unknown[]) => void stdout.push(a.join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void stderr.push(a.join(' ')),
  );
  const code = main(argv);
  vi.restoreAllMocks();
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

it('discovers the skill CLIs (a zero denominator here is an abstention, not a pass)', () => {
  // Per #508: this suite passing over an empty row set would look identical to
  // it passing over a compliant family.
  expect(ROWS.length).toBeGreaterThanOrEqual(7);
});

describe.each(ROWS)('$name', (row) => {
  const load = async () => {
    const mod = await import(pathToFileURL(row.cli).href);
    return mod as { main: (argv: string[]) => number; CLI_SPEC?: any };
  };

  it('declares a cli: path that resolves', () => {
    expect(fs.existsSync(row.cli)).toBe(true);
  });

  it('is executable (the skill runner execs it via its shebang)', () => {
    // Mode 644 made `canary skills run` map EACCES to a bare exit 1 with no
    // output at all. It hit three skills in one round.
    const mode = fs.statSync(row.cli).mode;
    expect(mode & 0o111).toBeTruthy();
  });

  it('starts with a node shebang', () => {
    expect(
      fs.readFileSync(row.cli, 'utf8').startsWith('#!/usr/bin/env node'),
    ).toBe(true);
  });

  it('routes argument parsing through the shared parser', async () => {
    // The mechanism that stops a seventh hand-rolled copy from landing.
    const mod = await load();
    expect(mod.CLI_SPEC, `${row.name} must export CLI_SPEC`).toBeDefined();
    expect(typeof mod.main).toBe('function');
  });

  it('prints usage on stdout and exits 0 for --help and -h', async () => {
    const { main } = await load();
    for (const spelling of ['--help', '-h']) {
      const r = callMain(main, [spelling]);
      expect(r.code, `${row.name} ${spelling}`).toBe(0);
      expect(r.stdout).toMatch(/^usage: /m);
      expect(r.stderr).toBe('');
    }
  });

  it('rejects an unknown flag with exit 2 on stderr', async () => {
    const { main } = await load();
    const r = callMain(main, ['--definitely-not-a-real-flag']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stderr).toMatch(
      /unrecognized arguments: --definitely-not-a-real-flag/,
    );
    expect(r.stdout).toBe('');
  });

  it('renders usage errors argparse-faithfully', async () => {
    const { main } = await load();
    const r = callMain(main, ['--definitely-not-a-real-flag']);
    expect(r.stderr).toMatch(new RegExp(`^${row.name}: error: `));
  });

  it.each(['toString', 'constructor', 'valueOf'])(
    'rejects the inherited key --%s',
    async (key) => {
      const { main } = await load();
      const r = callMain(main, [`--${key}`, 'x']);
      expect(r.code).toBe(EXIT_USAGE);
      expect(r.stderr).toMatch(/unrecognized arguments:/);
    },
  );

  it('rejects every declared value flag left without a value', async () => {
    const { main, CLI_SPEC } = await load();
    const flags = Object.keys(CLI_SPEC?.values ?? {});
    for (const flag of flags) {
      for (const argv of [[flag], [`${flag}=`], [flag, '']]) {
        const r = callMain(main, argv);
        expect(r.code, `${row.name} ${argv.join(' ')}`).toBe(EXIT_USAGE);
        expect(r.stderr).toMatch(
          new RegExp(`argument ${flag}: expected one argument`),
        );
      }
    }
  });

  it('accepts --flag=value for every declared value flag', async () => {
    // Asserted through the parser rather than through main, because a valid
    // value sends most of these CLIs off to do real filesystem work.
    const { CLI_SPEC } = await load();
    const { createParser } = await import('../lib/parse-args.mjs');
    const parse = createParser(CLI_SPEC);
    const sample = (def: any) => (def.type === 'int' ? '7' : 'some-value');
    // Every required flag has to be present or the parse fails for a reason
    // that has nothing to do with the spelling under test.
    const baseline: string[] = (CLI_SPEC?.required ?? []).map(
      (flag: string) => `${flag}=${sample(CLI_SPEC.values[flag])}`,
    );
    for (const [flag, def] of Object.entries<any>(CLI_SPEC?.values ?? {})) {
      const value = sample(def);
      const argv = [
        ...baseline.filter((a) => !a.startsWith(`${flag}=`)),
        `${flag}=${value}`,
      ];
      const r = parse(argv);
      expect(r.error, `${row.name} ${argv.join(' ')}`).toBeNull();
      expect(r.opts[def.key]).toBe(def.type === 'int' ? 7 : value);
    }
  });

  it('honours the same contract when actually spawned', async () => {
    // The in-process assertions above all import the module; only a real spawn
    // proves the shebang, the exec bit, and the process-exit wiring agree.
    const help = spawnSync(row.cli, ['--help'], { encoding: 'utf8' });
    expect(help.status, `${row.name} --help: ${help.stderr}`).toBe(0);
    expect(help.stdout).toMatch(/^usage: /m);

    const bogus = spawnSync(row.cli, ['--definitely-not-a-real-flag'], {
      encoding: 'utf8',
    });
    expect(bogus.status).toBe(EXIT_USAGE);
    expect(bogus.stderr).toMatch(/unrecognized arguments:/);
  });
});
