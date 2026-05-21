"""Idempotent .env reader / merger / writer.

Tester-focused onboarding writes API keys to .env without ever overwriting
an existing value. The format is intentionally minimal: KEY=VALUE per line,
`#` comments and blank lines ignored.

Quoted and multiline values are NOT supported (see #34). Rather than risk
mangling a user's pre-existing quoted/multiline entries, ``merge_env``
detects them and refuses to modify the file — the user is told to add the
key by hand.
"""

import re
from pathlib import Path
from typing import Dict, List, Optional, Union


# Matches a `KEY=` line where the value side starts with a single or double
# quote that is not closed on the same line — a multiline quoted value.
_UNCLOSED_QUOTE_RE = re.compile(r"""^\s*[A-Za-z_][\w]*\s*=\s*(['"])(?:(?!\1).)*$""")

# Matches a `KEY=` line whose value is wrapped in matching quotes.
_QUOTED_VALUE_RE = re.compile(r"""^\s*[A-Za-z_][\w]*\s*=\s*(['"]).*\1\s*(?:#.*)?$""")


def read_env(path: Path) -> Dict[str, str]:
    """Return existing keys from a .env file. Missing file -> empty dict.

    Reads with ``utf-8-sig`` so a Notepad/Excel-saved BOM doesn't smuggle a
    duplicate first key past the merger.
    """
    if not path.exists():
        return {}
    out: Dict[str, str] = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        out[key.strip()] = value.strip()
    return out


def detect_unsafe_patterns(path: Path) -> Optional[str]:
    """Return a human-readable reason if the .env file contains values we
    can't safely round-trip, else ``None``.

    Detects:
    - Quoted values (``KEY="value with spaces"``)
    - Multiline values (an unclosed quote that would continue on the next line)
    """
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8-sig")
    for i, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        if _UNCLOSED_QUOTE_RE.match(line):
            return f"multiline quoted value at line {i}"
        if _QUOTED_VALUE_RE.match(line):
            return f"quoted value at line {i}"
    return None


def merge_env(
    path: Path, additions: Dict[str, str]
) -> Dict[str, Union[List[str], str]]:
    """Append missing keys to .env. Never overwrite. Skip empty values.

    Returns a dict with:
    - ``added``: newly-written keys
    - ``preserved``: keys that already existed and were left untouched
    - ``skipped``: keys not written because the file contained patterns
      the minimal parser cannot safely round-trip
    - ``reason``: human-readable explanation when ``skipped`` is non-empty

    If the file contains quoted or multiline values, the file is left
    untouched and every non-empty addition is reported in ``skipped``.
    """
    unsafe_reason = detect_unsafe_patterns(path)
    if unsafe_reason is not None:
        return {
            "added": [],
            "preserved": [],
            "skipped": [k for k, v in additions.items() if v],
            "reason": (
                f"refusing to modify {path.name}: {unsafe_reason}. "
                f"Please add the missing keys by hand."
            ),
        }

    existing = read_env(path)
    added: List[str] = []
    preserved: List[str] = []
    to_append: List[str] = []
    for key, value in additions.items():
        if not value:
            continue
        if key in existing:
            preserved.append(key)
            continue
        added.append(key)
        to_append.append(f"{key}={value}")
    if to_append:
        prefix = (
            ""
            if not path.exists()
            or path.read_text(encoding="utf-8-sig").endswith("\n")
            else "\n"
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(prefix + "\n".join(to_append) + "\n")
    return {"added": added, "preserved": preserved, "skipped": [], "reason": ""}
