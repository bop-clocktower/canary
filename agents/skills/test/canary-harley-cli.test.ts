/**
 * canary-harley (#616) -- engine loading, the CLI usage contract and the
 * `propose` subcommand. Cases are tagged with the spec's success criteria
 * (docs/changes/616-canary-harley/proposal.md). Fixtures are synthetic.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLI_SPEC, main } from '../claude-code/canary-harley/scripts/cli.mjs';
import {
  engineCandidates,
  loadEngine,
} from '../claude-code/canary-harley/scripts/engine.mjs';

const CODEC_TS = `export function encodeToken(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
export function decodeToken(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}
export const isSlug = (value: string): boolean => /^[a-z0-9-]+$/.test(value);
export function mergeCounts(a: number[], b: number[]): number[] {
  return a.map((n, i) => n + (b[i] ?? 0));
}
export function sortScores(values: number[]): number[] {
  return [...values].sort((x, y) => x - y);
}
export function scoreWidget(widget: Widget): number {
  return widget.weight;
}
function clampLevel(level: number): number {
  return Math.max(0, level);
}
`;

const CODEC_PY = `def encode_token(text: str) -> bytes:
    return text.encode("utf-8")


def decode_token(data: bytes) -> str:
    return data.decode("utf-8")


def normalize_slug(value: str) -> str:
    return value.strip().lower()


def is_slug(value: str) -> bool:
    return value.isalnum()
`;

const CRUD_UI_TS = `export function createWidget(name: string): string {
  return name;
}
export function renderBadge(label: string): string {
  return label;
}
`;

const ZERO_PARAM_TS = `export function defaultLevel(): number {
  return 3;
}
`;

const CODEC_NAMES_TS = [
  'encodeToken',
  'decodeToken',
  'normalizeSlug',
  'mergeCounts',
  'sortScores',
  'scoreWidget',
  'clampLevel',
  'isSlug',
];

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'harley-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write `text` under the per-test root and return the absolute path. */
function writeFile(relative: string, text: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

type Deps = { engineDirs?: string[] };

/** Call `main`, capturing what it prints; `sync` is true for a bare number. */
async function run(argv: string[], deps: Deps = {}) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(
    (...args: unknown[]) => void out.push(`${args.join(' ')}\n`),
  );
  vi.spyOn(console, 'error').mockImplementation(
    (...args: unknown[]) => void err.push(`${args.join(' ')}\n`),
  );
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const result = main(argv, deps);
  const code = await result;
  vi.restoreAllMocks();
  return {
    code,
    sync: typeof result === 'number',
    stdout: out.join(''),
    stderr: err.join(''),
  };
}

describe('canary-harley cli: usage contract', () => {
  it('prints usage and returns 0 synchronously for --help', async () => {
    const r = await run(['--help']);
    expect(r.sync).toBe(true);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^usage: canary-harley/);
    expect(r.stdout).toContain('propose');
    expect(r.stdout).toContain('--confirm');
    expect(r.stderr).toBe('');
  });

  it.each([
    [[], 'the following arguments are required: command'],
    [['frobnicate'], "invalid choice: 'frobnicate'"],
    [['propose'], 'the following arguments are required: FILE'],
    [['propose', 'a.ts', 'b.ts'], 'unrecognized arguments: b.ts'],
    [['emit', 'a.ts', '--confirm', 'x', '--runs', '0'], '--runs'],
    [['emit', 'a.ts', '--confirm', ' , '], '--confirm'],
  ])('exits 2 for %j', async (argv, message) => {
    const r = await run(argv);
    expect(r.sync).toBe(true);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^canary-harley: error: /);
    expect(r.stderr).toContain(message);
    expect(r.stdout).toBe('');
  });

  it('refuses emit without --confirm before the engine is read (SC4)', async () => {
    const file = writeFile('src/codec.ts', CODEC_TS);
    const engineDirs = [path.join(root, 'no-engine')];
    const r = await run(['emit', file, '--root', root], { engineDirs });
    expect(r.sync).toBe(true);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'the following arguments are required: --confirm',
    );
    // An engine lookup would have named the directory it tried.
    expect(r.stderr).not.toContain('no-engine');
    expect(fs.existsSync(path.join(root, 'tests'))).toBe(false);
  });

  it('declares its program name in CLI_SPEC', () => {
    expect(CLI_SPEC.prog).toBe('canary-harley');
  });
});

