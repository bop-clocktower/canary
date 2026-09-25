// Static suspect-rule catalog for canary-savant Tier-1 (pure data).
//
// Tier-1 flags the shared-state smells that *predict* order-dependent tests
// without executing anything: a module-level mutable that a test writes to, a
// setup with no matching teardown, a mutated process singleton, an
// order-coupled name. It is advisory: a smell is a suspect, not a proven leak.
// The dynamic confirmer (Tier-2, opt-in) is what turns a suspect into a named
// polluter.
//
// The detection logic lives in scanner.mjs; this module holds the metadata
// (id, severity, one-line rationale) each finding carries and the regexes the
// scanner tests against. JS has no verbose-regex flag, so patterns are compact
// literals documented by the comment above them.

export const SEVERITIES = ['high', 'medium', 'low'];

/** @typedef {{ruleId: string, severity: string, why: string}} Rule */

/** @type {Rule[]} */
export const RULES = [
  {
    ruleId: 'SV001-module-mutable-global',
    severity: 'medium',
    why:
      'a module-level mutable is written by a test, so state leaks into ' +
      'whatever test runs next',
  },
  {
    ruleId: 'SV002-missing-teardown',
    severity: 'medium',
    why:
      'setup acquires state with no matching teardown, so the state outlives ' +
      'the test that created it',
  },
  {
    ruleId: 'SV003-shared-singleton-mutation',
    severity: 'low',
    why:
      'a process-global singleton is mutated without restore, so the change ' +
      'persists across tests',
  },
  {
    ruleId: 'SV004-order-coupled-name',
    severity: 'low',
    why:
      'the name or comment encodes an execution order, a self-reported ' +
      'dependence on another test running first',
  },
];

export const WHY = Object.fromEntries(RULES.map((r) => [r.ruleId, r.why]));
export const SEVERITY = Object.fromEntries(
  RULES.map((r) => [r.ruleId, r.severity]),
);

