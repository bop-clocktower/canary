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

// SV003: singleton / env mutation (assignment, never a read or comparison).
// A trailing negative lookahead on `=` keeps `==` comparisons out.
//   os.environ['X'] = ... | sys.modules['m'] = ... | process.env.X = ...
//   | process.env['X'] = ...
export const SV003_PATTERN =
  /\bos\.environ\s*\[[^\]]+\]\s*=(?!=)|\bsys\.modules\s*\[[^\]]+\]\s*=(?!=)|\bprocess\.env\.\w+\s*=(?!=)|\bprocess\.env\s*\[[^\]]+\]\s*=(?!=)/;

// SV004: order-coupled name or comment (fires on code and comment lines).
//   def test_1_...            -> ordinal-indexed test
//   def test_first / test_last(_more)  -> ordinal test name (not test_firstname)
//   it('... run first')       -> ordering inside an it() title
//   "must run before ..."     -> self-reported ordering note
//   "runs before ..."
export const SV004_PATTERN =
  /\bdef\s+test_\d+_|\bdef\s+test_(?:first|second|third|fourth|fifth|sixth|seventh|last|initial|final)(?![a-z0-9])|\bit\s*\(\s*['"][^'"]*\b(?:run|runs|running)\s+(?:first|last|before|after)\b|\bmust\s+run\s+(?:before|after|first|last)\b|\bruns?\s+(?:before|after)\b/i;

// SV002: framework-conditioned setup/teardown pairs. A setup present without
// its teardown anywhere in the file fires.
export const PYTHON_SETUP_TEARDOWN = [
  ['setup_method', 'teardown_method'],
  ['setup_class', 'teardown_class'],
  ['setUp', 'tearDown'],
  ['setUpClass', 'tearDownClass'],
];
export const JS_SETUP_TEARDOWN = [
  ['beforeEach', 'afterEach'],
  ['beforeAll', 'afterAll'],
];

// SV001: mutable-literal declarations and the mutations that indict them.
//   Python:  NAME = {} | [] | set() | dict() | list()   (optional trailing #comment)
export const PY_MODULE_MUTABLE =
  /^(\w+)\s*=\s*(?:\{[^}]*\}|\[[^\]]*\]|set\(\)|dict\(\)|list\(\))\s*(?:#.*)?$/;
//   JS: (let|var|const) NAME = {} | []
export const JS_MODULE_MUTABLE =
  /^(?:let|var|const)\s+(\w+)\s*=\s*(?:\{[^}]*\}|\[[^\]]*\])/;

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
