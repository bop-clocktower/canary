/**
 * canary-harley (#616) -- the bracket-aware scanner and the type-expression
 * parsers. Cases are tagged with the spec's success criteria where one applies
 * (docs/changes/616-canary-harley/proposal.md). Every type and name here is
 * invented.
 */
import { describe, expect, it } from 'vitest';

import {
  matchClose,
  splitTopLevel,
} from '../claude-code/canary-harley/scripts/scan.mjs';
import {
  collectUnresolved,
  parseType,
  typeKey,
} from '../claude-code/canary-harley/scripts/types.mjs';

const prim = (kind: string) => ({ kind });
const STRING = prim('string');
const NUMBER = prim('number');
const array = (item: unknown) => ({ kind: 'array', item });
const tuple = (...items: unknown[]) => ({ kind: 'tuple', items });
const record = (value: unknown) => ({ kind: 'record', value });
const optional = (inner: unknown) => ({ kind: 'optional', inner });
const union = (...members: unknown[]) => ({ kind: 'union', members });
const literal = (value: unknown) => ({ kind: 'literal', value });
const unresolved = (typeText: string, reason: string) => ({
  kind: 'unresolved',
  typeText,
  reason,
});
const ts = (text: string) => parseType(text, 'typescript');
const py = (text: string) => parseType(text, 'python');
const INTEGER = prim('integer');

describe('canary-harley scan: splitTopLevel', () => {
  it('splits on a separator and trims the parts', () => {
    expect(splitTopLevel('a, b', ',')).toEqual(['a', 'b']);
    expect(splitTopLevel('  a ,b  ', ',')).toEqual(['a', 'b']);
  });

  it('keeps a separator inside brackets in one part', () => {
    expect(splitTopLevel('Record<string, number>, x', ',')).toEqual([
      'Record<string, number>',
      'x',
    ]);
    expect(splitTopLevel('{ a: [x, y]; b: z }', ';')).toEqual([
      '{ a: [x, y]; b: z }',
    ]);
    expect(splitTopLevel('f(a, b), [c, d], {e, f}', ',')).toHaveLength(3);
  });

  it('respects quotes', () => {
    expect(splitTopLevel("'a,b' | 'c'", '|')).toEqual(["'a,b'", "'c'"]);
    expect(splitTopLevel('"x|y" | `p|q`', '|')).toEqual(['"x|y"', '`p|q`']);
    expect(splitTopLevel("'it\\'s, fine', b", ',')).toHaveLength(2);
  });

  it('returns no parts for empty text and drops empty parts', () => {
    expect(splitTopLevel('', ',')).toEqual([]);
    expect(splitTopLevel('   ', ',')).toEqual([]);
    expect(splitTopLevel('a, b,', ',')).toEqual(['a', 'b']);
  });

  it('does not read the > of an arrow as a closing bracket', () => {
    expect(splitTopLevel('(x: number) => string, y', ',')).toEqual([
      '(x: number) => string',
      'y',
    ]);
    expect(splitTopLevel('a -> b, c', ',')).toEqual(['a -> b', 'c']);
  });

  it('does not split an arrow when the separator is =', () => {
    expect(splitTopLevel('cb: () => void = noop', '=')).toEqual([
      'cb: () => void',
      'noop',
    ]);
  });

  it('accepts several separator characters at once', () => {
    expect(splitTopLevel('a: x; b: [y, z], c: w', ';,')).toEqual([
      'a: x',
      'b: [y, z]',
      'c: w',
    ]);
  });
});

describe('canary-harley scan: matchClose', () => {
  it('returns the index of the matching closer', () => {
    expect(matchClose('(a: (b)) => c', 0)).toBe(7);
    expect(matchClose('(a: (b)) => c', 4)).toBe(6);
    expect(matchClose('x<Array<y>>z', 1)).toBe(10);
  });

  it('skips a closer inside a quoted string', () => {
    expect(matchClose("(a = ')', b)", 0)).toBe(11);
  });

  it('returns -1 for an unbalanced input', () => {
    expect(matchClose('(a: (b)', 0)).toBe(-1);
    expect(matchClose("(a = ')'", 0)).toBe(-1);
  });
});