// PHP families (#1106) carry `php: true` and apply to .php files only (a JS
// `define(` is AMD, not a constant). Optional fields: `keyOf(match)` when the
// key is not group 1; `unrestorable` (no restore launders it); `pairAnywhere`
// (a delete ANYWHERE in the file restores: WP's inline add_filter ...
// remove_filter); `wpAutoRestored` (a WP_UnitTestCase base restores it).
// PHP_ASSIGN is plain or compound (.= += ??= ...), never `==`/`===`/`=>`.
const PHP_OP = String.raw`(?:\.|\?\?|\*\*|<<|>>|[-+*/%&|^])`;
const PHP_ASSIGN = String.raw`\s*${PHP_OP}?=(?![=>])`;
// $_GET['k'] = | $_GET['k']['n'] .= | $_GET[] = | $_GET = ... (group 1: key)
const superglobal = (name) => ({
  id: `$${name}`,
  token: String.raw`\$${name}`,
  php: true,
  assign: new RegExp(
    String.raw`(?<![\w$])\$${name}\b\s*(?:\[([^\]]*)\](?:\s*\[[^\]]*\])*)?` +
      PHP_ASSIGN,
  ),
  deletes: [new RegExp(String.raw`\bunset\s*\(\s*\$${name}\b\s*\[([^\]]*)\]`)],
  restoreAll: [],
});
const phpCall = (id, assign, deletes, extra = {}) => ({
  id,
  token: id,
  php: true,
  assign,
  deletes,
  restoreAll: [],
  ...extra,
});
const PHP_FAMILIES = [
  ...[
    '_GET',
    '_POST',
    '_COOKIE',
    '_SERVER',
    '_ENV',
    '_SESSION',
    '_REQUEST',
    '_FILES',
    'GLOBALS',
  ].map(superglobal),
  // putenv('NAME=v') sets; putenv('NAME') (no `=`) unsets, i.e. restores.
  phpCall(
    'putenv',
    /\bputenv\s*\(\s*(['"])([^'"=]+)=/,
    [/\bputenv\s*\(\s*(['"])([^'"=]+)\1\s*\)/],
    { keyOf: (m) => m[2] },
  ),
  phpCall('ini_set', /\bini_set\s*\(\s*([^,)]+)/, [
    /\bini_restore\s*\(\s*([^,)]+)/,
  ]),
  phpCall('date_default_timezone_set', /\bdate_default_timezone_set\s*\(/, []),
  // A PHP constant can never be undefined. `defined(` does not match.
  phpCall('define', /(?<![\w$>:])define\s*\(\s*([^,)]+)/, [], {
    unrestorable: true,
  }),
  phpCall(
    'wp.hooks',
    /\badd_(?:filter|action)\s*\(\s*([^,)]+)/,
    [/\bremove_(?:filter|action|all_filters|all_actions)\s*\(\s*([^,)]+)/],
    { pairAnywhere: true, wpAutoRestored: true },
  ),
  phpCall(
    'wp.options',
    /\b(?:update|add)_option\s*\(\s*([^,)]+)/,
    [/\bdelete_option\s*\(\s*([^,)]+)/],
    { wpAutoRestored: true },
  ),
];

// SV003: singleton / env mutation (assignment, never a read or comparison).
// A trailing negative lookahead on `=` keeps `==` comparisons out. One entry
// per process-global family (#493): `assign` detects the mutation (and, in a
// teardown region, the restore); `deletes` and `restoreAll` are restore-only
// idioms. Group 1/2 of `assign` and `deletes` capture the key (dot-property
// or bracket expression) so restoration.mjs can match restores per key.
//   os.environ['X'] = ... | sys.modules['m'] = ... | process.env.X = ...
//   | process.env['X'] = ...
export const SINGLETON_FAMILIES = [
  {
    id: 'process.env',
    token: 'process\\.env',
    assign: /\bprocess\.env\s*(?:\.(\w+)|\[([^\]]+)\])\s*=(?!=)/,
    deletes: [/\bdelete\s+process\.env\s*(?:\.(\w+)|\[([^\]]+)\])/],
    restoreAll: [/\bObject\.assign\s*\(\s*process\.env\s*,/],
  },
  {
    id: 'os.environ',
    token: 'os\\.environ',
    assign: /\bos\.environ\s*\[([^\]]+)\]\s*=(?!=)/,
    deletes: [
      /\bdel\s+os\.environ\s*\[([^\]]+)\]/,
      /\bos\.environ\.pop\s*\(\s*([^,)]+)/,
    ],
    restoreAll: [/\bos\.environ\.(?:update|clear)\s*\(/],
  },
  {
    id: 'sys.modules',
    token: 'sys\\.modules',
    assign: /\bsys\.modules\s*\[([^\]]+)\]\s*=(?!=)/,
    deletes: [
      /\bdel\s+sys\.modules\s*\[([^\]]+)\]/,
      /\bsys\.modules\.pop\s*\(\s*([^,)]+)/,
    ],
    restoreAll: [/\bsys\.modules\.update\s*\(/],
  },
  ...PHP_FAMILIES,
];
// SV003 restore context for PHP (#1106), read by restoration.mjs.
export const familiesFor = (isPhp) =>
  SINGLETON_FAMILIES.filter((family) => isPhp || !family.php);
// A teardown method; the lookahead skips a bodiless `...(): void;` declaration.
export const PHP_TEARDOWN_FN =
  /\bfunction\s+(?:tear_?down\w*|wpTearDown\w*)\s*\((?![^{]*;\s*$)/i;
// A whole-line comment: a remove_filter() there is prose, not a pairing.
export const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*)/;
// A class extending a WP_*UnitTestCase* base (D9): the framework restores
// hooks and rolls the DB back per test. Class-anchored, so a comment can't.
export const WP_TESTCASE_BASE =
  /^\s*(?:(?:abstract|final|readonly)\s+)*class\s+\w+\s+extends\s+\\?WP_\w*UnitTestCase\w*\b/;

// SV004: order-coupled name or comment (fires on code and comment lines).
// Split in two (#493) because the alternatives anchor differently:
//
// CODE-anchored: the token is source code in real usage, so a match starting
// inside a string literal is fixture data and is rejected.
//   def test_1_...            -> ordinal-indexed test
//   def test_first / test_last(_more)  -> ordinal test name (not test_firstname)
//   it('... run first')       -> ordering inside an it() title (anchor: `it(`)
export const SV004_CODE_PATTERN =
  /\bdef\s+test_\d+_|\bdef\s+test_(?:first|second|third|fourth|fifth|sixth|seventh|last|initial|final)\s*[(:]|\bit\s*\(\s*['"][^'"]*\b(?:run|runs|running)\s+(?:first|last|before|after)\b/i;
//
// TEXT-anchored: the directive legitimately lives inside strings (test
// titles, docstrings) and comments, so it is NOT string-literal filtered.
//   "must run before ..."     -> self-reported ordering note
//   "runs before ..."
export const SV004_TEXT_PATTERN =
  /\bmust\s+run\s+(?:before|after|first|last)\b|\bruns?\s+(?:before|after)\b/i;

// SV002: framework-conditioned setup/teardown pairs. Only CLASS/ALL-scoped
// setup is included: it manages state shared across a class's tests, so a
// missing teardown genuinely leaks. Per-test setup (setUp / setup_method /
// beforeEach) rebuilds state for each test, so a missing teardown there is not a
// leak - and firing on it was the dominant false positive when dogfooding on
// canary's own suite (Phase 5). A setup present without its teardown fires.
export const PYTHON_SETUP_TEARDOWN = [
  ['setup_class', 'teardown_class'],
  ['setUpClass', 'tearDownClass'],
];
export const JS_SETUP_TEARDOWN = [['beforeAll', 'afterAll']];
// PHPUnit, then WP_UnitTestCase's snake_case spelling (#1106 D6).
// wpSetUpBeforeClass is deliberately absent: WP's base class deletes the
// factory data it builds, so it never needs its own teardown.
export const PHP_SETUP_TEARDOWN = [
  ['setUpBeforeClass', 'tearDownAfterClass'],
  ['set_up_before_class', 'tear_down_after_class'],
];

// SV001: mutable-literal declarations and the mutations that indict them.
//   Python:  NAME = {} | [] | set() | dict() | list()   (optional trailing #comment)
export const PY_MODULE_MUTABLE =
  /^(\w+)\s*=\s*(?:\{[^}]*\}|\[[^\]]*\]|set\(\)|dict\(\)|list\(\))\s*(?:#.*)?$/;
//   JS: (let|var|const) NAME = {} | []
export const JS_MODULE_MUTABLE =
  /^(?:let|var|const)\s+(\w+)\s*=\s*(?:\{[^}]*\}|\[[^\]]*\])/;
// PHP (#1106), NAME captured without `$`; superglobals are SV003's (D5).
//   column-0  $x = [ ...  |  $x = array( ...
export const PHP_MODULE_MUTABLE =
  /^\$(?!_[A-Z]|GLOBALS\b)(\w+)\s*=\s*(?:\[|array\s*\()/;
//   static $x  |  public static ?array $x   (local or class property)
export const PHP_STATIC_DECL =
  /^\s*(?:(?:public|protected|private|final|readonly)\s+)*static\s+(?:\??[\w\\|]+\s+)?\$(\w+)/;
//   global $a, $b;
export const PHP_GLOBAL_DECL = /^\s*global\s+(\$\w+(?:\s*,\s*\$\w+)*)\s*;/;

// Method calls that mutate a container in place (Python + JS array/object).
const MUTATING_METHODS = [
  'append',
  'add',
  'update',
  'extend',
  'insert',
  'pop',
  'clear',
  'setdefault',
  'remove',
  'discard',
  'push',
  'unshift',
  'splice',
];

const RE_META = /[.*+?^${}()|[\]\\]/g;
const escapeRe = (s) => s.replace(RE_META, '\\$&');

/**
 * A pattern matching an in-place mutation of `name`
 * (index assign, mutating method, +=, or attribute/property set).
 * @param {string} name
 * @returns {RegExp}
 */
export function mutationPattern(name) {
  const n = escapeRe(name);
  const methods = MUTATING_METHODS.join('|');
  // \bNAME[...] = ... | \bNAME.method( | \bNAME += | \bNAME.attr = ...
  return new RegExp(
    `\\b${n}\\s*\\[[^\\]]*\\]\\s*=(?!=)` +
      `|\\b${n}\\s*\\.\\s*(?:${methods})\\s*\\(` +
      `|\\b${n}\\s*\\+=` +
      `|\\b${n}\\s*\\.\\w+\\s*=(?!=)`,
  );
}

/**
 * PHP (#1106): an in-place mutation of `$name` - `$x[..] =`, `$x[] =`,
 * compound assignment, `++`/`--`, array_push/unshift/splice/pop/shift, or
 * `$x->prop =`. A plain `$x = ...` is not one: it is also how a restore is
 * written. `(?<![\w$])` and `\b` keep `$x` from matching `$xy`.
 * @param {string} name the variable, without `$`
 * @returns {RegExp}
 */
export function phpMutationPattern(name) {
  const v = String.raw`(?<![\w$])\$${escapeRe(name)}\b`;
  const index = String.raw`\s*\[[^\]]*\]`;
  return new RegExp(
    `${v}(?:${index})+${PHP_ASSIGN}` +
      `|${v}\\s*${PHP_OP}=(?![=>])` +
      `|${v}\\s*(?:\\+\\+|--)|(?:\\+\\+|--)\\s*${v}` +
      `|\\barray_(?:push|unshift|splice|pop|shift)\\s*\\(\\s*${v}` +
      `|${v}\\s*->\\s*\\w+(?:${index})*${PHP_ASSIGN}`,
  );
}
