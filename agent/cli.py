# agent/cli.py

"""
Canary CLI - The primary user interface for AI-powered test automation.

This module provides the Typer-based command-line interface for generating,
running, and initializing test suites. It serves as the entry point for
the Canary agent.
"""

import json
import subprocess
import sys as _sys
from pathlib import Path
from typing import Optional
import typer
from rich import print

app = typer.Typer(no_args_is_help=True)


def _version_callback(value: bool) -> None:
    if value:
        from importlib.metadata import PackageNotFoundError, version as _pkg_version
        from agent.ui.banner import print_banner
        try:
            ver = _pkg_version("canary-test-ai")
        except PackageNotFoundError:
            ver = "unknown"
        print_banner(version=ver)
        raise typer.Exit()


@app.callback()
def _main(
    version: Optional[bool] = typer.Option(
        None, "--version", "-V",
        callback=_version_callback, is_eager=True,
        help="Show version and exit.",
    ),
) -> None:
    """Canary — AI-powered test automation agent."""


@app.command()
def recommend(
    prompt: str,
    output_json: bool = typer.Option(False, "--json", help="Output as JSON for tool integration."),
):
    """
    Classify a test prompt and recommend the best framework — no API key required.

    Runs Canary's classifier + recommender pipeline locally and returns the
    framework, file extension, and reasoning. Use /canary-pick-framework from
    the Claude Code plugin for an interactive version with company overlays.
    """
    from agent.core.classifier import TestClassifier, extract_framework_hint
    from agent.core.recommender import FrameworkRecommender

    classifier = TestClassifier()
    recommender = FrameworkRecommender()

    classification = classifier.classify(prompt)
    results = recommender.recommend(
        classification,
        framework_hint=extract_framework_hint(prompt),
    )
    result = results[0] if results else {
        "framework": None,
        "file_extension": "ts",
        "reason": ["No matching framework found"],
    }
    alternatives = [r["framework"] for r in results[1:]]

    if output_json:
        payload = {
            "status": "success",
            "test_type": classification.test_type,
            "framework": result["framework"],
            "file_extension": result["file_extension"],
            "reasoning": result["reason"],
            "alternatives": alternatives,
        }
        if result.get("warning"):
            payload["license"] = result.get("license")
            payload["warning"] = result["warning"]
        _sys.stdout.write(json.dumps(payload, indent=2) + "\n")
        return

    print("[bold green]✅ Canary Recommendation[/bold green]\n")
    print(f"[bold]Test Type:[/bold] {classification.test_type}")
    print(f"[bold]Framework:[/bold] {result['framework']}")
    print("\n[bold]Reasoning:[/bold]")
    for r in result["reason"]:
        print(f" - {r}")
    if result.get("warning"):
        print(f"\n[yellow]⚠ License: {result['warning']}[/yellow]")
    if alternatives:
        print(f"\n[bold]Alternatives:[/bold] {', '.join(alternatives)}")


@app.command()
def run(
    file_path: str,
    framework: str = typer.Argument(..., help="Framework to use (e.g., playwright, pytest)")
):
    """
    Execute a test file using Canary's integrated executor.

    Args:
        file_path: Path to the test file to execute.
        framework: The testing framework to use for execution.
    """
    from agent.core.executor import CanaryTestExecutor
    from pathlib import Path

    print(f"\n[bold cyan]🚀 Canary Executing {framework} Test...[/bold cyan]\n")

    executor = CanaryTestExecutor()
    exit_code, stdout, stderr = executor.execute(Path(file_path), framework)

    color = "green" if exit_code == 0 else "red"
    print(f"[{color}]Result: {'Success' if exit_code == 0 else 'Failure'} (Exit {exit_code})[/{color}]")

    if stderr:
        print(f"\n[red]Error:[/red]\n{stderr}")
    
    if stdout:
        print(f"\n[dim]Output:[/dim]\n{stdout}")


@app.command()
def init(
    framework: str = typer.Argument(..., help="Framework to scaffold (e.g., playwright, vitest, pytest, k6)")
):
    """
    Initialize a test suite with Gold Standard scaffolding and config.

    Args:
        framework: The framework to initialize (playwright, vitest, pytest, or k6).
    """
    from agent.core.scaffolder import Scaffolder
    
    print(f"\n[bold cyan]🛠 Canary Initializing {framework} Scaffold...[/bold cyan]\n")
    
    try:
        scaffolder = Scaffolder()
        result = scaffolder.scaffold(framework)
        
        print("[bold green]✅ Scaffolding Complete[/bold green]\n")
        
        if result["created_dirs"]:
            print("[bold]Directories Created:[/bold]")
            for d in result["created_dirs"]:
                print(f"  + {d}")
        
        if result["created_files"]:
            print("\n[bold]Files Created:[/bold]")
            for f in result["created_files"]:
                print(f"  + {f}")
        
        if result["skipped_files"]:
            print("\n[bold yellow]Files Skipped (Already Exist):[/bold yellow]")
            for f in result["skipped_files"]:
                print(f"  - {f}")
        
        # Next steps
        print("\n[bold cyan]⏭️ Next Steps:[/bold cyan]")
        if framework.lower() == "playwright":
            print("  1. Run: [bold green]npm install -D @playwright/test[/bold green]")
            print("  2. Run: [bold green]npx playwright install[/bold green]")
        elif framework.lower() == "vitest":
            print("  1. Run: [bold green]npm install -D vitest[/bold green]")
        elif framework.lower() == "pytest":
            print("  1. Run: [bold green]pip install pytest[/bold green]")
        elif framework.lower() == "k6":
            print("  1. Install k6: [bold green]https://k6.io/docs/getting-started/installation/[/bold green]")

    except ValueError as e:
        print(f"\n[bold red]❌ Error: {str(e)}[/bold red]")
        print("[yellow]Supported frameworks: playwright, vitest, pytest, k6[/yellow]")