describe('canary-harley types: TypeScript expressions', () => {
  it.each([
    ['string', STRING],
    ['number', NUMBER],
    ['boolean', prim('boolean')],
    ['bigint', prim('bigint')],
    ['null', prim('null')],
    ['Uint8Array', prim('bytes')],
    ['Buffer', prim('bytes')],
    ['string[]', array(STRING)],
    ['Array<string>', array(STRING)],
    ['ReadonlyArray<number>', array(NUMBER)],
    ['readonly number[]', array(NUMBER)],
    ['string[][]', array(array(STRING))],
    ['(string | number)[]', array(union(STRING, NUMBER))],
    ['[string, number]', tuple(STRING, NUMBER)],
    ['Record<string, number>', record(NUMBER)],
    ['string | undefined', optional(STRING)],
    ['undefined | string | number', optional(union(STRING, NUMBER))],
    ["'asc' | 'desc'", union(literal('asc'), literal('desc'))],
    ['"asc"', literal('asc')],
    ['42', literal(42)],
    ['-1.5', literal(-1.5)],
    ['true', literal(true)],
    ['false', literal(false)],
    ['  string  ', STRING],
    ['(string)', STRING],
  ])('reads %s', (text, node) => {
    expect(ts(text)).toEqual(node);
  });

  it('reads an object type and marks an optional field', () => {
    expect(ts('{ id: number; tag?: string }')).toEqual({
      kind: 'object',
      fields: [
        { name: 'id', type: NUMBER, optional: false },
        { name: 'tag', type: STRING, optional: true },
      ],
    });
    expect(ts('{ readonly id: number, tags: string[] }')).toEqual({
      kind: 'object',
      fields: [
        { name: 'id', type: NUMBER, optional: false },
        { name: 'tags', type: array(STRING), optional: false },
      ],
    });
    expect(ts('{}')).toEqual({ kind: 'object', fields: [] });
  });

  it.each([
    ['Widget', 'named type'],
    ['any', 'any'],
    ['unknown', 'unknown'],
    ['(x: number) => string', 'function type'],
    ['(x: number) => string[]', 'function type'],
    ['Map<string, number>', 'generic type'],
    ['Record<number, string>', 'record key is not string'],
    ['void', 'no value'],
    ['undefined', 'no value'],
    ['undefined | undefined', 'no value'],
    ['{ [key: string]: number }', 'object member is not a plain field'],
  ])('names %s as unresolved (SC3)', (text, reason) => {
    expect(ts(text)).toEqual(unresolved(text, reason));
  });

  it('names a missing annotation as unresolved', () => {
    expect(ts('')).toEqual(unresolved('', 'no type annotation'));
    expect(ts('   ')).toEqual(unresolved('', 'no type annotation'));
  });

  it('keeps an unresolved member inside its container', () => {
    expect(ts('Widget[]')).toEqual(array(unresolved('Widget', 'named type')));
    expect(ts('[string, Widget]')).toEqual(
      tuple(STRING, unresolved('Widget', 'named type')),
    );
  });

  it('reads javascript sources with the same parser', () => {
    expect(parseType('string[]', 'javascript')).toEqual(array(STRING));
  });
});

describe('canary-harley types: typeKey', () => {
  it.each([
    ['string', 'string'],
    ['string[]', 'array<string>'],
    ['[string, number]', 'tuple<string,number>'],
    ['Record<string, number>', 'record<number>'],
    ['{ id: number; tag?: string }', 'object{id:number,tag?:string}'],
    ['string | undefined', 'optional<string>'],
    ['string | number', 'union<number|string>'],
    ['number | string', 'union<number|string>'],
    ["'asc'", 'literal<"asc">'],
    ['42', 'literal<42>'],
    ['Widget', 'unresolved<Widget>'],
    ['Widget[][]', 'array<array<unresolved<Widget>>>'],
  ])('keys %s as %s', (text, key) => {
    expect(typeKey(ts(text))).toBe(key);
  });
});

