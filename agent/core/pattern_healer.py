"""Pattern-based test healer.

Applies regex-safe, deterministic fixes to test files without an LLM.
Powers `canary heal-test --pattern`.

Only fixes that are unambiguously correct are applied automatically:
- Hardcoded sleeps → replaced with a TODO comment pointing at event-based waits.
- Missing `await` before Playwright action calls.

Selector fixes are NOT auto-applied — swapping a selector without the
actual DOM snapshot produces wrong fixes. Selector issues are flagged
but left for the developer (or the /canary-heal-test slash command) to fix.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Tuple


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass
class HealChange:
    line: int
    rule: str
    before: str
    after: str
    description: str


@dataclass
class HealResult:
    file: str
    changes: List[HealChange] = field(default_factory=list)
    skipped: List[str] = field(default_factory=list)
    patched_content: str = ""

    @property
    def changed(self) -> bool:
        return bool(self.changes)


# ---------------------------------------------------------------------------
# Fix rules
# ---------------------------------------------------------------------------

# time.sleep(N) → # TODO: replace with event-based wait
_PY_SLEEP = re.compile(r"^(\s*)time\.sleep\s*\([^)]*\)\s*$", re.MULTILINE)

# page.waitForTimeout(N) → # TODO: replace with event-based wait
_PW_WAIT_TIMEOUT = re.compile(r"^(\s*)(await\s+)?page\.waitForTimeout\s*\([^)]*\)\s*;?\s*$", re.MULTILINE)

# Missing await before Playwright action — line starts with indentation then
# page/frame/locator.<action>( without a leading await
_BARE_PW_ACTION = re.compile(
    r"^(\s*)((?:page|frame|locator)\."
    r"(?:click|fill|type|check|uncheck|selectOption|hover|focus|press|tap|dblclick)\s*\([^)]*\))",
    re.MULTILINE,
)


def _fix_py_sleep(code: str, changes: List[HealChange]) -> str:
    def replacer(m: re.Match) -> str:
        indent = m.group(1)
        before = m.group(0).rstrip("\n")
        after = f"{indent}# TODO(canary): replace with an event-based wait (e.g. waitFor, wait_for_selector)"
        changes.append(HealChange(
            line=code[: m.start()].count("\n") + 1,
            rule="HEAL-001",
            before=before,
            after=after,
            description="Replaced time.sleep() with a TODO comment.",
        ))
        return after + "\n"
    return _PY_SLEEP.sub(replacer, code)


def _fix_pw_wait_timeout(code: str, changes: List[HealChange]) -> str:
    def replacer(m: re.Match) -> str:
        indent = m.group(1)
        before = m.group(0).rstrip("\n")
        after = f"{indent}// TODO(canary): replace with an event-based wait (e.g. await expect(locator).toBeVisible())"
        changes.append(HealChange(
            line=code[: m.start()].count("\n") + 1,
            rule="HEAL-002",
            before=before,
            after=after,
            description="Replaced page.waitForTimeout() with a TODO comment.",
        ))
        return after + "\n"
    return _PW_WAIT_TIMEOUT.sub(replacer, code)


def _fix_missing_await(code: str, changes: List[HealChange]) -> str:
    def replacer(m: re.Match) -> str:
        indent = m.group(1)
        call = m.group(2)
        before = m.group(0).rstrip("\n")
        after = f"{indent}await {call}"
        changes.append(HealChange(
            line=code[: m.start()].count("\n") + 1,
            rule="HEAL-003",
            before=before,
            after=after,
            description=f"Added missing `await` before `{call[:40]}`.",
        ))
        return after
    return _BARE_PW_ACTION.sub(replacer, code)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

class PatternHealer:
    """Applies deterministic, regex-safe fixes to test files."""

    def heal(self, path: Path) -> HealResult:
        original = path.read_text(encoding="utf-8")
        result = HealResult(file=str(path))
        code = original

        code = _fix_py_sleep(code, result.changes)
        code = _fix_pw_wait_timeout(code, result.changes)
        code = _fix_missing_await(code, result.changes)

        result.patched_content = code

        # Note what we deliberately skip
        if re.search(r"""['"]\.[a-zA-Z][\w\-]*['"]|['"]#[a-zA-Z][\w\-]*['"]|['"]/+[a-zA-Z\[\]/@*]""", original):
            result.skipped.append(
                "Brittle selectors detected but not auto-fixed — selector swaps require DOM context. "
                "Use /canary-heal-test in Claude Code for selector repair."
            )

        return result

    def apply(self, path: Path) -> HealResult:
        """Heal and write the result back to disk."""
        result = self.heal(path)
        if result.changed:
            path.write_text(result.patched_content, encoding="utf-8")
        return result