def _resolve_migrate_overlay(from_overlay: Optional[str], overlay: Optional[str]):
    """Resolve the effective overlay clone path for `migrate`.

    Precedence: ``--from`` (tracked overlay name or path) → ``--overlay`` (a raw
    path, deprecated) → a single tracked overlay by default → none. When more
    than one overlay is tracked and no flag is given, this is an ambiguity error.
    Prints user-facing notices; raises ``typer.Exit(1)`` on an unresolvable
    ``--from`` or an ambiguous default. Returns a ``Path`` or ``None``.
    """
    from pathlib import Path as _Path
    from agent.core.overlays import OverlayNotFound, list_overlays, resolve_overlay

    if from_overlay:
        if overlay:
            print("[yellow]Both --from and --overlay given; using --from and ignoring --overlay.[/yellow]")
        try:
            return resolve_overlay(from_overlay)
        except OverlayNotFound as e:
            print(f"\n[bold red]✗[/bold red] {e}")
            raise typer.Exit(1)

    if overlay:
        print("[yellow]--overlay is deprecated; use [bold]--from <overlay-name|path>[/bold] instead.[/yellow]")
        return _Path(overlay).resolve()

    # No flag: default to the sole tracked overlay, if exactly one.
    tracked = list_overlays()
    if len(tracked) == 1:
        print(f"[dim]Using tracked overlay '{tracked[0]}' (the only one registered).[/dim]")
        return resolve_overlay(tracked[0])
    if len(tracked) > 1:
        names = ", ".join(tracked)
        print(
            f"\n[bold red]✗[/bold red] {len(tracked)} tracked overlays registered ({names}).\n"
            "Choose one with [bold]--from <name>[/bold]."
        )
        raise typer.Exit(1)
    return None


@app.command()
def migrate(
    path: str = typer.Option(".", "--path", "-p", help="Project root to migrate (default: current directory)."),
    framework: str = typer.Option(None, "--framework", "-f", help="Override auto-detected framework."),
    from_overlay: str = typer.Option(
        None, "--from",
        help="Tracked overlay (name or path) whose .canary/skills/ are deployed into "
             "the target. A bare name resolves against overlays added via `canary overlay "
             "add` (~/.canary/overlays/); with exactly one tracked overlay, this defaults "
             "to it. Skills are filtered by deploy_to frontmatter matching the detected shape.",
    ),
    overlay: str = typer.Option(
        None, "--overlay", "-o",
        help="[deprecated: use --from] Path to an overlay repo whose .canary/skills/ are "
             "deployed into the target.",
    ),
    apply: bool = typer.Option(False, "--apply", help="Write files. Without this flag the command is a dry run."),
    output_json: bool = typer.Option(False, "--json", help="Emit the migration report as JSON."),
):
    """
    Migrate a harness-scaffolded test-suite project to Canary's layout.

    Detects harness markers (harness.config.json + .harness/), auto-detects the
    framework, drops Canary config files, and reports what was created or preserved.
    Dry-run by default — pass --apply to write files.

    Pass --from <overlay> to also deploy overlay skills into the target's
    .canary/skills/. Skills with deploy_to matching the detected shape are copied;
    skills already present are skipped.
    """
    from pathlib import Path as _Path
    from agent.core.migrator import HarnessMigrator

    root = _Path(path).resolve()
    overlay_path = _resolve_migrate_overlay(from_overlay, overlay)
    migrator = HarnessMigrator()

    try:
        ctx = migrator.detect(root)
    except Exception as e:
        print(f"\n[bold red]Detection error:[/bold red] {e}")
        raise typer.Exit(1)

    if not ctx.is_harness_project:
        print(
            f"\n[bold red]✗[/bold red] No harness project detected at [bold]{root}[/bold].\n"
            "Expected [dim]harness.config.json[/dim] and [dim].harness/[/dim] directory."
        )
        raise typer.Exit(1)

    dry_run = not apply
    mode_label = "[dim](dry run)[/dim]" if dry_run else "[green](apply)[/green]"
    print(f"\n[bold cyan]Canary Migrate[/bold cyan] {mode_label}\n")

    if not dry_run:
        print("[yellow]Writing files to disk...[/yellow]\n")

    try:
        report = migrator.migrate(
            root, dry_run=dry_run, framework=framework or None, overlay_path=overlay_path
        )
    except ValueError as e:
        print(f"\n[bold red]Error:[/bold red] {e}")
        raise typer.Exit(1)

    if output_json:
        import json as _json
        _sys.stdout.write(_json.dumps({
            "framework": report.framework,
            "shape": report.shape,
            "dry_run": report.dry_run,
            "created_files": report.created_files,
            "created_dirs": report.created_dirs,
            "skipped_configs": report.skipped_configs,
            "preserved_files": report.preserved_files,
            "would_create": report.would_create,
            "manual_followups": report.manual_followups,
            "config_warnings": report.config_warnings,
            "deployed_skills": [
                {"skill_name": r.skill_name, "status": r.status, "note": r.note}
                for r in report.deployed_skills
            ],
        }, indent=2) + "\n")
        return

    print(report.to_markdown())

    if dry_run and report.would_create:
        print("\n[dim]Re-run with [bold]--apply[/bold] to write these files.[/dim]")