describe('canary-harley types: Python expressions', () => {
  it.each([
    ['str', STRING],
    ['int', INTEGER],
    ['float', NUMBER],
    ['bool', prim('boolean')],
    ['bytes', prim('bytes')],
    ['None', prim('null')],
    ['list[int]', array(INTEGER)],
    ['List[int]', array(INTEGER)],
    ['typing.List[int]', array(INTEGER)],
    ['list[list[int]]', array(array(INTEGER))],
    ['tuple[str, int]', tuple(STRING, INTEGER)],
    ['Tuple[str, int]', tuple(STRING, INTEGER)],
    ['dict[str, int]', record(INTEGER)],
    ['Dict[str, float]', record(NUMBER)],
    ['Optional[str]', optional(STRING)],
    ['str | None', optional(STRING)],
    ['None | str | int', optional(union(STRING, INTEGER))],
    ['Union[str, int]', union(STRING, INTEGER)],
    ['Union[str, None]', optional(STRING)],
    ["Literal['a', 'b']", union(literal('a'), literal('b'))],
    ['Literal[3]', literal(3)],
    ['Literal[True]', literal(true)],
    ['Literal[False]', literal(false)],
    ["'int'", INTEGER],
    ['  str  ', STRING],
  ])('reads %s', (text, node) => {
    expect(py(text)).toEqual(node);
  });

  it('gives Union[str, int] and int | str the same key', () => {
    expect(typeKey(py('Union[str, int]'))).toBe('union<integer|string>');
    expect(typeKey(py('int | str'))).toBe('union<integer|string>');
  });

  it.each([
    ['Widget', 'Widget', 'named type'],
    ["'Widget'", 'Widget', 'named type'],
    ['Any', 'Any', 'any'],
    ['Callable[[int], str]', 'Callable[[int], str]', 'function type'],
    ['Callable', 'Callable', 'function type'],
    ['dict[int, str]', 'dict[int, str]', 'record key is not str'],
    ['set[int]', 'set[int]', 'generic type'],
    ['Literal[Color.RED]', 'Color.RED', 'literal value is not readable'],
    ['None | None', 'None | None', 'no value'],
    ['', '', 'no type annotation'],
  ])('names %s as unresolved (SC3)', (text, typeText, reason) => {
    expect(py(text)).toEqual(unresolved(typeText, reason));
  });
});

describe('canary-harley types: collectUnresolved', () => {
  const WIDGET = unresolved('Widget', 'named type');

  it('finds an unresolved node inside nested containers', () => {
    expect(collectUnresolved(ts('[string, Widget][]'))).toEqual([WIDGET]);
    expect(collectUnresolved(ts('Record<string, Widget>'))).toEqual([WIDGET]);
    expect(collectUnresolved(ts('Widget | undefined'))).toEqual([WIDGET]);
    expect(collectUnresolved(ts('{ id: number; w: Widget }'))).toEqual([
      WIDGET,
    ]);
    expect(collectUnresolved(WIDGET)).toEqual([WIDGET]);
  });

  it('returns nothing for a fully resolved node', () => {
    expect(collectUnresolved(ts('{ id: number; tags: string[] }'))).toEqual([]);
    expect(collectUnresolved(py('dict[str, list[int]]'))).toEqual([]);
  });

  it('returns every unresolved member of a union in order', () => {
    expect(collectUnresolved(ts('Widget | Gadget | string'))).toEqual([
      WIDGET,
      unresolved('Gadget', 'named type'),
    ]);
  });
});
