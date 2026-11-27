/**
 * canary-harley (#616) -- emit planning and the `emit` subcommand: the
 * confirmation lookup, seeds, output containment and overwrite refusal.
 * Cases are tagged with the spec's success criteria
 * (docs/changes/616-canary-harley/proposal.md). Fixtures are synthetic.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from '../claude-code/canary-harley/scripts/cli.mjs';
import { planEmit } from '../claude-code/canary-harley/scripts/emit.mjs';
import { buildProposal } from '../claude-code/canary-harley/scripts/proposal.mjs';

const CODEC_TS = `export function encodeToken(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
export function decodeToken(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}
export function scoreWidget(widget: Widget): number {
  return widget.weight;
}
`;

const CODEC_NAMES_TS = [
  'encodeToken',
  'decodeToken',
  'normalizeSlug',
  'scoreWidget',
];

const CODEC_PY = `def encode_token(text: str) -> bytes:
    return text.encode("utf-8")


def decode_token(data: bytes) -> str:
    return data.decode("utf-8")
`;

const CODEC_NAMES_PY = ['encode_token', 'decode_token'];

const CODEC_JS = `export function encodeToken(text) {
  return text;
}
`;

type Candidate = { id: string; kind: string; functions: string[] };
type Proposal = { candidates: Candidate[]; signatures: object[] };
type Plan = {
  files: { path: string; text: string }[];
  error: { exit: number; message: string } | null;
};
type Options = {
  ids?: string[];
  file?: string;
  outDir?: string | null;
  seed?: number | null;
  runs?: number;
  force?: boolean;
};

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'harley-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const propose = (rel: string, source: string, names: string[]) =>
  buildProposal({ path: rel, source, names }) as Proposal;

const tsProposal = () => propose('src/codec.ts', CODEC_TS, CODEC_NAMES_TS);
const pyProposal = () => propose('src/codec.py', CODEC_PY, CODEC_NAMES_PY);

const idOf = (proposal: Proposal, kind: string, fn: string) =>
  proposal.candidates.filter((c) => c.kind === kind && c.functions[0] === fn)[0]
    .id;

const plan = (proposal: Proposal, options: Options) =>
  planEmit(proposal, {
    ids: [],
    file: path.join(root, 'src', 'codec.ts'),
    root,
    outDir: null,
    seed: null,
    runs: 100,
    force: false,
    ...options,
  }) as Plan;

const OUT = ['tests', 'generated', 'property'];

describe('canary-harley emit: planEmit', () => {
  it('plans one fast-check file for a confirmed round trip (SC5)', () => {
    const proposal = tsProposal();
    const id = idOf(proposal, 'round-trip', 'encodeToken');
    const result = plan(proposal, { ids: [id] });
    expect(result.error).toBeNull();
    expect(result.files.map((file) => file.path)).toEqual([
      path.join(
        root,
        ...OUT,
        'codec.encodeToken-decodeToken.round-trip.property.test.ts',
      ),
    ]);
    expect(result.files[0].text).toContain("from '../../../src/codec';");
    expect(fs.existsSync(path.join(root, 'tests'))).toBe(false);
  });

  it('plans one Hypothesis file for a Python source (SC5)', () => {
    const proposal = pyProposal();
    const id = idOf(proposal, 'round-trip', 'encode_token');
    const file = path.join(root, 'src', 'codec.py');
    const result = plan(proposal, { ids: [id], file });
    expect(result.error).toBeNull();
    expect(result.files.map((f) => f.path)).toEqual([
      path.join(
        root,
        ...OUT,
        'test_codec_encode_token_decode_token_round_trip_property.py',
      ),
    ]);
    expect(result.files[0].text).toContain('from src.codec import ');
  });

  it('plans one file per distinct id', () => {
    const proposal = tsProposal();
    const first = idOf(proposal, 'round-trip', 'encodeToken');
    const second = idOf(proposal, 'idempotence', 'normalizeSlug');
    expect(plan(proposal, { ids: [first, second] }).files).toHaveLength(2);
    expect(plan(proposal, { ids: [first, first] }).files).toHaveLength(1);
  });

  it('derives the seed from the id unless one is given', () => {
    const proposal = tsProposal();
    const first = idOf(proposal, 'round-trip', 'encodeToken');
    const second = idOf(proposal, 'idempotence', 'normalizeSlug');
    const hex = createHash('sha256').update(first).digest('hex');
    const derived = parseInt(hex.slice(0, 8), 16);
    const byDefault = plan(proposal, { ids: [first] });
    expect(byDefault.files[0].text).toContain(`const SEED = ${derived};\n`);
    expect(byDefault.files[0].text).toContain('const NUM_RUNS = 100;\n');
    const given = plan(proposal, { ids: [first, second], seed: 7, runs: 25 });
    expect(given.files).toHaveLength(2);
    for (const file of given.files) {
      expect(file.text).toContain('const SEED = 7;\n');
      expect(file.text).toContain('const NUM_RUNS = 25;\n');
    }
  });

  it('refuses an id the file does not derive now (SC6)', () => {
    const proposal = tsProposal();
    const good = idOf(proposal, 'round-trip', 'encodeToken');
    const stale = 'round-trip:encodeToken+decodeToken:00000000';
    for (const ids of [[stale], [good, stale]]) {
      const result = plan(proposal, { ids });
      expect(result.files).toEqual([]);
      expect(result.error?.exit).toBe(3);
      expect(result.error?.message).toContain(stale);
      expect(result.error?.message).toContain('not derivable');
    }
  });

  it('refuses a candidate whose type has no generator (SC3)', () => {
    const proposal = tsProposal();
    const id = idOf(proposal, 'determinism', 'scoreWidget');
    const result = plan(proposal, { ids: [id] });
    expect(result.files).toEqual([]);
    expect(result.error?.exit).toBe(3);
    expect(result.error?.message).toContain("'Widget'");
    expect(result.error?.message).toContain('cannot be emitted');
  });

  it('refuses untyped JavaScript', () => {
    const proposal = propose('src/codec.js', CODEC_JS, ['encodeToken']);
    const id = idOf(proposal, 'determinism', 'encodeToken');
    const file = path.join(root, 'src', 'codec.js');
    const result = plan(proposal, { ids: [id], file });
    expect(result.error?.exit).toBe(3);
    expect(result.error?.message).toContain('untyped JavaScript');
  });

  it('refuses a function name that is not an identifier', () => {
    const proposal = tsProposal();
    const first = proposal.candidates[0];
    const forged = {
      ...proposal,
      candidates: [{ ...first, functions: ['a(); danger', 'decodeToken'] }],
    };
    const result = plan(forged, { ids: [first.id] });
    expect(result.files).toEqual([]);
    expect(result.error?.exit).toBe(3);
    expect(result.error?.message).toContain('not an identifier');
  });

  it.each([
    ['a directory outside tests/generated', 'src'],
    ['a parent path', '../elsewhere'],
    ['a climb out of tests/generated', 'tests/generated/../../src'],
    ['an absolute path outside the root', path.join(os.tmpdir(), 'elsewhere')],
    ['tests/generated itself escaped by name', 'tests/generated-other'],
  ])('refuses --out-dir %s', (_label, outDir) => {
    const proposal = tsProposal();
    const id = idOf(proposal, 'round-trip', 'encodeToken');
    const result = plan(proposal, { ids: [id], outDir });
    expect(result.files).toEqual([]);
    expect(result.error?.exit).toBe(2);
    expect(result.error?.message).toContain('tests/generated');
  });

  it('accepts an --out-dir inside tests/generated', () => {
    const proposal = tsProposal();
    const id = idOf(proposal, 'round-trip', 'encodeToken');
    const relative = plan(proposal, {
      ids: [id],
      outDir: 'tests/generated/custom',
    });
    expect(relative.error).toBeNull();
    expect(path.dirname(relative.files[0].path)).toBe(
      path.join(root, 'tests', 'generated', 'custom'),
    );
    expect(relative.files[0].text).toContain("from '../../../src/codec';");
    const absolute = plan(proposal, {
      ids: [id],
      outDir: path.join(root, 'tests', 'generated', 'deep', 'er'),
    });
    expect(absolute.error).toBeNull();
    expect(absolute.files[0].text).toContain("from '../../../../src/codec';");
  });

  it('refuses an --out-dir that is a symlink out of tests/generated', () => {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'tests', 'generated'), { recursive: true });
    fs.symlinkSync(
      path.join(root, 'src'),
      path.join(root, 'tests', 'generated', 'link'),
      'dir',
    );
    const proposal = tsProposal();
    const id = idOf(proposal, 'round-trip', 'encodeToken');
    for (const outDir of ['tests/generated/link', 'tests/generated/link/x']) {
      const result = plan(proposal, { ids: [id], outDir });
      expect(result.files).toEqual([]);
      expect(result.error?.exit).toBe(2);
      expect(result.error?.message).toContain('tests/generated');
    }
  });

  it('refuses to overwrite an existing file without force', () => {
    const proposal = tsProposal();
    const id = idOf(proposal, 'round-trip', 'encodeToken');
    const target = plan(proposal, { ids: [id] }).files[0].path;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '// edited by hand\n');
    const refused = plan(proposal, { ids: [id] });
    expect(refused.files).toEqual([]);
    expect(refused.error?.exit).toBe(2);
    expect(refused.error?.message).toContain(target);
    expect(refused.error?.message).toContain('--force');
    const forced = plan(proposal, { ids: [id], force: true });
    expect(forced.error).toBeNull();
    expect(forced.files).toHaveLength(1);
    expect(fs.readFileSync(target, 'utf8')).toBe('// edited by hand\n');
  });

  it('refuses a Python path with a segment that is not an identifier', () => {
    const proposal = pyProposal();
    const id = idOf(proposal, 'round-trip', 'encode_token');
    const file = path.join(root, 'my-pkg', 'codec.py');
    const result = plan(proposal, { ids: [id], file });
    expect(result.files).toEqual([]);
    expect(result.error?.exit).toBe(3);
    expect(result.error?.message).toContain("'my-pkg'");
  });

  it.each([
    ['the source path', 'src/co\ndec.ts', null],
    ['--out-dir', 'src/codec.ts', 'tests/generated/a\u0000b'],
    ['--out-dir (a separator)', 'src/codec.ts', 'tests/generated/a\u2028b'],
  ])('refuses a control character in %s', (_label, relative, outDir) => {
    const proposal = tsProposal();
    const id = idOf(proposal, 'round-trip', 'encodeToken');
    const file = path.join(root, relative);
    const result = plan(proposal, { ids: [id], outDir, file });
    expect(result.files).toEqual([]);
    expect(result.error?.exit).toBe(2);
    expect(result.error?.message).toContain('control character');
  });

  it('escapes a quote in the source path so the import still parses', () => {
    const proposal = tsProposal();
    const id = idOf(proposal, 'round-trip', 'encodeToken');
    const file = path.join(root, 'src', "it's", 'codec.ts');
    const result = plan(proposal, { ids: [id], file });
    expect(result.error).toBeNull();
    expect(result.files[0].text).toContain(
      "from '../../../src/it\\'s/codec';\n",
    );
  });
});

type Deps = { engineDirs?: string[] };

/** Call `main` and capture what it prints. */
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
  const code = await main(argv, deps);
  vi.restoreAllMocks();
  return { code, stdout: out.join(''), stderr: err.join('') };
}

