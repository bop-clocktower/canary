"""Static suspect-rule catalog for canary-savant Tier-1 (pure data).

Tier-1 flags the shared-state smells that *predict* order-dependent tests
without executing anything: a module-level mutable that a test writes to, a
setup with no matching teardown, a mutated process singleton, an order-coupled
name. It is advisory: a smell is a suspect, not a proven leak. The dynamic
confirmer (Tier-2, opt-in) is what turns a suspect into a named polluter.

The detection logic lives in `scanner`; this module holds the metadata (id,
severity, one-line rationale) each finding carries and the regex fragments the
scanner compiles against.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

SEVERITIES = ("high", "medium", "low")


@dataclass(frozen=True)
class Rule:
    """One static suspect check: identity plus the reason it matters."""

    rule_id: str
    severity: str
    why: str


RULES = (
    Rule(
        "SV001-module-mutable-global",
        "medium",
        "a module-level mutable is written by a test, so state leaks into "
        "whatever test runs next",
    ),
    Rule(
        "SV002-missing-teardown",
        "medium",
        "setup acquires state with no matching teardown, so the state outlives "
        "the test that created it",
    ),
    Rule(
        "SV003-shared-singleton-mutation",
        "low",
        "a process-global singleton is mutated without restore, so the change "
        "persists across tests",
    ),
    Rule(
        "SV004-order-coupled-name",
        "low",
        "the name or comment encodes an execution order, a self-reported "
        "dependence on another test running first",
    ),
)

WHY = {rule.rule_id: rule.why for rule in RULES}
SEVERITY = {rule.rule_id: rule.severity for rule in RULES}

# --- SV003: singleton / env mutation (assignment, never a read or comparison) -
# A trailing negative lookahead on `=` keeps `==` comparisons out.
SV003_PATTERN = re.compile(
    r"""(?x)
    \bos\.environ\s*\[[^\]]+\]\s*=(?!=)      # os.environ['X'] = ...
  | \bsys\.modules\s*\[[^\]]+\]\s*=(?!=)     # sys.modules['m'] = ...
  | \bprocess\.env\.\w+\s*=(?!=)             # process.env.X = ...
  | \bprocess\.env\s*\[[^\]]+\]\s*=(?!=)     # process.env['X'] = ...
    """
)

# --- SV004: order-coupled name or comment (fires on code and comment lines) ---
SV004_PATTERN = re.compile(
    r"""(?ix)
    \bdef\s+test_\d+_                                   # test_1_..., test_2_...
  | \bdef\s+test_(?:first|second|third|fourth|fifth|
                   sixth|seventh|last|initial|final)
      (?![a-z0-9])                                      # ordinal test names
                                                        # (test_last, test_last_cleanup)
  | \bit\s*\(\s*['"][^'"]*\b
      (?:run|runs|running)\s+(?:first|last|before|after)\b   # it('... run first')
  | \bmust\s+run\s+(?:before|after|first|last)\b        # "must run before ..."
  | \bruns?\s+(?:before|after)\b                        # "runs before ..."
    """
)

# --- SV002: framework-conditioned setup/teardown pairs -----------------------
# Each pair: a setup marker that acquires state, and the teardown that would
# release it. A setup present without its teardown anywhere in the file fires.
PYTHON_SETUP_TEARDOWN = (
    ("setup_method", "teardown_method"),
    ("setup_class", "teardown_class"),
    ("setUp", "tearDown"),
    ("setUpClass", "tearDownClass"),
)
JS_SETUP_TEARDOWN = (
    ("beforeEach", "afterEach"),
    ("beforeAll", "afterAll"),
)

# --- SV001: mutable-literal declarations and the mutations that indict them ---
PY_MODULE_MUTABLE = re.compile(
    r"""^(\w+)\s*=\s*(?:\{[^}]*\}|\[[^\]]*\]|set\(\)|dict\(\)|list\(\))\s*(?:#.*)?$"""
)
JS_MODULE_MUTABLE = re.compile(
    r"""^(?:let|var|const)\s+(\w+)\s*=\s*(?:\{[^}]*\}|\[[^\]]*\])"""
)
# Method calls that mutate a container in place (Python + JS array/object).
_MUTATING_METHODS = (
    "append", "add", "update", "extend", "insert", "pop", "clear",
    "setdefault", "remove", "discard", "push", "unshift", "splice",
)


def mutation_pattern(name: str) -> re.Pattern:
    """A pattern matching an in-place mutation of `name` (index, method, +=, attr set)."""
    n = re.escape(name)
    methods = "|".join(_MUTATING_METHODS)
    return re.compile(
        rf"""(?x)
        \b{n}\s*\[[^\]]*\]\s*=(?!=)     # name[...] = ...
      | \b{n}\s*\.\s*(?:{methods})\s*\(  # name.append(...) etc.
      | \b{n}\s*\+=                      # name += ...
      | \b{n}\s*\.\w+\s*=(?!=)           # name.attr = ...  (object/property set)
        """
    )