@app.command("review-test")
def review_test(
    path: str = typer.Argument(..., help="Test file or directory to lint."),
    static: bool = typer.Option(True, "--static/--no-static", help="Run static-only analysis (no LLM). Currently the only supported mode."),
    framework: Optional[str] = typer.Option(None, "--framework", "-f", help="Force framework: pytest, playwright, vitest, k6."),
    output_json: bool = typer.Option(False, "--json", help="Output findings as JSON."),
):
    """
    Lint test files for quality issues — no LLM or API key required.

    Checks for brittle selectors, hardcoded sleeps, missing assertions,
    random values, timestamp dependencies, missing awaits, and magic numbers.
    For generative critique, use /canary-review-test in Claude Code.
    """
    from agent.core.static_linter import StaticLinter

    target = Path(path)
    files = sorted(target.rglob("test_*.py") or []) + sorted(target.rglob("*.spec.ts") or []) \
        if target.is_dir() else [target]
    if target.is_dir():
        files = sorted(
            list(target.rglob("test_*.py")) +
            list(target.rglob("*.spec.ts")) +
            list(target.rglob("*.spec.js")) +
            list(target.rglob("*.test.ts")) +
            list(target.rglob("*.test.js"))
        )
    else:
        files = [target]

    linter = StaticLinter()
    all_findings = []
    for f in files:
        all_findings.extend(linter.lint(f, framework=framework))

    if output_json:
        import json as _json
        payload = [
            {"file": f.file, "line": f.line, "rule": f.rule,
             "severity": f.severity, "message": f.message, "suggestion": f.suggestion}
            for f in all_findings
        ]
        _sys.stdout.write(_json.dumps(payload, indent=2) + "\n")
        return

    if not all_findings:
        print("[bold green]✅ No issues found.[/bold green]")
        return

    severity_order = {"critical": 0, "warning": 1, "info": 2}
    all_findings.sort(key=lambda f: (f.file, f.line, severity_order.get(f.severity, 9)))

    counts = {"critical": 0, "warning": 0, "info": 0}
    for f in all_findings:
        counts[f.severity] = counts.get(f.severity, 0) + 1
        color = {"critical": "red", "warning": "yellow", "info": "dim"}.get(f.severity, "white")
        print(f"[{color}][{f.severity.upper()}][/{color}] {f.file}:{f.line} [dim]({f.rule})[/dim]")
        print(f"  {f.message}")
        print(f"  [dim]→ {f.suggestion}[/dim]\n")

    summary_parts = []
    if counts["critical"]:
        summary_parts.append(f"[red]{counts['critical']} critical[/red]")
    if counts["warning"]:
        summary_parts.append(f"[yellow]{counts['warning']} warning[/yellow]")
    if counts["info"]:
        summary_parts.append(f"[dim]{counts['info']} info[/dim]")
    print(f"[bold]{len(all_findings)} finding(s):[/bold] {', '.join(summary_parts)}")

    if counts["critical"]:
        raise typer.Exit(1)


@app.command("flake-check")
def flake_check(
    path: str = typer.Argument(..., help="Test file or directory to check."),
    output_json: bool = typer.Option(False, "--json", help="Output findings as JSON."),
):
    """
    Detect flakiness patterns in test files — no LLM or API key required.

    Flags hardcoded sleeps, non-deterministic random values, timestamp
    dependencies, and setTimeout without waitFor. For root-cause diagnosis
    of a specific intermittent failure, use /canary-debug-flake in Claude Code.
    """
    from agent.core.static_linter import StaticLinter

    target = Path(path)
    if target.is_dir():
        files = sorted(
            list(target.rglob("test_*.py")) +
            list(target.rglob("*.spec.ts")) +
            list(target.rglob("*.spec.js")) +
            list(target.rglob("*.test.ts")) +
            list(target.rglob("*.test.js"))
        )
    else:
        files = [target]

    linter = StaticLinter()
    all_findings = []
    for f in files:
        all_findings.extend(linter.flake_check(f))

    if output_json:
        import json as _json
        payload = [
            {"file": f.file, "line": f.line, "rule": f.rule,
             "severity": f.severity, "message": f.message, "suggestion": f.suggestion}
            for f in all_findings
        ]
        _sys.stdout.write(_json.dumps(payload, indent=2) + "\n")
        return

    if not all_findings:
        print("[bold green]✅ No flakiness patterns detected.[/bold green]")
        return

    for f in all_findings:
        color = "red" if f.severity == "critical" else "yellow"
        print(f"[{color}][{f.severity.upper()}][/{color}] {f.file}:{f.line} [dim]({f.rule})[/dim]")
        print(f"  {f.message}")
        print(f"  [dim]→ {f.suggestion}[/dim]\n")

    print(f"[bold]{len(all_findings)} flakiness pattern(s) found.[/bold]")
    raise typer.Exit(1)


