/**
 * canary-harley -- Python type annotations to type nodes. Built like the
 * TypeScript parser: an ordered rule list over lookup tables, and an
 * `unresolved` node (type text plus reason) for anything it cannot map.
 */
import { matchClose, splitTopLevel } from './scan.mjs';

const PRIMITIVES = new Map([
  ['str', 'string'],
  ['int', 'integer'],
  ['float', 'number'],
  ['bool', 'boolean'],
  ['bytes', 'bytes'],
  ['None', 'null'],
]);

const UNMAPPED = new Map([
  ['Any', 'any'],
  ['Callable', 'function type'],
]);

const LITERAL_WORDS = new Map([
  ['True', true],
  ['False', false],
]);

const GENERIC = /^([A-Za-z_][\w.]*)\[/;
const QUOTED = /^(['"])([\s\S]*)\1$/;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;

const unresolved = (typeText, reason) => ({
  kind: 'unresolved',
  typeText,
  reason,
});

/** A union of `parts`, with `None` folded into an `optional` wrapper. */
function unionOf(parts, text) {
  const members = parts.filter((part) => part !== 'None');
  if (members.length === 0) return unresolved(text, 'no value');
  const nodes = members.map(parsePyType);
  const inner =
    nodes.length === 1 ? nodes[0] : { kind: 'union', members: nodes };
  const isOptional = members.length < parts.length;
  return isOptional ? { kind: 'optional', inner } : inner;
}

function literalOf(part) {
  const quoted = QUOTED.exec(part);
  if (quoted) return { kind: 'literal', value: quoted[2] };
  if (NUMERIC.test(part)) return { kind: 'literal', value: Number(part) };
  if (LITERAL_WORDS.has(part)) {
    return { kind: 'literal', value: LITERAL_WORDS.get(part) };
  }
  return unresolved(part, 'literal value is not readable');
}

function literalsOf(args) {
  const nodes = args.map(literalOf);
  return nodes.length === 1 ? nodes[0] : { kind: 'union', members: nodes };
}

const arrayOf = (args) => ({ kind: 'array', item: parsePyType(args[0] ?? '') });

const tupleOf = (args) => ({ kind: 'tuple', items: args.map(parsePyType) });

function recordOf(args, text) {
  if (args[0] !== 'str') return unresolved(text, 'record key is not str');
  return { kind: 'record', value: parsePyType(args[1] ?? '') };
}

const GENERICS = new Map([
  ['list', arrayOf],
  ['List', arrayOf],
  ['tuple', tupleOf],
  ['Tuple', tupleOf],
  ['dict', recordOf],
  ['Dict', recordOf],
  ['Optional', (args, text) => unionOf([...args, 'None'], text)],
  ['Union', unionOf],
  ['Literal', literalsOf],
  ['Callable', (_args, text) => unresolved(text, 'function type')],
]);

function emptyRule(text) {
  return text === '' ? unresolved('', 'no type annotation') : null;
}

function unionRule(text) {
  const parts = splitTopLevel(text, '|');
  return parts.length < 2 ? null : unionOf(parts, text);
}

/** A quoted annotation is a forward reference: read what it names. */
function forwardRefRule(text) {
  const quoted = QUOTED.exec(text);
  return quoted ? parsePyType(quoted[2]) : null;
}

function genericRule(text) {
  const match = GENERIC.exec(text);
  if (!match) return null;
  const open = match[1].length;
  if (matchClose(text, open) !== text.length - 1) return null;
  // `typing.List` and `List` are the same generic.
  const build = GENERICS.get(match[1].split('.').pop());
  if (!build) return unresolved(text, 'generic type');
  return build(splitTopLevel(text.slice(open + 1, -1), ','), text);
}

function primitiveRule(text) {
  if (PRIMITIVES.has(text)) return { kind: PRIMITIVES.get(text) };
  if (UNMAPPED.has(text)) return unresolved(text, UNMAPPED.get(text));
  return null;
}

const RULES = [
  emptyRule,
  unionRule,
  forwardRefRule,
  genericRule,
  primitiveRule,
];

/**
 * @param {string} text a Python annotation, or '' for none
 * @returns {object} a type node
 */
export function parsePyType(text) {
  const trimmed = text.trim();
  for (const rule of RULES) {
    const node = rule(trimmed);
    if (node !== null) return node;
  }
  return unresolved(trimmed, 'named type');
}
