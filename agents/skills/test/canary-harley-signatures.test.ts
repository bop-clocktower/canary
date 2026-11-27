/**
 * canary-harley (#616) -- the signature reader: parameter and return types
 * for the functions the engine's extractor names, and a named skip for every
 * declaration it will not read. Fixtures are synthetic.
 */
import { describe, expect, it } from 'vitest';

import {
  langOf,
  readSignatures,
} from '../claude-code/canary-harley/scripts/signatures.mjs';

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

const STRING = { kind: 'string' };
const NUMBER = { kind: 'number' };
const NUMBERS = { kind: 'array', item: NUMBER };
const NO_ANNOTATION = {
  kind: 'unresolved',
  typeText: '',
  reason: 'no type annotation',
};

type Sig = {
  name: string;
  lang: string;
  params: { name: string; type: unknown }[];
  returns: unknown;
  exported: boolean;
};

const readTs = (source: string, names: string[]) =>
  readSignatures(source, 'typescript', names) as {
    signatures: Sig[];
    skipped: { name: string; reason: string }[];
  };

const one = (source: string, name: string) => {
  const result = readTs(source, [name]);
  expect(result.skipped).toEqual([]);
  expect(result.signatures).toHaveLength(1);
  return result.signatures[0];
};

describe('canary-harley signatures: langOf', () => {
  it.each([
    ['src/codec.ts', 'typescript'],
    ['src/View.tsx', 'typescript'],
    ['src/codec.js', 'javascript'],
    ['src/View.jsx', 'javascript'],
    ['src/codec.mjs', 'javascript'],
    ['src/codec.py', 'python'],
    ['SRC/CODEC.TS', 'typescript'],
    ['notes.rb', null],
    ['Makefile', null],
  ])('maps %s to %s', (file, lang) => {
    expect(langOf(file)).toBe(lang);
  });
});

