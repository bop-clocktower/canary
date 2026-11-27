/**
 * canary-harley -- type nodes to generator expressions: fast-check for
 * TypeScript, Hypothesis for Python.
 *
 * A node that holds an `unresolved` type anywhere gives `null`. A generator
 * is never guessed: it would test inputs the function does not accept.
 *
 * Floats exclude NaN. `nan != nan` would fail every equality property for a
 * reason that has nothing to do with the invariant.
 */

const hex = (code, width) => code.toString(16).padStart(width, '0');

/**
 * A double-quoted string literal that is valid in JavaScript and, with
 * `wide`, in Python. Everything outside printable ASCII is written as an
 * escape, so text read from a source file cannot close the literal or start
 * a new line of code.
 *
 * @param {string} text
 * @param {boolean} [wide] write astral characters as Python's `\UXXXXXXXX`
 * @returns {string}
 */
export function quote(text, wide = false) {
  // JSON.stringify escapes quotes, backslashes, control characters and lone
  // surrogates; a well-formed pair is left raw and is rewritten here.
  const json = JSON.stringify(text);
  const astral = wide
    ? json.replace(/[\ud800-\udbff][\udc00-\udfff]/g, (pair) => {
        return `\\U${hex(pair.codePointAt(0), 8)}`;
      })
    : json;
  return astral.replace(/[\u007f-\uffff]/g, (char) => {
    return `\\u${hex(char.charCodeAt(0), 4)}`;
  });
}

/**
 * The same literal in single quotes, the form the house style writes.
 *
 * @param {string} text
 * @returns {string}
 */
export function singleQuote(text) {
  // One token at a time, so an escaped backslash is never read as the start
  // of the escape that follows it.
  const body = quote(text)
    .slice(1, -1)
    .replace(/\\.|'/g, (token) => SINGLE.get(token) ?? token);
  return `'${body}'`;
}

const SINGLE = new Map([
  ['\\"', '"'],
  ["'", "\\'"],
]);

/**
 * Text for one comment line: anything outside printable ASCII becomes a
 * space, and a block-comment closer is broken up.
 *
 * @param {string} text
 * @returns {string}
 */
export function oneLine(text) {
  return String(text)
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\*\//g, '* /');
}

const PY_WORDS = new Map([
  [true, 'True'],
  [false, 'False'],
  [null, 'None'],
]);

const fcLiteral = (value) =>
  typeof value === 'string' ? quote(value) : JSON.stringify(value);

const pyLiteral = (value) =>
  typeof value === 'string'
    ? quote(value, true)
    : (PY_WORDS.get(value) ?? JSON.stringify(value));

function fcObject(node, types) {
  const pairs = node.fields.map(
    (field, index) => `${quote(field.name)}: ${types[index]}`,
  );
  const required = node.fields
    .filter((field) => !field.optional)
    .map((field) => quote(field.name));
  const record = `{ ${pairs.join(', ')} }`;
  if (required.length === node.fields.length) return `fc.record(${record})`;
  return `fc.record(${record}, { requiredKeys: [${required.join(', ')}] })`;
}

function pyObject(node, types) {
  const pairs = node.fields.map((field, index) => ({
    optional: field.optional,
    text: `${quote(field.name, true)}: ${types[index]}`,
  }));
  const pick = (optional) =>
    pairs
      .filter((pair) => pair.optional === optional)
      .map((pair) => pair.text)
      .join(', ');
  const required = `{${pick(false)}}`;
  if (pairs.every((pair) => !pair.optional)) {
    return `st.fixed_dictionaries(${required})`;
  }
  return `st.fixed_dictionaries(${required}, optional={${pick(true)}})`;
}

// Per kind: (node, already-rendered children) => expression.
const FC = {
  string: () => 'fc.string()',
  number: () => 'fc.double({ noNaN: true })',
  integer: () => 'fc.integer()',
  boolean: () => 'fc.boolean()',
  bigint: () => 'fc.bigInt()',
  bytes: () => 'fc.uint8Array()',
  null: () => 'fc.constant(null)',
  array: (_node, [item]) => `fc.array(${item})`,
  tuple: (_node, items) => `fc.tuple(${items.join(', ')})`,
  record: (_node, [value]) => `fc.dictionary(fc.string(), ${value})`,
  object: fcObject,
  optional: (_node, [inner]) => `fc.option(${inner}, { nil: undefined })`,
  union: (_node, members) => `fc.oneof(${members.join(', ')})`,
  literal: (node) => `fc.constant(${fcLiteral(node.value)})`,
};

const HYP = {
  string: () => 'st.text()',
  number: () => 'st.floats(allow_nan=False)',
  integer: () => 'st.integers()',
  boolean: () => 'st.booleans()',
  bigint: () => 'st.integers()',
  bytes: () => 'st.binary()',
  null: () => 'st.none()',
  array: (_node, [item]) => `st.lists(${item})`,
  tuple: (_node, items) => `st.tuples(${items.join(', ')})`,
  record: (_node, [value]) => `st.dictionaries(st.text(), ${value})`,
  object: pyObject,
  optional: (_node, [inner]) => `st.one_of(st.none(), ${inner})`,
  union: (_node, members) => `st.one_of(${members.join(', ')})`,
  literal: (node) => `st.just(${pyLiteral(node.value)})`,
};

const CHILDREN = {
  array: (node) => [node.item],
  tuple: (node) => node.items,
  record: (node) => [node.value],
  object: (node) => node.fields.map((field) => field.type),
  optional: (node) => [node.inner],
  union: (node) => node.members,
};

/** The expression for `node`, or null when it or a child has no mapping. */
function render(node, table) {
  const format = table[node.kind];
  if (!Object.hasOwn(table, node.kind)) return null;
  const children = (CHILDREN[node.kind]?.(node) ?? []).map((child) =>
    render(child, table),
  );
  return children.includes(null) ? null : format(node, children);
}

/**
 * @param {object} node a type node
 * @returns {string | null} a fast-check arbitrary, or null when unresolved
 */
export function toFastCheck(node) {
  return render(node, FC);
}

/**
 * @param {object} node a type node
 * @returns {string | null} a Hypothesis strategy, or null when unresolved
 */
export function toHypothesis(node) {
  return render(node, HYP);
}
