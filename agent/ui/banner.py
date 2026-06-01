"""
canary/ui/banner.py

CLI startup banner for the Canary test automation agent.
Uses ANSI escape codes — works in any modern terminal.
Import and call `print_banner()` from your CLI entrypoint.
"""

RESET   = "\033[0m"
BOLD    = "\033[1m"
DIM     = "\033[2m"

# Canary gold  (#F0C040 → closest 256-color: 220, true-color below)
GOLD    = "\033[38;2;240;192;64m"
AMBER   = "\033[38;2;192;144;24m"
WHITE   = "\033[38;2;245;245;245m"
MUTED   = "\033[38;2;85;85;85m"
DARK    = "\033[38;2;46;46;46m"

# ── Bird mark (3-line ASCII, expands to ~6 chars wide) ────────────────────────
_BIRD = [
    f"{GOLD}  ▲{RESET}",
    f"{GOLD} ▲█▲{RESET}",
    f"{AMBER}  ▀{RESET}",
]

_VERSION = "1.0.0"
_TAGLINE = "test automation agent"
_NETWORK = "birds of prey network · clocktower voice system"
_RULE    = "─" * 44


def print_banner(version: str = _VERSION) -> None:
    """Print the Canary startup banner to stdout."""

    divider = f"{DARK}{_RULE}{RESET}"

    lines = [
        "",
        f"  {_BIRD[0]}   {BOLD}{WHITE}canary{RESET}  {GOLD}v{version}{RESET}",
        f"  {_BIRD[1]}   {MUTED}{_TAGLINE}{RESET}",
        f"  {_BIRD[2]}   {DARK}{_NETWORK}{RESET}",
        f"       {divider}",
        "",
    ]

    print("\n".join(lines))


def print_result_line(
    status: str,          # "ok" | "fail" | "skip" | "info"
    message: str,
    detail: str = "",
) -> None:
    """
    Print a single result line in Canary style.

    Examples
    --------
    print_result_line("ok",   "login.spec.ts", "23ms")
    print_result_line("fail", "checkout.spec.ts", "assertion error")
    print_result_line("info", "canary__generate_test", "playwright")
    """
    _icons = {
        "ok":   (f"\033[38;2;40;200;64m", "✓"),
        "fail": (f"\033[38;2;226;75;74m",  "✗"),
        "skip": (f"\033[38;2;85;85;85m",   "○"),
        "info": (GOLD,                      "◆"),
    }
    color, icon = _icons.get(status, _icons["info"])
    detail_str  = f"  {MUTED}{detail}{RESET}" if detail else ""
    print(f"  {color}{icon}{RESET}  {WHITE}{message}{RESET}{detail_str}")


def print_section(label: str) -> None:
    """Print a gold section header."""
    print(f"\n  {GOLD}{BOLD}{label.upper()}{RESET}")
    print(f"  {DARK}{'─' * len(label)}{RESET}")


# ── Demo (python -m canary.ui.banner) ─────────────────────────────────────────
if __name__ == "__main__":
    print_banner()
    print_section("generating tests")
    print_result_line("info", "canary__analyze_file", "login.spec.ts")
    print_result_line("info", "canary__generate_test", "playwright")
    print_result_line("ok",   "login.spec.ts generated", "847ms")
    print_result_line("ok",   "checkout.spec.ts generated", "1.2s")
    print_result_line("fail", "payment.spec.ts", "selector not found")
    print_result_line("skip", "admin.spec.ts", "no fixture")
    print()