function writeSource(relative: string, text: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** The ids `propose --json` prints for the file, keyed `kind:firstFunction`. */
async function proposedIds(file: string) {
  const r = await run(['propose', file, '--root', root, '--json']);
  const candidates: Candidate[] = JSON.parse(r.stdout).candidates;
  return new Map(candidates.map((c) => [`${c.kind}:${c.functions[0]}`, c.id]));
}

const generated = () => path.join(root, ...OUT);
const TS_NAME = 'codec.encodeToken-decodeToken.round-trip.property.test.ts';

describe('canary-harley cli: emit', () => {
  it('writes exactly one seeded file for one confirmed id (SC5)', async () => {
    const file = writeSource('src/codec.ts', CODEC_TS);
    const id = (await proposedIds(file)).get('round-trip:encodeToken') ?? '';
    const r = await run(['emit', file, '--root', root, '--confirm', id]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(fs.readdirSync(generated())).toEqual([TS_NAME]);
    expect(r.stdout).toContain(`wrote tests/generated/property/${TS_NAME}\n`);
    expect(r.stdout).toContain('harness-property-test');
    expect(r.stdout).toContain('canary-promote-test');
    const text = fs.readFileSync(path.join(generated(), TS_NAME), 'utf8');
    expect(text).toMatch(/^const SEED = \d+;$/m);
    expect(text).toContain('{ seed: SEED, numRuns: NUM_RUNS }');
  });

  it('writes only the confirmed candidates (SC5)', async () => {
    const file = writeSource('src/codec.ts', CODEC_TS);
    const ids = await proposedIds(file);
    expect(ids.size).toBeGreaterThan(2);
    const confirm = [
      ids.get('round-trip:encodeToken'),
      ids.get('idempotence:normalizeSlug'),
    ].join(' , ');
    const argv = ['emit', file, '--root', root, '--confirm', confirm];
    const r = await run([...argv, '--seed', '7', '--runs', '25']);
    expect(r.code).toBe(0);
    const names = fs.readdirSync(generated()).sort();
    expect(names).toEqual([
      TS_NAME,
      'codec.normalizeSlug.idempotence.property.test.ts',
    ]);
    for (const name of names) {
      const text = fs.readFileSync(path.join(generated(), name), 'utf8');
      expect(text).toContain('const SEED = 7;\n');
      expect(text).toContain('const NUM_RUNS = 25;\n');
    }
  });

  it('writes a seeded Hypothesis file for Python (SC5)', async () => {
    const file = writeSource('src/codec.py', CODEC_PY);
    const id = (await proposedIds(file)).get('round-trip:encode_token') ?? '';
    const r = await run(['emit', file, '--root', root, '--confirm', id]);
    expect(r.code).toBe(0);
    const names = fs.readdirSync(generated());
    expect(names).toEqual([
      'test_codec_encode_token_decode_token_round_trip_property.py',
    ]);
    const text = fs.readFileSync(path.join(generated(), names[0]), 'utf8');
    expect(text).toContain('@seed(SEED)\n');
    expect(text).toContain('database=None');
    expect(text).toContain('deadline=None');
  });

  it('refuses an id issued before the signature changed (SC6)', async () => {
    const file = writeSource('src/codec.ts', CODEC_TS);
    const id = (await proposedIds(file)).get('round-trip:encodeToken') ?? '';
    writeSource(
      'src/codec.ts',
      CODEC_TS.replace('text: string', 'text: number'),
    );
    const r = await run(['emit', file, '--root', root, '--confirm', id]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^canary-harley: /);
    expect(r.stderr).toContain(id);
    expect(r.stderr).toContain('not derivable');
    expect(r.stdout).toBe('');
    expect(fs.existsSync(path.join(root, 'tests'))).toBe(false);
  });

  it('refuses to overwrite without --force', async () => {
    const file = writeSource('src/codec.ts', CODEC_TS);
    const id = (await proposedIds(file)).get('round-trip:encodeToken') ?? '';
    const argv = ['emit', file, '--root', root, '--confirm', id];
    expect((await run(argv)).code).toBe(0);
    const target = path.join(generated(), TS_NAME);
    fs.writeFileSync(target, '// edited by hand\n');
    const refused = await run(argv);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--force');
    expect(fs.readFileSync(target, 'utf8')).toBe('// edited by hand\n');
    const forced = await run([...argv, '--force']);
    expect(forced.code).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).not.toContain('edited by hand');
  });

  it.each([
    ['src'],
    ['../elsewhere'],
    [path.join(os.tmpdir(), 'harley-elsewhere')],
  ])('refuses --out-dir %s and writes nothing', async (outDir) => {
    const file = writeSource('src/codec.ts', CODEC_TS);
    const id = (await proposedIds(file)).get('round-trip:encodeToken') ?? '';
    const argv = ['emit', file, '--root', root, '--confirm', id];
    const r = await run([...argv, '--out-dir', outDir]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('tests/generated');
    expect(fs.readdirSync(root)).toEqual(['src']);
    expect(fs.readdirSync(path.join(root, 'src'))).toEqual(['codec.ts']);
    expect(fs.existsSync(path.join(os.tmpdir(), 'harley-elsewhere'))).toBe(
      false,
    );
  });

  it('writes nothing for a source path with a newline in it', async () => {
    const file = writeSource("src/it's\nx/codec.ts", CODEC_TS);
    const id = (await proposedIds(file)).get('round-trip:encodeToken') ?? '';
    const r = await run(['emit', file, '--root', root, '--confirm', id]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('control character');
    expect(fs.readdirSync(root)).toEqual(['src']);
  });

  it('names every engine directory tried and writes nothing (SC8)', async () => {
    const file = writeSource('src/codec.ts', CODEC_TS);
    const engineDirs = [path.join(root, 'none-a'), path.join(root, 'none-b')];
    const argv = ['emit', file, '--root', root, '--confirm', 'x'];
    const r = await run(argv, { engineDirs });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(engineDirs[0]);
    expect(r.stderr).toContain(engineDirs[1]);
    expect(fs.readdirSync(root)).toEqual(['src']);
  });

  it('exits 1 when the output directory cannot be made', async () => {
    const file = writeSource('src/codec.ts', CODEC_TS);
    const id = (await proposedIds(file)).get('round-trip:encodeToken') ?? '';
    // A regular file sits where the directory would go.
    writeSource('tests/generated', 'not a directory\n');
    const r = await run(['emit', file, '--root', root, '--confirm', id]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^canary-harley: cannot write /);
    expect(r.stderr).toContain(generated());
    expect(r.stdout).toBe('');
  });

  it('abstains on a source it cannot read', async () => {
    const file = path.join(root, 'src', 'absent.ts');
    const r = await run(['emit', file, '--root', root, '--confirm', 'x']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('cannot read');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