describe('canary-harley signatures: TypeScript', () => {
  it('reads every function of the codec fixture in the given order', () => {
    const { signatures, skipped } = readTs(CODEC_TS, CODEC_NAMES_TS);
    expect(skipped).toEqual([]);
    expect(signatures.map((sig) => sig.name)).toEqual(CODEC_NAMES_TS);
    expect(signatures.every((sig) => sig.lang === 'typescript')).toBe(true);
  });

  it('reads parameter and return types', () => {
    const { signatures } = readTs(CODEC_TS, CODEC_NAMES_TS);
    const byName = new Map(signatures.map((sig) => [sig.name, sig]));
    expect(byName.get('encodeToken')).toEqual({
      name: 'encodeToken',
      lang: 'typescript',
      params: [{ name: 'text', type: STRING }],
      returns: { kind: 'bytes' },
      exported: true,
    });
    expect(byName.get('isSlug')?.returns).toEqual({ kind: 'boolean' });
    expect(byName.get('isSlug')?.params).toEqual([
      { name: 'value', type: STRING },
    ]);
    expect(byName.get('mergeCounts')?.params).toEqual([
      { name: 'a', type: NUMBERS },
      { name: 'b', type: NUMBERS },
    ]);
    expect(byName.get('scoreWidget')?.params[0].type).toEqual({
      kind: 'unresolved',
      typeText: 'Widget',
      reason: 'named type',
    });
    expect(byName.get('clampLevel')?.exported).toBe(false);
    expect(byName.get('isSlug')?.exported).toBe(true);
  });

  it('reads an optional parameter and a defaulted one', () => {
    const sig = one(
      'export function pad(x?: number, y: number = 3): string {}',
      'pad',
    );
    expect(sig.params).toEqual([
      { name: 'x', type: { kind: 'optional', inner: NUMBER } },
      { name: 'y', type: NUMBER },
    ]);
  });

  it('does not wrap an already optional type twice', () => {
    const sig = one('function pad(x?: number | undefined): string {}', 'pad');
    expect(sig.params[0].type).toEqual({ kind: 'optional', inner: NUMBER });
  });

  it('names a parameter with no annotation as unresolved', () => {
    const sig = one('export function tag(value, level = 3) {}', 'tag');
    expect(sig.params).toEqual([
      { name: 'value', type: NO_ANNOTATION },
      { name: 'level', type: NO_ANNOTATION },
    ]);
    expect(sig.returns).toEqual(NO_ANNOTATION);
  });

  it('reads a multi-line parameter list like the one-line form', () => {
    const flat = one(
      'export function join(a: string, b: Record<string, number>): string {}',
      'join',
    );
    const spread = one(
      [
        'export function join(',
        '  a: string,',
        '  b: Record<string, number>,',
        '): string {}',
      ].join('\n'),
      'join',
    );
    expect(spread).toEqual(flat);
    expect(flat.params).toHaveLength(2);
  });

  it('does not end the list at a ) inside a default string', () => {
    const sig = one(
      "export function wrap(text: string, close: string = ')'): string {}",
      'wrap',
    );
    expect(sig.params.map((param) => param.name)).toEqual(['text', 'close']);
    expect(sig.returns).toEqual(STRING);
  });

  it('reads an object return type and a function-typed parameter', () => {
    const sig = one(
      'function box(cb: (n: number) => string): { id: number } {}',
      'box',
    );
    expect(sig.params[0].type).toMatchObject({ reason: 'function type' });
    expect(sig.returns).toEqual({
      kind: 'object',
      fields: [{ name: 'id', type: NUMBER, optional: false }],
    });
  });

  it('reads an arrow function with no return annotation', () => {
    const sig = one('const twice = (n: number) => n * 2;', 'twice');
    expect(sig.params).toEqual([{ name: 'n', type: NUMBER }]);
    expect(sig.returns).toEqual(NO_ANNOTATION);
    expect(sig.exported).toBe(false);
  });

  it('reads a function with no parameters', () => {
    expect(one('export function now(): number {}', 'now').params).toEqual([]);
  });

  it('reads a name that holds a $', () => {
    const sig = one('export function $pick(x: string): string {}', '$pick');
    expect(sig.name).toBe('$pick');
  });

  it.each([
    [
      'async function',
      'export async function hashLater(text: string): Promise<string> {}',
      'hashLater',
    ],
    [
      'async function',
      'export const hashSoon = async (text: string) => text;',
      'hashSoon',
    ],
    ['generic function', 'function pick<T>(items: T[]): T {}', 'pick'],
    ['rest parameter', 'function sum(...parts: number[]): number {}', 'sum'],
    [
      'destructured parameter',
      'function area({ w, h }: Size): number {}',
      'area',
    ],
    [
      'destructured parameter',
      'function first([a, b]: number[]): number {}',
      'first',
    ],
    [
      'overloaded function',
      [
        'function parseLevel(raw: string): number;',
        'function parseLevel(raw: number): number;',
      ].join('\n'),
      'parseLevel',
    ],
    [
      'nested function',
      [
        'export function outer(a: number): number {',
        '  function inner(b: number): number {',
        '    return b;',
        '  }',
        '  return inner(a);',
        '}',
      ].join('\n'),
      'inner',
    ],
    ['declaration not found', 'export const limit = 3;', 'missing'],
    ['not a function', 'const total = (1 + 2) * 3;', 'total'],
    [
      'declaration not readable',
      'function broken(a: string, b: (number {}',
      'broken',
    ],
  ])('skips with the reason "%s"', (reason, source, name) => {
    expect(readTs(source, [name])).toEqual({
      signatures: [],
      skipped: [{ name, reason }],
    });
  });

  it('keeps reading after a skip', () => {
    const source = [
      'export async function hashLater(text: string): Promise<string> {}',
      'export function trimTag(value: string): string {}',
    ].join('\n');
    const result = readTs(source, ['hashLater', 'trimTag']);
    expect(result.signatures.map((sig) => sig.name)).toEqual(['trimTag']);
    expect(result.skipped).toEqual([
      { name: 'hashLater', reason: 'async function' },
    ]);
  });
});

const CODEC_PY = `def encode_token(text: str) -> bytes:
    return text.encode("utf-8")


def decode_token(data: bytes) -> str:
    return data.decode("utf-8")


def normalize_slug(value: str) -> str:
    return value.strip().lower()


def is_slug(value: str) -> bool:
    return value.isalnum()
`;

const CODEC_NAMES_PY = [
  'encode_token',
  'decode_token',
  'normalize_slug',
  'is_slug',
];

const readPy = (source: string, names: string[]) =>
  readSignatures(source, 'python', names) as ReturnType<typeof readTs>;

