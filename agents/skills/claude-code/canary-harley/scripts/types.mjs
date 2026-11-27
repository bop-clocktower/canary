/**
 * canary-harley -- the type-node seam. `parseType` picks the parser for a
 * language and `typeKey` gives a node its canonical text, the form a candidate
 * id hashes.
 *
 * Nodes are plain objects: `{ kind: 'string' }`, `{ kind: 'array', item }`,
 * `{ kind: 'tuple', items }`, `{ kind: 'record', value }`,
 * `{ kind: 'object', fields: [{ name, type, optional }] }`,
 * `{ kind: 'optional', inner }`, `{ kind: 'union', members }`,
 * `{ kind: 'literal', value }`, `{ kind: 'unresolved', typeText, reason }`.
 */
import { parsePyType } from './types-py.mjs';
import { parseTsType } from './types-ts.mjs';

const PARSERS = {
  typescript: parseTsType,
  javascript: parseTsType,
  python: parsePyType,
};

/**
 * @param {string} text a type expression, or '' when there is no annotation
 * @param {'typescript' | 'javascript' | 'python'} lang
 * @returns {object} a type node
 */
export function parseType(text, lang) {
  return PARSERS[lang](text);
}

const fieldKey = (field) =>
  `${field.name}${field.optional ? '?' : ''}:${typeKey(field.type)}`;

const KEYS = {
  array: (node) => `array<${typeKey(node.item)}>`,
  tuple: (node) => `tuple<${node.items.map(typeKey).join(',')}>`,
  record: (node) => `record<${typeKey(node.value)}>`,
  object: (node) => `object{${node.fields.map(fieldKey).join(',')}}`,
  optional: (node) => `optional<${typeKey(node.inner)}>`,
  // Sorted, so `string | number` and `number | string` share a key.
  union: (node) => `union<${node.members.map(typeKey).sort().join('|')}>`,
  literal: (node) => `literal<${JSON.stringify(node.value)}>`,
  unresolved: (node) => `unresolved<${node.typeText}>`,
};

/**
 * @param {object} node a type node
 * @returns {string} canonical text for the node
 */
export function typeKey(node) {
  const format = KEYS[node.kind];
  return format ? format(node) : node.kind;
}

const CHILDREN = {
  array: (node) => [node.item],
  tuple: (node) => node.items,
  record: (node) => [node.value],
  object: (node) => node.fields.map((field) => field.type),
  optional: (node) => [node.inner],
  union: (node) => node.members,
};

/**
 * @param {object} node a type node
 * @returns {object[]} every `unresolved` node inside it, in reading order
 */
export function collectUnresolved(node) {
  if (node.kind === 'unresolved') return [node];
  const children = CHILDREN[node.kind];
  return children ? children(node).flatMap(collectUnresolved) : [];
}
