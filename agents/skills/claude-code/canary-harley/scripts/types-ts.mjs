/**
 * canary-harley -- TypeScript type expressions to type nodes.
 *
 * A type this parser cannot map is an `unresolved` node that keeps the type
 * text and says why. It is never guessed: a generator for the wrong type would
 * test inputs the function does not accept.
 */
import { matchClose, splitTopLevel } from './scan.mjs';

const PRIMITIVES = new Map([
  ['string', 'string'],
  ['number', 'number'],
  ['boolean', 'boolean'],
  ['bigint', 'bigint'],
  ['null', 'null'],
  ['Uint8Array', 'bytes'],
  ['Buffer', 'bytes'],
]);

const UNMAPPED = new Map([
  ['any', 'any'],
  ['unknown', 'unknown'],
  ['void', 'no value'],
  ['undefined', 'no value'],
  ['never', 'no value'],
]);

const LITERAL_WORDS = new Map([
  ['true', true],
  ['false', false],
]);

const FIELD = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/;
const GENERIC = /^([A-Za-z_$][\w$.]*)</;
const QUOTED = /^(['"])([\s\S]*)\1$/;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;
// A character no type text holds, used to find a top-level `=>`.
const ARROW_MARK = '\u0000';

const unresolved = (typeText, reason) => ({
  kind: 'unresolved',
  typeText,
  reason,
});

const arrayOf = (args) => ({ kind: 'array', item: parseTsType(args[0] ?? '') });

function recordOf(args, text) {
  if (args[0] !== 'string') {
    return unresolved(text, 'record key is not string');
  }
  return { kind: 'record', value: parseTsType(args[1] ?? '') };
}

const GENERICS = new Map([
  ['Array', arrayOf],
  ['ReadonlyArray', arrayOf],
  ['Record', recordOf],
]);

/** True when `text` is one bracket group from its first to last character. */
function isWrapped(text, opener) {
  return text.startsWith(opener) && matchClose(text, 0) === text.length - 1;
}

function emptyRule(text) {
  return text === '' ? unresolved('', 'no type annotation') : null;
}

function unionRule(text) {
  const parts = splitTopLevel(text, '|');
  if (parts.length < 2) return null;
  const members = parts.filter((part) => part !== 'undefined');
  if (members.length === 0) return unresolved(text, 'no value');
  const nodes = members.map(parseTsType);
  const inner =
    nodes.length === 1 ? nodes[0] : { kind: 'union', members: nodes };
  const isOptional = members.length < parts.length;
  return isOptional ? { kind: 'optional', inner } : inner;
}

function functionRule(text) {
  const marked = text.replaceAll('=>', ARROW_MARK);
  const hasArrow = splitTopLevel(marked, ARROW_MARK).length > 1;
  return hasArrow ? unresolved(text, 'function type') : null;
}

function arraySuffixRule(text) {
  if (!text.endsWith('[]')) return null;
  return { kind: 'array', item: parseTsType(text.slice(0, -2)) };
}

function readonlyRule(text) {
  const match = /^readonly\s+([\s\S]+)$/.exec(text);
  return match ? parseTsType(match[1]) : null;
}

function parenRule(text) {
  return isWrapped(text, '(') ? parseTsType(text.slice(1, -1)) : null;
}

function tupleRule(text) {
  if (!isWrapped(text, '[')) return null;
  const items = splitTopLevel(text.slice(1, -1), ',').map(parseTsType);
  return { kind: 'tuple', items };
}

function readField(part) {
  const match = FIELD.exec(part);
  if (!match) return null;
  return {
    name: match[1],
    type: parseTsType(match[3]),
    optional: match[2] === '?',
  };
}

function objectRule(text) {
  if (!isWrapped(text, '{')) return null;
  const fields = splitTopLevel(text.slice(1, -1), ';,').map(readField);
  if (fields.includes(null)) {
    return unresolved(text, 'object member is not a plain field');
  }
  return { kind: 'object', fields };
}

function genericRule(text) {
  const match = GENERIC.exec(text);
  if (!match) return null;
  const open = match[1].length;
  if (matchClose(text, open) !== text.length - 1) return null;
  const build = GENERICS.get(match[1]);
  if (!build) return unresolved(text, 'generic type');
  return build(splitTopLevel(text.slice(open + 1, -1), ','), text);
}

function literalRule(text) {
  const quoted = QUOTED.exec(text);
  if (quoted) return { kind: 'literal', value: quoted[2] };
  if (NUMERIC.test(text)) return { kind: 'literal', value: Number(text) };
  if (LITERAL_WORDS.has(text)) {
    return { kind: 'literal', value: LITERAL_WORDS.get(text) };
  }
  return null;
}

function primitiveRule(text) {
  if (PRIMITIVES.has(text)) return { kind: PRIMITIVES.get(text) };
  if (UNMAPPED.has(text)) return unresolved(text, UNMAPPED.get(text));
  return null;
}

// Order matters: a union is split before its members are read, and a
// function type is named before `[]` or parentheses can take it apart.
const RULES = [
  emptyRule,
  unionRule,
  functionRule,
  arraySuffixRule,
  readonlyRule,
  parenRule,
  tupleRule,
  objectRule,
  genericRule,
  literalRule,
  primitiveRule,
];

/**
 * @param {string} text a TypeScript type expression, or '' for none
 * @returns {object} a type node
 */
export function parseTsType(text) {
  const trimmed = text.trim();
  for (const rule of RULES) {
    const node = rule(trimmed);
    if (node !== null) return node;
  }
  return unresolved(trimmed, 'named type');
}