describe('canary-harley signatures: Python', () => {
  it('reads every function of the codec fixture', () => {
    const { signatures, skipped } = readPy(CODEC_PY, CODEC_NAMES_PY);
    expect(skipped).toEqual([]);
    expect(signatures.map((sig) => sig.name)).toEqual(CODEC_NAMES_PY);
    expect(signatures[0]).toEqual({
      name: 'encode_token',
      lang: 'python',
      params: [{ name: 'text', type: STRING }],
      returns: { kind: 'bytes' },
      exported: true,
    });
    expect(signatures[3].returns).toEqual({ kind: 'boolean' });
  });

  it('drops a default value and keeps the annotation', () => {
    const source = 'def scale(value: float, factor: float = 2.0) -> float:\n';
    const { signatures } = readPy(source, ['scale']);
    expect(signatures[0].params).toEqual([
      { name: 'value', type: NUMBER },
      { name: 'factor', type: NUMBER },
    ]);
    expect(signatures[0].returns).toEqual(NUMBER);
  });

  it('names a missing annotation as unresolved', () => {
    const { signatures } = readPy('def tag(value):\n    return value\n', [
      'tag',
    ]);
    expect(signatures[0].params).toEqual([
      { name: 'value', type: NO_ANNOTATION },
    ]);
    expect(signatures[0].returns).toEqual(NO_ANNOTATION);
  });

  it('reads a parameter list spread over three lines', () => {
    const flat = readPy(
      'def join(a: str, b: dict[str, int]) -> str:\n    return a\n',
      ['join'],
    );
    const spread = readPy(
      [
        'def join(',
        '    a: str,',
        '    b: dict[str, int],',
        ') -> str:',
        '    return a',
        '',
      ].join('\n'),
      ['join'],
    );
    expect(spread).toEqual(flat);
    expect(flat.signatures[0].params).toHaveLength(2);
    expect(flat.signatures[0].returns).toEqual(STRING);
  });

  it.each([
    ['async function', 'async def pull(key: str) -> str:\n', 'pull'],
    [
      'method or nested function',
      'class Store:\n    def put(self, key: str) -> None:\n',
      'put',
    ],
    ['rest parameter', 'def join(*parts: str) -> str:\n', 'join'],
    ['rest parameter', 'def cfg(**opts: int) -> int:\n', 'cfg'],
    [
      'positional-only or keyword-only marker',
      'def clip(value: int, /, low: int) -> int:\n',
      'clip',
    ],
    [
      'positional-only or keyword-only marker',
      'def clip2(value: int, *, low: int) -> int:\n',
      'clip2',
    ],
    ['declaration not found', 'LIMIT = 3\n', 'missing'],
    ['declaration not readable', 'def broken(a: str, b: (int:\n', 'broken'],
  ])('skips with the reason "%s"', (reason, source, name) => {
    expect(readPy(source, [name])).toEqual({
      signatures: [],
      skipped: [{ name, reason }],
    });
  });

  it('reads the module-level def when a method shares its name', () => {
    const source = [
      'class Store:',
      '    def put(self, key: str) -> None:',
      '        pass',
      '',
      'def put(key: str) -> bool:',
      '    return True',
      '',
    ].join('\n');
    const { signatures, skipped } = readPy(source, ['put']);
    expect(skipped).toEqual([]);
    expect(signatures[0].params).toEqual([{ name: 'key', type: STRING }]);
  });
});

describe('canary-harley signatures: JavaScript', () => {
  it('reads an untyped function with unresolved parameters', () => {
    const { signatures, skipped } = readSignatures(
      'export function trimTag(value) {\n  return value.trim();\n}\n',
      'javascript',
      ['trimTag'],
    ) as ReturnType<typeof readTs>;
    expect(skipped).toEqual([]);
    expect(signatures).toEqual([
      {
        name: 'trimTag',
        lang: 'javascript',
        params: [{ name: 'value', type: NO_ANNOTATION }],
        returns: NO_ANNOTATION,
        exported: true,
      },
    ]);
  });
});

// The names come from the engine's extractor, which yields identifiers. The
// reader must still treat a name as text, never as a pattern: a name with a
// regex character must not match another function, and must not throw.
describe('canary-harley signatures: a name is text, not a pattern', () => {
  const TS =
    'export function encode(text: string): string {\n  return text;\n}\n';
  const PY = 'def encode(text: str) -> str:\n    return text\n';

  it.each([
    ['typescript', TS, 'enc.de'],
    ['typescript', TS, 'en\\w+'],
    ['typescript', TS, 'encode|x'],
    ['typescript', TS, 'a(b'],
    ['python', PY, 'enc.de'],
    ['python', PY, 'en\\w+'],
    ['python', PY, 'encode|x'],
    ['python', PY, 'a(b'],
  ] as const)('%s: %s does not read %s as a pattern', (lang, source, name) => {
    const result = readSignatures(source, lang, [name]);
    expect(result.signatures).toEqual([]);
  });

  it('still reads a name that holds a dollar sign', () => {
    const source =
      'export function (text: string): string {\n  return text;\n}\n';
    const result = readSignatures(source, 'typescript', ['']);
    expect(result.signatures).toHaveLength(1);
  });
});
