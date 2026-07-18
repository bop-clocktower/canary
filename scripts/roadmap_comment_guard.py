#!/usr/bin/env python3
"""Restore docs/roadmap.md's markdownlint-disable comment block if missing.

harness roadmap tooling's `promote` action regenerates docs/roadmap.md and
silently drops the hand-placed comment block right after the `# Roadmap`
heading (upstream harness-engineering bug, tracked at
bop-clocktower/canary#273 — the serializer doesn't round-trip leading HTML
comments the way it does YAML frontmatter). Without the disable comment,
markdownlint's MD013 line-length rule fails on the long single-line-per-field
feature summaries the roadmap schema requires.

Run with no arguments; the pre-commit hook invokes this before the
markdownlint step so a dropped comment never surfaces as a confusing lint
failure. Idempotent — a no-op if the comment is already present.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
ROADMAP = REPO_ROOT / "docs" / "roadmap.md"

DISABLE_COMMENT = "<!-- markdownlint-disable-file MD013 -->"
COMMENT_BLOCK = (
    f"{DISABLE_COMMENT}\n"
    "<!-- Machine-managed by harness roadmap tooling: each feature field is a single\n"
    "     line by schema contract, so the 80-column line-length rule does not apply.\n"
    "     Completed work lives in docs/roadmap-archive.md (run: harness roadmap groom). -->\n"
)

HEADING_PATTERN = re.compile(r"^# Roadmap\n\n", re.MULTILINE)


def main() -> int:
    if not ROADMAP.exists():
        return 0

    text = ROADMAP.read_text()
    if DISABLE_COMMENT in text:
        return 0

    match = HEADING_PATTERN.search(text)
    if not match:
        return 0

    insert_at = match.end()
    new_text = text[:insert_at] + COMMENT_BLOCK + "\n" + text[insert_at:]
    ROADMAP.write_text(new_text)
    print("[roadmap-comment-guard] restored markdownlint-disable comment block (canary#273)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
