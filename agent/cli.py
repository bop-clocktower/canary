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

app = typer.Typer()


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


@app.command()
def migrate(
    path: str = typer.Option(".", "--path", "-p", help="Project root to migrate (default: current directory)."),
    framework: str = typer.Option(None, "--framework", "-f", help="Override auto-detected framework."),
    apply: bool = typer.Option(False, "--apply", help="Write files. Without this flag the command is a dry run."),
    output_json: bool = typer.Option(False, "--json", help="Emit the migration report as JSON."),
):
    """
    Migrate a harness-scaffolded test-suite project to Canary's layout.

    Detects harness markers (harness.config.json + .harness/), auto-detects the
    framework, drops Canary config files, and reports what was created or preserved.
    Dry-run by default — pass --apply to write files.
    """
    from pathlib import Path as _Path
    from agent.core.migrator import HarnessMigrator

    root = _Path(path).resolve()
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
        report = migrator.migrate(root, dry_run=dry_run, framework=framework or None)
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
        }, indent=2) + "\n")
        return

    print(report.to_markdown())

    if dry_run and report.would_create:
        print("\n[dim]Re-run with [bold]--apply[/bold] to write these files.[/dim]")


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
    local = [s for s in skills if s.source == "local"]

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
    if local:
        if bundled:
            print()
        print("[bold]Local overlay skills[/bold] [dim](override bundled):[/dim]")
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
        result = subprocess.run(
            [str(target), *forwarded],
            cwd=str(skill.dir),
        )
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


if __name__ == "__main__":
    app()