type Candidate = {
  id: string;
  kind: string;
  functions: string[];
  status: string;
  basis: string;
  emittable: boolean;
  blocked: string[];
};

const ABSTENTIONS: [string, string, string][] = [
  ['an empty file', '', 'no functions'],
  ['only CRUD- and UI-shaped functions', CRUD_UI_TS, 'only CRUD- or UI-shaped'],
  ['only a zero-parameter function', ZERO_PARAM_TS, 'no candidates'],
];

describe('canary-harley cli: propose', () => {
  it.each([
    ['TypeScript', 'src/codec.ts', CODEC_TS],
    ['Python', 'src/codec.py', CODEC_PY],
  ])(
    'ranks the %s round trip above determinism (SC1)',
    async (_l, rel, text) => {
      const file = writeFile(rel, text);
      const r = await run(['propose', file, '--root', root]);
      expect(r.sync).toBe(false);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout.startsWith(`# canary-harley proposal: ${rel}\n`)).toBe(
        true,
      );
      const lines = r.stdout.split('\n');
      const roundTrip = lines.findIndex((line) => line.includes('round-trip:'));
      const determinism = lines.findIndex((line) =>
        line.includes('determinism:'),
      );
      expect(roundTrip).toBeGreaterThan(-1);
      expect(determinism).toBeGreaterThan(roundTrip);
      expect(lines[roundTrip]).toContain('likely');
      expect(r.stdout.endsWith('\n')).toBe(true);
      expect(r.stdout.endsWith('\n\n')).toBe(false);
    },
  );

  it('prints the same bytes on a second run (SC2)', async () => {
    const file = writeFile('src/codec.ts', CODEC_TS);
    const first = await run(['propose', file, '--root', root]);
    const second = await run(['propose', file, '--root', root]);
    expect(first.stdout.length).toBeGreaterThan(0);
    expect(second.stdout).toBe(first.stdout);
    const json = await run(['propose', file, '--root', root, '--json']);
    const again = await run(['propose', file, '--root', root, '--json']);
    expect(again.stdout).toBe(json.stdout);
  });

  it('prints the proposal as JSON with --json (SC3)', async () => {
    const file = writeFile('src/codec.ts', CODEC_TS);
    const r = await run(['propose', file, '--root', root, '--json']);
    expect(r.code).toBe(0);
    const proposal = JSON.parse(r.stdout);
    const candidates: Candidate[] = proposal.candidates;
    expect(proposal.schema).toBe('canary.harley-proposal/1');
    expect(proposal.source.path).toBe('src/codec.ts');
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map((c) => c.status)).toEqual(
      candidates.map(() => 'proposed'),
    );
    expect(candidates.map((c) => c.basis)).toEqual(
      candidates.map(() => 'heuristic'),
    );
    const widget = candidates.filter((c) => c.functions[0] === 'scoreWidget');
    expect(widget).toHaveLength(1);
    expect(widget[0].emittable).toBe(false);
    expect(widget[0].blocked.join(' ')).toContain("'Widget'");
  });

  it('writes the JSON with --json-out and still prints markdown', async () => {
    const file = writeFile('src/codec.ts', CODEC_TS);
    const out = path.join(root, 'out', 'p.json');
    const r = await run(['propose', file, '--root', root, '--json-out', out]);
    const json = await run(['propose', file, '--root', root, '--json']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^# canary-harley proposal: src\/codec\.ts\n/);
    expect(fs.readFileSync(out, 'utf8')).toBe(json.stdout);
  });

  it('exits 1 without printing when --json-out cannot be written', async () => {
    const file = writeFile('src/codec.ts', CODEC_TS);
    // The parent of the target is a regular file, so no directory can be made.
    const blocker = writeFile('blocker', 'not a directory\n');
    const out = path.join(blocker, 'out.json');
    const r = await run(['propose', file, '--root', root, '--json-out', out]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^canary-harley: cannot write /);
    expect(r.stderr).toContain(out);
    // The write is tried first, as canary-sweep does: a failed run prints no
    // proposal that a caller could take for a complete result.
    expect(r.stdout).toBe('');
    expect(fs.readFileSync(blocker, 'utf8')).toBe('not a directory\n');
  });

  it('keeps one function with --function', async () => {
    const file = writeFile('src/codec.ts', CODEC_TS);
    const argv = ['propose', file, '--root', root, '--json'];
    const r = await run([...argv, '--function', 'normalizeSlug']);
    const candidates: Candidate[] = JSON.parse(r.stdout).candidates;
    expect(r.code).toBe(0);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map((c) => c.functions)).toEqual(
      candidates.map(() => ['normalizeSlug']),
    );
  });

  it('abstains on a --function the file does not hold', async () => {
    const file = writeFile('src/codec.ts', CODEC_TS);
    const r = await run(['propose', file, '--function', 'missing']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("no function named 'missing'");
  });

  it('writes nothing under tests/', async () => {
    const file = writeFile('src/codec.ts', CODEC_TS);
    await run(['propose', file, '--root', root]);
    expect(fs.readdirSync(root)).toEqual(['src']);
  });

  it('prints the path as given when the file is outside --root', async () => {
    const file = writeFile('src/codec.ts', CODEC_TS);
    const other = path.join(root, 'elsewhere');
    const r = await run(['propose', file, '--root', other]);
    expect(r.stdout.startsWith(`# canary-harley proposal: ${file}\n`)).toBe(
      true,
    );
  });

  it.each(ABSTENTIONS)('abstains on %s (SC7)', async (_l, text, reason) => {
    const file = writeFile('src/widget.ts', text);
    const r = await run(['propose', file, '--root', root]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^canary-harley: abstained: /);
    expect(r.stderr).toContain(reason);
    expect(r.stdout).not.toContain('## Candidates');
    expect(r.stdout).toContain('Nothing was generated.');
  });

  it('abstains on a file it cannot read (SC7)', async () => {
    const file = path.join(root, 'src', 'absent.ts');
    const r = await run(['propose', file, '--root', root]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^canary-harley: abstained: cannot read /);
    expect(r.stderr).toContain(file);
    expect(r.stdout).toBe('');
  });

  it('names every engine directory tried (SC8)', async () => {
    const file = writeFile('src/codec.ts', CODEC_TS);
    const engineDirs = [path.join(root, 'none-a'), path.join(root, 'none-b')];
    const r = await run(['propose', file, '--root', root], { engineDirs });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^canary-harley: abstained: /);
    expect(r.stderr).toContain(engineDirs[0]);
    expect(r.stderr).toContain(engineDirs[1]);
    expect(r.stdout).toBe('');
  });
});

