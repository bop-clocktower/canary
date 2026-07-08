"""Fail-fast config audit for a Playwright config (pure, read-only).

Scans a `playwright.config.*` for the fail-fast knobs a suite should set so a
broken CI run aborts early instead of burning the whole matrix. Never edits the
config — it recommends, and `CANONICAL` is the block to paste in.
"""

from __future__ import annotations

CANONICAL = """\
export default defineConfig({
  // Fail fast in CI: abort once enough has clearly broken, never on local runs.
  forbidOnly: !!process.env.CI,             // a stray test.only fails the build
  maxFailures: process.env.CI ? 10 : 0,     // stop the run after 10 failures in CI
  retries: process.env.CI ? 2 : 0,          // absorb flakes in CI; surface them locally
  // ...your existing config
});
"""

# knob name -> why it matters
KNOBS = {
    "forbidOnly": "a stray `test.only` silently skips the rest of the suite",
    "maxFailures": "a broken run keeps burning the matrix instead of aborting early",
    "retries": "flakes either fail the build or hide locally without a CI retry policy",
}


def check_config(text: str) -> list[str]:
    """Return one recommendation per fail-fast knob missing from the config text.

    Empty list means all knobs are present. Substring scan — good enough to flag
    absence; it does not validate the knob's value.
    """
    return [
        f"Add `{knob}` — without it, {why}."
        for knob, why in KNOBS.items()
        if knob not in text
    ]
