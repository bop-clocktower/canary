/**
 * canary-harley (#616) -- checks on the shipped and generated text: the
 * scripts are ASCII, every generated test parses (SC9), every generated test
 * carries its seed (SC5), and the real CLI is deterministic end to end (SC2).
 * Generated tests are parsed here, never executed. Fixtures are synthetic.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { planEmit } from '../claude-code/canary-harley/scripts/emit.mjs';
import { buildProposal } from '../claude-code/canary-harley/scripts/proposal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(
  HERE,
  '..',
  'claude-code',
  'canary-harley',
  'scripts',
);
const CLI = path.join(SCRIPTS, 'cli.mjs');
const SCRIPT_COUNT = 22;

const KINDS = [
  'commutativity',
  'determinism',
  'idempotence',
  'involution',
  'length-preserving',
  'round-trip',
  'total-predicate',
];

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
export function pickOrder(
  order: 'asc' | 'desc',
  shape: { id: string; tag?: boolean },
  limit: number | undefined,
  pair: [string, bigint],
  index: Record<string, number | null>,
): boolean {
  return order === 'asc';
}
`;

const CODEC_NAMES_TS = [
  'encodeToken',
  'decodeToken',
  'normalizeSlug',
  'mergeCounts',
  'sortScores',
  'pickOrder',
  'isSlug',
];

const CODEC_PY = `from typing import Literal, Optional


def encode_token(text: str) -> bytes:
    return text.encode("utf-8")


def decode_token(data: bytes) -> str:
    return data.decode("utf-8")


def normalize_slug(value: str) -> str:
    return value.strip().lower()


def is_slug(value: str) -> bool:
    return value.isalnum()


def merge_counts(a: list[int], b: list[int]) -> list[int]:
    return a


def sort_scores(values: list[float]) -> list[float]:
    return sorted(values)


def pick_order(
    order: Literal["asc", "desc"],
    limit: Optional[int],
    pair: tuple[str, bool],
    index: dict[str, float],
) -> bool:
    return order == "asc"
`;

const CODEC_NAMES_PY = [
  'encode_token',
  'decode_token',
  'normalize_slug',
  'is_slug',
  'merge_counts',
  'sort_scores',
  'pick_order',
];

const AST_SCRIPT =
  'import ast, sys\n' +
  'for p in sys.argv[1:]:\n' +
  '    ast.parse(open(p, encoding="utf-8").read(), filename=p)\n';

type Candidate = { id: string; kind: string; emittable: boolean };
type Proposal = { candidates: Candidate[] };
type Plan = {
  files: { path: string; text: string }[];
  error: { exit: number; message: string } | null;
};

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'harley-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every emittable candidate of the source, planned with one fixed seed. */
function planAll(relative: string, source: string, names: string[]): Plan {
  const proposal = buildProposal({
    path: relative,
    source,
    names,
  }) as Proposal;
  const emittable = proposal.candidates.filter((c) => c.emittable);
  expect(emittable.length).toBe(proposal.candidates.length);
  expect([...new Set(emittable.map((c) => c.kind))].sort()).toEqual(KINDS);
  return planEmit(proposal, {
    ids: emittable.map((c) => c.id),
    file: path.join(root, relative),
    root,
    outDir: null,
    seed: 4242,
    runs: 50,
    force: false,
  }) as Plan;
}

const pythonMissing = (error: Error | undefined) =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const inCi = () => !['', '0', 'false'].includes(process.env.CI ?? '');

describe('canary-harley syntax: shipped scripts', () => {
  it('are ASCII, all twenty-two of them', () => {
    const files = fs.readdirSync(SCRIPTS).filter((n) => n.endsWith('.mjs'));
    // Counted first, so an empty listing cannot pass.
    expect(files).toHaveLength(SCRIPT_COUNT);
    const dirty = files.filter(
      (name) =>
        !/^[\t\n\r\x20-\x7E]*$/.test(
          fs.readFileSync(path.join(SCRIPTS, name), 'utf8'),
        ),
    );
    expect(dirty).toEqual([]);
  });
});