describe('canary-harley engine: engineCandidates', () => {
  it('puts CANARY_ENGINE_DIR first, then the two shipped layouts', () => {
    const env = { CANARY_ENGINE_DIR: '/x/engine' };
    expect(engineCandidates(root, env)).toEqual([
      '/x/engine',
      path.join(root, 'ts', 'dist'),
      path.join(root, 'dist', 'engine'),
    ]);
  });

  it('lists only the shipped layouts without the override', () => {
    expect(engineCandidates(root, {})).toEqual([
      path.join(root, 'ts', 'dist'),
      path.join(root, 'dist', 'engine'),
    ]);
  });
});

describe('canary-harley engine: loadEngine', () => {
  it('loads the extractor from the built engine', async () => {
    const engine = await loadEngine();
    expect(engine.ok).toBe(true);
    expect(engine.dir).toMatch(/dist/);
    const file = writeFile('codec.ts', CODEC_TS);
    expect(engine.extractFileFunctions?.(file)).toEqual(CODEC_NAMES_TS);
  });

  it('names every directory tried when no engine is found (SC8)', async () => {
    const tried = [path.join(root, 'none-a'), path.join(root, 'none-b')];
    const engine = await loadEngine(tried);
    expect(engine.ok).toBe(false);
    expect(engine.error).toContain(tried[0]);
    expect(engine.error).toContain(tried[1]);
    expect(engine.error).toContain('npm --prefix ts run build');
    expect(engine.error).toContain('CANARY_ENGINE_DIR');
  });

  it('rejects an engine module without the extractor', async () => {
    writeFile('engine/mcp-server.js', 'export const other = 1;\n');
    writeFile('engine/package.json', '{ "type": "module" }\n');
    const engine = await loadEngine([path.join(root, 'engine')]);
    expect(engine.ok).toBe(false);
    expect(engine.error).toContain('extractFileFunctions');
    expect(engine.error).toContain(path.join(root, 'engine'));
  });
});