@app.command("heal-test")
def heal_test(
    path: str = typer.Argument(..., help="Test file to heal."),
    pattern: bool = typer.Option(True, "--pattern/--no-pattern", help="Apply regex-safe pattern fixes (no LLM)."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Show what would change without writing."),
    output_json: bool = typer.Option(False, "--json", help="Output results as JSON."),
):
    """
    Apply deterministic pattern fixes to a test file — no LLM or API key required.

    Auto-fixes hardcoded sleeps (replaced with TODO comments) and missing awaits
    before Playwright actions. Brittle selectors are flagged but not auto-fixed —
    selector repair requires DOM context; use /canary-heal-test in Claude Code.
    """
    from agent.core.pattern_healer import PatternHealer

    target = Path(path)
    if not target.is_file():
        print(f"[red]Error: {path} is not a file.[/red]")
        raise typer.Exit(1)

    healer = PatternHealer()
    result = healer.heal(target)

    if output_json:
        import json as _json
        payload = {
            "file": result.file,
            "changed": result.changed,
            "changes": [
                {"line": c.line, "rule": c.rule, "description": c.description,
                 "before": c.before.strip(), "after": c.after.strip()}
                for c in result.changes
            ],
            "skipped": result.skipped,
        }
        _sys.stdout.write(_json.dumps(payload, indent=2) + "\n")
        if result.changed and not dry_run:
            target.write_text(result.patched_content, encoding="utf-8")
        return

    if not result.changed:
        print("[bold green]✅ No auto-fixable patterns found.[/bold green]")
        for s in result.skipped:
            print(f"[yellow]⚠ Skipped:[/yellow] {s}")
        return

    print(f"[bold cyan]🔧 Pattern fixes for {path}[/bold cyan]\n")
    for c in result.changes:
        print(f"[green]line {c.line}[/green] [dim]({c.rule})[/dim] {c.description}")
        print(f"  [red]- {c.before.strip()}[/red]")
        print(f"  [green]+ {c.after.strip()}[/green]\n")

    for s in result.skipped:
        print(f"[yellow]⚠ Skipped:[/yellow] {s}\n")

    if dry_run:
        print(f"[dim]{len(result.changes)} fix(es) ready. Re-run without --dry-run to apply.[/dim]")
    else:
        target.write_text(result.patched_content, encoding="utf-8")
        print(f"[bold green]✅ {len(result.changes)} fix(es) applied to {path}[/bold green]")


@app.command()
def version():
    """
    Show Canary version info.
    """
    from importlib.metadata import PackageNotFoundError, version as _pkg_version
    from agent.ui.banner import print_banner
    try:
        ver = _pkg_version("canary-test-ai")
    except PackageNotFoundError:
        ver = "unknown"
    print_banner(version=ver)


@app.command()
def upgrade(
    dry_run: bool = typer.Option(False, "--dry-run", help="Show what would change without upgrading."),
):
    """
    Upgrade Canary to the latest published version.

    Uses pipx if Canary was installed that way; falls back to pip otherwise.
    """
    from importlib.metadata import PackageNotFoundError, version as _pkg_version

    try:
        current = _pkg_version("canary-test-ai")
    except PackageNotFoundError:
        current = "unknown"

    print(f"[dim]Current version: {current}[/dim]")

    if dry_run:
        print("[dim]Dry run — run without --dry-run to apply the upgrade.[/dim]")
        return

    # Try pipx first (preferred install method).
    pipx = subprocess.run(["pipx", "upgrade", "canary-test-ai"], capture_output=True, text=True)
    if pipx.returncode == 0:
        try:
            updated = _pkg_version("canary-test-ai")
        except PackageNotFoundError:
            updated = "unknown"
        if updated != current:
            print(f"[green]✓ {current} → {updated}[/green]")
        else:
            print(f"[dim]Already up to date ({current})[/dim]")
        return

    # Fall back to pip.
    print("[yellow]pipx not found — trying pip...[/yellow]")
    pip = subprocess.run(
        [_sys.executable, "-m", "pip", "install", "--upgrade", "canary-test-ai"],
        capture_output=True, text=True,
    )
    if pip.returncode == 0:
        try:
            updated = _pkg_version("canary-test-ai")
        except PackageNotFoundError:
            updated = "unknown"
        if updated != current:
            print(f"[green]✓ {current} → {updated}[/green]")
        else:
            print(f"[dim]Already up to date ({current})[/dim]")
    else:
        print(f"[red]Upgrade failed.[/red]\n{pip.stderr.strip()}")
        raise typer.Exit(1)


# ---------------------------------------------------------------------------
# `canary history` — shared run history store (flakiness + regression queries).
# ---------------------------------------------------------------------------

from agent.history.cli import history_app
app.add_typer(history_app, name="history")

from agent.analysis.cli import analyze_app
app.add_typer(analyze_app, name="analyze")

from agent.guardian.cli import guardian_app
app.add_typer(guardian_app, name="guardian")


# ---------------------------------------------------------------------------
# `canary skills` — discovery + invocation of bundled and overlay skills.
# ---------------------------------------------------------------------------

skills_app = typer.Typer(help="List and invoke discoverable Canary skills.")
app.add_typer(skills_app, name="skills")


@skills_app.command("list")
def skills_list(
    verbose: bool = typer.Option(
        False, "--verbose", "-v",
        help="Also print the SKILL.md path for each skill.",
    ),
) -> None:
    """List every skill discoverable from the current directory."""
    from agent.core.skill_registry import SkillRegistry

    skills = SkillRegistry().discover()
    if not skills:
        print("[yellow]No skills found.[/yellow]")
        return

    bundled = [s for s in skills if s.source == "bundled"]
    overlay = [s for s in skills if s.source == "overlay"]
    global_ = [s for s in skills if s.source == "global"]
    local = [s for s in skills if s.source == "local"]

    def _overlay_name(skill) -> str:
        # Clone layout: ~/.canary/overlays/<overlay>/.canary/skills/<name>/SKILL.md
        parts = skill.path.parts
        try:
            return parts[parts.index("overlays") + 1]
        except (ValueError, IndexError):
            return "?"

    def _format(skill) -> str:
        # Backslash-escapes prevent rich from interpreting [cli]/[entry]
        # as markup tags so the literal brackets reach stdout.
        marker = ""
        if skill.error:
            marker = r" \[error]"
        elif skill.cli:
            marker = r" \[cli]"
        elif skill.entry:
            marker = r" \[entry]"
        desc = f"  {skill.description}" if skill.description else ""
        line = f"  /{skill.name}{marker}{desc}"
        if verbose:
            line += f"\n    [dim]{skill.path}[/dim]"
        return line

    if bundled:
        print("[bold]Bundled skills:[/bold]")
        for skill in bundled:
            print(_format(skill))
    if overlay:
        from itertools import groupby

        grouped = groupby(sorted(overlay, key=_overlay_name), key=_overlay_name)
        for idx, (oname, group) in enumerate(grouped):
            if bundled or idx > 0:
                print()
            print(f"[bold]Overlay skills[/bold] [dim]({oname} — override bundled):[/dim]")
            for skill in group:
                print(_format(skill))
    if global_:
        if bundled or overlay:
            print()
        print("[bold]Global skills[/bold] [dim](~/.canary/skills/ — override overlay):[/dim]")
        for skill in global_:
            print(_format(skill))
    if local:
        if bundled or overlay or global_:
            print()
        print("[bold]Local overlay skills[/bold] [dim](override global):[/dim]")
        for skill in local:
            print(_format(skill))


@skills_app.command("run")
def skills_run(
    name: str = typer.Argument(..., help="Name of the skill to invoke."),
    args: list[str] = typer.Argument(
        None, help="Arguments forwarded to the skill's cli/entry.",
    ),
    allow_executable_skills: bool = typer.Option(
        False, "--allow-executable-skills",
        help="Opt-in to invoking cli:/entry: skills in non-interactive (CI) contexts.",
    ),
) -> None:
    """Invoke a code-bearing skill's declared cli or entry target.

    Refuses to run when:
    - The skill has no cli/entry field (markdown-only)
    - The skill has a validation error (e.g. both cli and entry declared)
    - The cli path escapes the skill directory after symlink resolution
    - The context is non-interactive and --allow-executable-skills is unset
    """
    import subprocess
    import sys
    from agent.core.skill_registry import (
        SkillRegistry,
        is_executable_skill_allowed,
        resolve_cli_path,
    )

    skill = SkillRegistry().find(name)
    if skill is None:
        print(f"[red]✗[/red] No skill named [bold]{name}[/bold] found.")
        raise typer.Exit(1)
    if skill.error:
        print(f"[red]✗[/red] Skill [bold]{name}[/bold]: {skill.error}")
        raise typer.Exit(2)
    if not skill.is_executable:
        print(
            f"[yellow]Skill [bold]{name}[/bold] is markdown-only — no "
            f"cli: or entry: field to run.[/yellow]"
        )
        raise typer.Exit(2)
    if not is_executable_skill_allowed(allow_executable_skills):
        print(
            "[red]✗[/red] Refusing to invoke executable skill in "
            "non-interactive context. Pass [bold]--allow-executable-skills[/bold] "
            "to opt in (e.g. in trusted CI configurations)."
        )
        raise typer.Exit(3)

    forwarded = list(args or [])

    if skill.cli:
        try:
            target = resolve_cli_path(skill)
        except ValueError as exc:
            print(f"[red]✗[/red] {exc}")
            raise typer.Exit(4)
        # Run .py skills with the same interpreter that runs canary so that
        # canary's own venv dependencies (e.g. openpyxl) are available.
        import sys as _sys
        cmd = ([_sys.executable, str(target)] if str(target).endswith(".py")
               else [str(target)])
        result = subprocess.run(cmd + forwarded, cwd=str(skill.dir))
        raise typer.Exit(result.returncode)

    if skill.entry:
        module_name, _, attr = skill.entry.partition(":")
        if not module_name or not attr:
            print(
                f"[red]✗[/red] Skill [bold]{name}[/bold] entry must be "
                f"'module:callable', got {skill.entry!r}"
            )
            raise typer.Exit(5)
        try:
            import importlib
            module = importlib.import_module(module_name)
            target = getattr(module, attr)
        except (ImportError, AttributeError) as exc:
            print(
                f"[red]✗[/red] Skill [bold]{name}[/bold] entry "
                f"{skill.entry!r}: {exc}"
            )
            raise typer.Exit(6)

        saved_argv = sys.argv
        sys.argv = [skill.entry, *forwarded]
        try:
            rc = target()
        except SystemExit as exc:
            rc = exc.code if isinstance(exc.code, int) else 0
        finally:
            sys.argv = saved_argv
        raise typer.Exit(int(rc or 0))


# ---------------------------------------------------------------------------
# `canary overlay` — handled by the npm shim (TypeScript). The Python entry
# point only reaches here on pipx installs, where it points at the npm install
# instead of failing with an unknown-command error.
# ---------------------------------------------------------------------------


@app.command(
    "overlay",
    context_settings={"ignore_unknown_options": True, "allow_extra_args": True},
    help="Manage tracked overlays (requires the npm install of Canary).",
)
def overlay(ctx: typer.Context) -> None:
    """`canary overlay` is provided by the npm shim, not the Python entry point.

    On an npm install the shim routes ``overlay`` to its TypeScript handler and
    never reaches here. This command exists so a pipx-installed engine prints a
    clear pointer instead of a Typer 'No such command' error.
    """
    print(
        "[yellow]`canary overlay` is provided by the npm install of Canary.[/yellow]\n"
        "Install it with:  [bold]npm install -g canary-test-cli[/bold]\n"
        "The pipx/Python entry point does not include the overlay commands."
    )
    raise typer.Exit(code=1)


# ---------------------------------------------------------------------------
# `canary doctor` — handled by the npm shim (TypeScript). The Python entry
# point only reaches here on pipx installs, where it points at the npm install
# instead of failing with an unknown-command error.
# ---------------------------------------------------------------------------


@app.command(
    "doctor",
    context_settings={"ignore_unknown_options": True, "allow_extra_args": True},
    help="Diagnose your Canary setup (requires the npm install of Canary).",
)
def doctor(ctx: typer.Context) -> None:
    """`canary doctor` is provided by the npm shim, not the Python entry point.

    On an npm install the shim routes ``doctor`` to its TypeScript handler and
    never reaches here. This command exists so a pipx-installed engine prints a
    clear pointer instead of a Typer 'No such command' error.
    """
    print(
        "[yellow]`canary doctor` is provided by the npm install of Canary.[/yellow]\n"
        "Install it with:  [bold]npm install -g canary-test-cli[/bold]\n"
        "The pipx/Python entry point does not include the doctor command."
    )
    raise typer.Exit(code=1)


# ---------------------------------------------------------------------------
# `canary workflow` — per-project issue-workflow discovery and inspection.
# ---------------------------------------------------------------------------

workflow_app = typer.Typer(help="Discover and inspect per-project issue-workflow mappings.")
app.add_typer(workflow_app, name="workflow")


@workflow_app.command("discover")
def workflow_discover(
    project: Optional[str] = typer.Option(
        None,
        "--project",
        "-p",
        help="Jira project key (e.g. ACME) or GitHub repo slug (owner/repo). "
             "Defaults to all keys in .canary/company.json jira_projects.",
    ),
    refresh: bool = typer.Option(
        False, "--refresh", help="Re-discover even if a cached mapping already exists."
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Print the mapping that would be written without writing it."
    ),
) -> None:
    """
    Discover the Jira or GitHub workflow for one or more projects and persist
    the mapping to .canary/workflow-<key>.json.

    Requires ATLASSIAN_URL, ATLASSIAN_USER, and ATLASSIAN_TOKEN environment
    variables for Jira projects, or an authenticated `gh` CLI for GitHub repos.
    """
    from agent.core.workflow_discovery import WorkflowDiscovery, WorkflowDiscoveryError

    wd = WorkflowDiscovery()

    # Resolve the list of project keys to discover.
    keys: list[str] = []
    if project:
        keys = [project]
    else:
        # Read from .canary/company.json if present.
        company_path = Path.cwd() / ".canary" / "company.json"
        if company_path.exists():
            try:
                data = json.loads(company_path.read_text(encoding="utf-8"))
                keys = data.get("jira_projects", [])
            except (json.JSONDecodeError, OSError):
                pass
        if not keys:
            print(
                "[yellow]No project keys found.[/yellow] "
                "Pass [bold]--project <key>[/bold] or add keys to "
                "[bold].canary/company.json[/bold] → [bold]jira_projects[/bold]."
            )
            raise typer.Exit(1)

    errors: list[str] = []
    for key in keys:
        print(f"\n[bold cyan]🔍 Discovering workflow for {key}…[/bold cyan]")
        try:
            mapping = wd.discover(key, refresh=refresh, dry_run=dry_run)
        except WorkflowDiscoveryError as exc:
            print(f"[red]✗[/red] {exc}")
            errors.append(key)
            continue

        # Summary output.
        n_types = len(mapping.issue_types)
        n_roles = len(mapping.semantic_roles)
        confirmed = "✓ confirmed" if mapping.role_annotations_confirmed else "⚠ unconfirmed"
        if dry_run:
            print(f"[dim](dry-run)[/dim] {mapping.to_json()}")
        else:
            print(
                f"[green]✓[/green] {key}: {n_types} issue type(s), "
                f"{n_roles} semantic role(s) [{confirmed}]"
            )
            if not mapping.role_annotations_confirmed:
                print(
                    "[dim]  Tip: verify role assignments with "
                    "[bold]canary workflow show --project "
                    f"{key} --roles-only[/bold][/dim]"
                )

    if errors:
        print(f"\n[red]Discovery failed for: {', '.join(errors)}[/red]")
        raise typer.Exit(1)


@workflow_app.command("show")
def workflow_show(
    project: Optional[str] = typer.Option(
        None, "--project", "-p",
        help="Jira project key or GitHub repo slug. Shows all cached mappings if omitted.",
    ),
    roles_only: bool = typer.Option(
        False, "--roles-only", help="Print only the semantic_roles block."
    ),
    output_json: bool = typer.Option(
        False, "--json", help="Emit raw JSON instead of styled output."
    ),
) -> None:
    """
    Print the persisted workflow mapping for a project.

    Use --roles-only to verify semantic role assignments at a glance before
    Canary uses them to transition tickets.
    """
    from agent.core.workflow_discovery import WorkflowDiscovery

    wd = WorkflowDiscovery()

    # Resolve project keys.
    keys: list[str] = []
    if project:
        keys = [project]
    else:
        canary_dir = Path.cwd() / ".canary"
        if canary_dir.is_dir():
            keys = [
                p.stem.removeprefix("workflow-")
                for p in canary_dir.glob("workflow-*.json")
            ]
        if not keys:
            print("[yellow]No cached workflow mappings found.[/yellow]")
            raise typer.Exit(0)

    any_found = False
    for key in keys:
        mapping = wd.show(key)
        if mapping is None:
            print(f"[yellow]No cached mapping for {key}.[/yellow]  "
                  f"Run [bold]canary workflow discover --project {key}[/bold] first.")
            continue

        any_found = True

        if output_json:
            if roles_only:
                roles_dict = {
                    r: {"status_name": sr.status_name, "issue_type": sr.issue_type}
                    for r, sr in mapping.semantic_roles.items()
                }
                print(json.dumps(roles_dict, indent=2))
            else:
                print(mapping.to_json())
            continue

        # Styled output.
        confirmed_tag = (
            "[green]confirmed[/green]"
            if mapping.role_annotations_confirmed
            else "[yellow]unconfirmed[/yellow]"
        )
        print(
            f"\n[bold]{key}[/bold]  "
            f"[dim]source={mapping.source}  "
            f"discovered={mapping.discovered_at}  "
            f"roles={confirmed_tag}[/dim]"
        )

        if roles_only:
            if mapping.semantic_roles:
                print("  [bold]Semantic roles:[/bold]")
                for role, sr in mapping.semantic_roles.items():
                    print(f"    {role:<20} → {sr.status_name!r}  [dim]({sr.issue_type})[/dim]")
            else:
                print("  [yellow]No semantic roles resolved yet.[/yellow]")
            continue

        for it in mapping.issue_types:
            print(f"\n  [bold]{it.name}[/bold]")
            for s in it.statuses:
                print(f"    [{s.category}] {s.name}")
            if it.transitions:
                print("    Transitions:")
                for t in it.transitions:
                    print(f"      {t.from_status} → {t.to_status}  [dim]({t.name})[/dim]")

        if mapping.semantic_roles:
            print("\n  [bold]Semantic roles:[/bold]")
            for role, sr in mapping.semantic_roles.items():
                print(f"    {role:<20} → {sr.status_name!r}  [dim]({sr.issue_type})[/dim]")

    if not any_found:
        raise typer.Exit(1)


@workflow_app.command("init")
def workflow_init(
    project: str = typer.Option(..., "--project", "-p", help="Jira project key (e.g. ACME)."),
    qa_passed: str = typer.Option(
        ...,
        "--qa-passed",
        help="Exact Jira status name that means QA passed (e.g. 'QA Passed', 'Testing Complete').",
    ),
    in_qa: Optional[str] = typer.Option(
        None,
        "--in-qa",
        help="Exact Jira status name for 'in QA' (e.g. 'In QA', 'Testing'). Optional.",
    ),
    atlassian_url: Optional[str] = typer.Option(
        None,
        "--atlassian-url",
        help="Jira base URL for this project (e.g. https://acme.atlassian.net). "
             "Stored in the mapping so canary ticket-update never needs ATLASSIAN_URL "
             "for this project. Defaults to the ATLASSIAN_URL env var if omitted.",
    ),
    force: bool = typer.Option(
        False, "--force", help="Overwrite an existing mapping file."
    ),
) -> None:
    """
    Create a minimal workflow mapping for a project without running discovery.

    Use this when you know the Jira status names for your project and don't
    want to (or can't) run canary workflow-discover against a live Jira instance.
    The mapping is written to .canary/workflow-<PROJECT>.json with
    role_annotations_confirmed=true so canary ticket-update uses it immediately.

    Example:

        canary workflow init --project ACME --qa-passed "QA Passed" --in-qa "In QA"

    To use a different Atlassian instance for this project:

        canary workflow init --project INTERNAL --qa-passed "Done" \\
            --atlassian-url https://internal.atlassian.net
    """
    import os as _os
    from agent.core.workflow_discovery import SemanticRole, WorkflowDiscovery, WorkflowMapping

    wd = WorkflowDiscovery()
    mapping_path = wd._mapping_path(project)

    if mapping_path.exists() and not force:
        print(
            f"[yellow]⚠[/yellow]  Mapping already exists at {mapping_path}.\n"
            "Use [bold]--force[/bold] to overwrite."
        )
        raise typer.Exit(1)

    # Resolve atlassian_url: explicit flag > env var > None.
    resolved_url = (atlassian_url or _os.environ.get("ATLASSIAN_URL", "") or "").rstrip("/") or None

    semantic_roles: dict[str, SemanticRole] = {
        "qa_passed": SemanticRole(status_name=qa_passed, issue_type="Story"),
    }
    if in_qa:
        semantic_roles["in_qa"] = SemanticRole(status_name=in_qa, issue_type="Story")

    mapping = WorkflowMapping(
        project_key=project,
        source="jira",
        discovered_at=_now_iso_cli(),
        issue_types=[],
        semantic_roles=semantic_roles,
        role_annotations_confirmed=True,
        atlassian_url=resolved_url,
    )
    wd._write(mapping)

    print(f"[green]✓[/green] Created {mapping_path}")
    print(f"  qa_passed  → {qa_passed!r}")
    if in_qa:
        print(f"  in_qa      → {in_qa!r}")
    if resolved_url:
        print(f"  atlassian_url → {resolved_url}")
    print(
        "\n[dim]Verify with: [bold]canary workflow show --project "
        f"{project} --roles-only[/bold][/dim]"
    )


def _now_iso_cli() -> str:
    from datetime import datetime, timezone

    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


@app.command("ticket-update")
def ticket_update(
    test_file: Optional[str] = typer.Option(
        None,
        "--test-file",
        help="Test file to extract linkage from (default: last run).",
    ),
    result_path: Optional[str] = typer.Option(
        None,
        "--result",
        help="Path to canary report JSON (default: auto-detect).",
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Show what would be posted/transitioned; don't write."
    ),
    comment_only: bool = typer.Option(
        False, "--comment-only", help="Post comment but skip transition."
    ),
    transition_only: bool = typer.Option(
        False, "--transition-only", help="Transition only, skip comment."
    ),
    project: Optional[str] = typer.Option(
        None, "--project", help="Override auto-detected project key."
    ),
    ticket: Optional[str] = typer.Option(
        None, "--ticket", help="Override auto-detected ticket key (e.g. PROJ-1234)."
    ),
) -> None:
    """
    Post a run comment and/or transition the linked ticket after a test run.

    Ticket linkage is detected from the test file frontmatter
    (# canary:ticket: KEY), a @ticket:KEY tag, or the current branch name.
    Transition targets are resolved from the workflow mapping produced by
    `canary workflow-discover` -- no status names are hardcoded.
    """
    import os
    from agent.core.ticket_updater import RunSummary, TicketUpdater

    # ── load report JSON ──────────────────────────────────────────────────────
    report_data: dict = {}
    if result_path:
        try:
            report_data = json.loads(Path(result_path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[red]Could not read result file {result_path!r}: {exc}[/red]")
            raise typer.Exit(1) from exc

    # Build a RunSummary from report_data (or sensible defaults for ad-hoc use).
    suite_name = report_data.get("suite_name", test_file or "unknown")
    env_name = report_data.get("env", os.environ.get("CANARY_ENV", "unknown"))
    raw_result = report_data.get("result", "FAIL").upper()
    if raw_result not in ("PASS", "FAIL", "PARTIAL"):
        raw_result = "FAIL"

    passed_names: list[str] = report_data.get("passed_names", [])
    failed_pairs: list = report_data.get("failed_names", [])
    # Normalise to list[tuple[str, str]].
    failed_names: list[tuple[str, str]] = [
        (item[0], item[1]) if (isinstance(item, (list, tuple)) and len(item) >= 2)
        else (str(item), "unknown")
        for item in failed_pairs
    ]

    summary = RunSummary(
        suite_name=suite_name,
        env=env_name,
        result=raw_result,  # type: ignore[arg-type]
        passed=report_data.get("passed", len(passed_names)),
        total=report_data.get("total", len(passed_names) + len(failed_names)),
        flaky_count=report_data.get("flaky_count", 0),
        duration_s=float(report_data.get("duration_s", 0.0)),
        test_file=test_file or report_data.get("test_file", ""),
        report_url=report_data.get("report_url"),
        passed_names=passed_names,
        failed_names=failed_names,
        ticket_key=ticket,
        project_key=project,
    )

    updater = TicketUpdater()
    update_result = updater.update(
        summary,
        dry_run=dry_run,
        comment_only=comment_only,
        transition_only=transition_only,
    )

    # ── render output ─────────────────────────────────────────────────────────
    for msg in update_result.messages:
        print(msg)

    if not dry_run:
        if update_result.comment_posted:
            print(
                f"[green]✓[/green] Comment posted to {update_result.ticket_key}"
            )
        tr = update_result.transition
        if tr.attempted and tr.succeeded:
            print(
                f"[green]✓[/green] Transitioned {update_result.ticket_key}: "
                f'"{tr.from_status}" → "{tr.to_status}"'
            )
        elif tr.attempted and not tr.succeeded:
            print(f"[yellow]⚠[/yellow]  Transition failed: {tr.reason}")

    if update_result.transition.reason.startswith("⚠"):
        raise typer.Exit(1)


# ---------------------------------------------------------------------------
# `canary company-knowledge` — load, show, and scaffold .canary/company.json
# ---------------------------------------------------------------------------

ck_app = typer.Typer(help="Manage company-knowledge pointers in .canary/company.json.")
app.add_typer(ck_app, name="company-knowledge")


@ck_app.command("show")
def ck_show(
    env: Optional[str] = typer.Option(
        None, "--env", "-e",
        help="Environment override layer to load (e.g. 'uat'). Defaults to CANARY_ENV.",
    ),
    output_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
) -> None:
    """
    Print the merged company-knowledge view.

    Merges ~/.canary/company.json (org defaults), .canary/company.json
    (project-local), and .canary/company.<env>.json (env override) and prints
    the resolved result. Useful for debugging grounding issues.
    """
    from agent.core.company_knowledge import CompanyKnowledge

    ck = CompanyKnowledge.load(env=env or None)

    if ck.error and ck.is_empty:
        print(f"[red]✗[/red] {ck.error}")
        raise typer.Exit(1)

    if output_json:
        _sys.stdout.write(json.dumps(ck.to_dict(), indent=2) + "\n")
        return

    if ck.is_empty:
        print("[yellow]No company knowledge configured.[/yellow]  "
              "Create [bold].canary/company.json[/bold] or run "
              "[bold]canary company-knowledge init[/bold].")
        return

    sources_str = ", ".join(ck.sources) if ck.sources else "none"
    print(f"[bold green]✓ Company Knowledge[/bold green]  [dim]sources: {sources_str}[/dim]\n")
    if ck.confluence_spaces:
        print(f"[bold]Confluence spaces:[/bold] {', '.join(ck.confluence_spaces)}")
    if ck.jira_projects:
        print(f"[bold]Jira projects:[/bold]     {', '.join(ck.jira_projects)}")
    if ck.internal_doc_urls:
        print("[bold]Reference docs:[/bold]")
        for url in ck.internal_doc_urls:
            print(f"  {url}")
    if ck.internal_domains:
        print(f"[bold]Internal domains:[/bold]  {', '.join(ck.internal_domains)}")
    if ck.mcp_servers:
        print(f"[bold]MCP servers:[/bold]       {', '.join(ck.mcp_servers)}")
    if ck.claude_code_skills:
        print(f"[bold]Claude Code skills:[/bold] {', '.join(ck.claude_code_skills)}")
    if ck.dashboard_url:
        print(f"[bold]Dashboard URL:[/bold]     {ck.dashboard_url}")
    if ck.otel_exporter_endpoint:
        print(f"[bold]OTel endpoint:[/bold]     {ck.otel_exporter_endpoint}")
    if ck.notes:
        print(f"[bold]Notes:[/bold] {ck.notes}")
    if ck.error:
        print(f"\n[yellow]⚠[/yellow] {ck.error}")
    if ck.warnings:
        print()
        for w in ck.warnings:
            print(f"[yellow]⚠[/yellow] {w}")


@ck_app.command("init")
def ck_init(
    force: bool = typer.Option(
        False, "--force", help="Overwrite an existing .canary/company.json."
    ),
) -> None:
    """
    Interactively scaffold .canary/company.json.

    Walks you through each pointer field with examples. Existing values are
    shown as defaults so re-running is safe (merges unless --force is passed).
    Secrets are never accepted — store those in environment variables.
    """
    from agent.core.company_knowledge import CompanyKnowledge

    canary_dir = Path.cwd() / ".canary"
    out_path = canary_dir / "company.json"

    # Load existing data as defaults.
    existing = CompanyKnowledge.load() if out_path.exists() else CompanyKnowledge()

    if out_path.exists() and not force:
        print(
            f"[yellow]⚠[/yellow]  [bold]{out_path}[/bold] already exists.\n"
            "Existing values will be shown as defaults. "
            "Pass [bold]--force[/bold] to start from scratch."
        )
        print()

    def _prompt_list(
        label: str,
        example: str,
        current: list[str],
        hint: str = "",
    ) -> list[str]:
        default_str = ", ".join(current) if current else ""
        display_default = f" [{default_str}]" if default_str else ""
        prompt_text = f"{label}{display_default} (comma-separated{', ' + hint if hint else ''}): "
        raw = typer.prompt(prompt_text, default=default_str, show_default=False)
        if not raw.strip():
            return current
        return [v.strip() for v in raw.split(",") if v.strip()]

    def _prompt_str(label: str, current: str, hint: str = "") -> str:
        display_default = f" [{current}]" if current else ""
        prompt_text = f"{label}{display_default}{': ' if not hint else ' (' + hint + '): '}"
        raw = typer.prompt(prompt_text, default=current, show_default=False)
        return raw.strip()

    print("[bold cyan]Canary Company Knowledge Setup[/bold cyan]\n")
    print("Enter values for each pointer field, or press Enter to keep the current value.")
    print("Leave a field empty to skip it. [dim]Secrets are never accepted here.[/dim]\n")

    confluence_spaces = _prompt_list(
        "Confluence space keys", "QA, ENG",
        existing.confluence_spaces, "uppercase, e.g. QA"
    )
    jira_projects = _prompt_list(
        "Jira project keys", "PROJ, OPS",
        existing.jira_projects, "uppercase, e.g. PROJ"
    )

    print("\nInternal doc URLs (one per line, blank line to finish):")
    doc_urls: list[str] = list(existing.internal_doc_urls)
    if doc_urls:
        print(f"  Current: {', '.join(doc_urls)}")
    while True:
        url = typer.prompt("  URL (or Enter to finish)", default="", show_default=False)
        if not url.strip():
            break
        doc_urls.append(url.strip())

    internal_domains = _prompt_list(
        "\nInternal hostnames", "corp.example.com",
        existing.internal_domains, "e.g. corp.example.com"
    )
    mcp_servers = _prompt_list(
        "MCP server identifiers", "plugin_atlassian_atlassian",
        existing.mcp_servers, "e.g. plugin_atlassian_atlassian"
    )
    claude_code_skills = _prompt_list(
        "Claude Code skill slugs", "team:skill-name",
        existing.claude_code_skills, "e.g. team:skill-name"
    )
    notes_raw = _prompt_str(
        "\nFree-text notes for the LLM", existing.notes,
        "no secrets"
    )
    notes = notes_raw[:2048] if notes_raw else ""

    # Build output dict (omit empty lists/strings).
    out: dict = {}
    if confluence_spaces:
        out["confluence_spaces"] = [v.upper() for v in confluence_spaces]
    if jira_projects:
        out["jira_projects"] = [v.upper() for v in jira_projects]
    if doc_urls:
        out["internal_doc_urls"] = doc_urls
    if internal_domains:
        out["internal_domains"] = [v.lower() for v in internal_domains]
    if mcp_servers:
        out["mcp_servers"] = mcp_servers
    if claude_code_skills:
        out["claude_code_skills"] = [v.lower() for v in claude_code_skills]
    if notes:
        out["notes"] = notes

    # Ensure .canary/ exists.
    canary_dir.mkdir(parents=True, exist_ok=True)

    # Ensure .canary/ is gitignored.
    gitignore = Path.cwd() / ".gitignore"
    if gitignore.exists():
        content = gitignore.read_text(encoding="utf-8")
        if ".canary/" not in content:
            gitignore.write_text(content.rstrip() + "\n.canary/\n", encoding="utf-8")

    out_path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")

    print(f"\n[green]✓[/green] Written to [bold]{out_path}[/bold]")
    print("[dim]Verify with: canary company-knowledge show[/dim]")


if __name__ == "__main__":
    app()