describe('canary-harley syntax: generated tests', () => {
  it.each([
    ['a plain path', 'src/codec.ts'],
    ['a path with a quote in it', "src/it's/codec.ts"],
  ])('transpile with zero diagnostics for %s (SC9)', (_label, relative) => {
    const plan = planAll(relative, CODEC_TS, CODEC_NAMES_TS);
    expect(plan.error).toBeNull();
    expect(plan.files.length).toBeGreaterThanOrEqual(7);
    for (const file of plan.files) {
      const result = ts.transpileModule(file.text, {
        reportDiagnostics: true,
        fileName: path.basename(file.path),
        compilerOptions: { module: ts.ModuleKind.ESNext },
      });
      const messages = (result.diagnostics ?? []).map((d) =>
        ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      );
      expect(messages, file.path).toEqual([]);
      expect(result.outputText).toContain('fc.assert(');
    }
  });

  it('parse as Python where python3 exists (SC9)', (ctx) => {
    const plan = planAll('src/codec.py', CODEC_PY, CODEC_NAMES_PY);
    expect(plan.error).toBeNull();
    expect(plan.files.length).toBeGreaterThanOrEqual(7);
    const paths = plan.files.map((file, index) => {
      const target = path.join(root, `generated_${index}.py`);
      fs.writeFileSync(target, file.text);
      return target;
    });
    const run = spawnSync('python3', ['-c', AST_SCRIPT, ...paths], {
      encoding: 'utf8',
      timeout: 20000,
    });
    if (pythonMissing(run.error)) {
      // In CI a missing interpreter is a failure: the check must not go dark.
      expect(inCi(), 'python3 is required in CI for SC9').toBe(false);
      console.warn(
        'canary-harley: python3 not found; the generated Hypothesis ' +
          `files (${paths.length}) were NOT checked with ast.parse`,
      );
      ctx.skip();
    }
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('carry their seed and pass it to the framework (SC5)', () => {
    const tsPlan = planAll('src/codec.ts', CODEC_TS, CODEC_NAMES_TS);
    const pyPlan = planAll('src/codec.py', CODEC_PY, CODEC_NAMES_PY);
    expect(tsPlan.files.length).toBeGreaterThanOrEqual(7);
    expect(pyPlan.files.length).toBeGreaterThanOrEqual(7);
    for (const file of tsPlan.files) {
      expect(file.text, file.path).toContain('const SEED = 4242;\n');
      expect(file.text).toContain('{ seed: SEED, numRuns: NUM_RUNS }');
    }
    for (const file of pyPlan.files) {
      expect(file.text, file.path).toContain('SEED = 4242\n');
      expect(file.text).toContain('@seed(SEED)\n');
      expect(file.text).toContain('database=None');
      expect(file.text).toContain('deadline=None');
    }
  });
});

describe('canary-harley syntax: the spawned CLI', () => {
  const spawn = (args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

  it('prints the same proposal twice (SC2)', () => {
    const file = path.join(root, 'codec.ts');
    fs.writeFileSync(file, CODEC_TS);
    const argv = ['propose', file, '--root', root, '--json'];
    const first = spawn(argv);
    const second = spawn(argv);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status).toBe(0);
    expect(JSON.parse(first.stdout).candidates.length).toBeGreaterThan(0);
    expect(second.stdout).toBe(first.stdout);
  });

  it('emits the same bytes into two roots (SC2)', () => {
    const texts = ['a', 'b'].map((name) => {
      const base = path.join(root, name);
      fs.mkdirSync(path.join(base, 'src'), { recursive: true });
      const file = path.join(base, 'src', 'codec.ts');
      fs.writeFileSync(file, CODEC_TS);
      const proposed = spawn(['propose', file, '--root', base, '--json']);
      const id: string = JSON.parse(proposed.stdout).candidates[0].id;
      const emitted = spawn(['emit', file, '--root', base, '--confirm', id]);
      expect(emitted.status, emitted.stderr).toBe(0);
      const out = path.join(base, 'tests', 'generated', 'property');
      const names = fs.readdirSync(out);
      expect(names).toHaveLength(1);
      return fs.readFileSync(path.join(out, names[0]), 'utf8');
    });
    expect(texts[0]).toContain('const SEED = ');
    expect(texts[1]).toBe(texts[0]);
  });
});
