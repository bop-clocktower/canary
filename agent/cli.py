# agent/cli.py

"""
Oracle CLI - The primary user interface for AI-powered test automation.

This module provides the Typer-based command-line interface for generating,
running, and initializing test suites. It serves as the entry point for
the Oracle agent.
"""

import json
from typing import Optional
import typer
from rich import print

app = typer.Typer()


@app.command()
def generate(
    prompt: str,
    recommend_only: bool = typer.Option(False, "--recommend-only", "-r", help="Only show the recommendation, skip generation."),
    output_json: bool = typer.Option(False, "--json", help="Output results in JSON format for tool integration."),
    run_test: bool = typer.Option(False, "--run", help="Execute the test immediately after generation."),
    report_format: Optional[str] = typer.Option(None, "--report-format", help="Export a report: json or sarif."),
    report_file: Optional[str] = typer.Option(None, "--report-file", help="Report output path. Defaults to oracle-report.{format}."),
):
    """
    Generate test automation code from a natural language prompt.

    Args:
        prompt: Natural language description of the test requirements.
        recommend_only: If True, identifies the framework but skips code generation.
        output_json: If True, outputs machine-readable JSON instead of styled text.
        run_test: If True, executes the generated test using the identified framework.
    """
    from agent.core.orchestrator import OracleOrchestrator
    from agent.core.ci_env import is_ci

    # In CI, force machine-readable output so pipelines don't have to parse Rich markup.
    output_json = output_json or is_ci()

    if not output_json:
        print("\n[bold cyan]🧠 Oracle Processing Request...[/bold cyan]\n")

    if recommend_only:
        from agent.core.classifier import TestClassifier
        from agent.core.recommender import FrameworkRecommender
        
        classifier = TestClassifier()
        recommender = FrameworkRecommender()
        
        classification = classifier.classify(prompt)
        result = recommender.recommend(classification)
        
        if output_json:
            print(json.dumps({
                "status": "success",
                "mode": "recommendation",
                "test_type": classification.test_type,
                "framework": result["framework"],
                "file_extension": result["file_extension"],
                "reasoning": result["reason"]
            }, indent=2))
            return

        print("[bold green]✅ Oracle Recommendation (Draft Mode)[/bold green]\n")
        print(f"[bold]Test Type:[/bold] {classification.test_type}")
        print(f"[bold]Framework:[/bold] {result['framework']}")
        print("\n[bold]Reasoning:[/bold]")
        for r in result["reason"]:
            print(f" - {r}")
        print("\n[yellow]Note: Generation skipped due to --recommend-only flag.[/yellow]")
        return

    orchestrator = OracleOrchestrator()
    result = orchestrator.run(prompt, execute=run_test)

    report_path = None
    if report_file and not report_format:
        if not output_json:
            print("\n[bold yellow]Warning:[/bold yellow] --report-file ignored: --report-format not set.")
    if report_format:
        from agent.core.reporter import Reporter
        try:
            report_path = str(Reporter().write(result, report_format, report_file))
        except ValueError as e:
            if not output_json:
                print(f"\n[bold red]Report error:[/bold red] {e}")

    if output_json:
        print(json.dumps({
            "status": "success",
            "mode": "full_generation",
            "test_type": result["test_type"],
            "framework": result["framework"],
            "output_file": result["output_file"],
            "reasoning": result["reason"],
            "execution": result.get("execution"),
            **({"report_file": report_path} if report_path is not None else {}),
        }, indent=2))
        return

    print("\n[bold green]✅ Oracle Result[/bold green]\n")

    print(f"[bold]Test Type:[/bold] {result['test_type']}")
    print(f"[bold]Framework:[/bold] {result['framework']}")

    print("\n[bold]Reasoning:[/bold]")
    for r in result["reason"]:
        print(f" - {r}")

    print("\n[bold yellow]Output File:[/bold yellow]")
    print(result["output_file"])

    if report_path:
        print(f"\n[bold yellow]Report:[/bold yellow] {report_path}")

    if "execution" in result:
        print("\n[bold cyan]🚀 Execution Results:[/bold cyan]")
        exec_res = result["execution"]
        color = "green" if exec_res["exit_code"] == 0 else "red"
        print(f"[{color}]Exit Code: {exec_res['exit_code']}[/{color}]")
        if exec_res["stderr"]:
            print(f"[red]Error Output:[/red]\n{exec_res['stderr']}")
        if exec_res["stdout"]:
            # truncate stdout for readability
            stdout_preview = exec_res["stdout"][:500] + ("..." if len(exec_res["stdout"]) > 500 else "")
            print(f"[dim]Standard Output:[/dim]\n{stdout_preview}")


@app.command()
def run(
    file_path: str,
    framework: str = typer.Argument(..., help="Framework to use (e.g., playwright, pytest)")
):
    """
    Execute a test file using Oracle's integrated executor.

    Args:
        file_path: Path to the test file to execute.
        framework: The testing framework to use for execution.
    """
    from agent.core.executor import TestExecutor
    from pathlib import Path

    print(f"\n[bold cyan]🚀 Oracle Executing {framework} Test...[/bold cyan]\n")

    executor = TestExecutor()
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
    
    print(f"\n[bold cyan]🛠 Oracle Initializing {framework} Scaffold...[/bold cyan]\n")
    
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
def setup():
    """
    First-time developer setup. Run once after cloning the repository.

    Checks prerequisites (Node.js, harness-mcp), verifies the API key,
    and creates .claude/settings.local.json so Claude Code approves the
    project MCP servers without prompting.
    """
    import os
    import shutil
    import subprocess
    from pathlib import Path

    print("\n[bold cyan]Oracle Setup[/bold cyan]\n")

    issues = []

    # Locate repo root so the command works from any subdirectory.
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True
        )
        repo_root = Path(result.stdout.strip())
    except subprocess.CalledProcessError:
        repo_root = Path.cwd()

    # ── Node.js ───────────────────────────────────────────────
    if shutil.which("node"):
        v = subprocess.run(
            ["node", "--version"], capture_output=True, text=True
        ).stdout.strip()
        print(f"[green]✓[/green] Node.js {v}")
    else:
        print("[red]✗[/red] Node.js not found")
        print("  Install from [link=https://nodejs.org]nodejs.org[/link] "
              "then re-run setup.")
        issues.append("Node.js missing")

    # ── harness-mcp ───────────────────────────────────────────
    if shutil.which("harness-mcp"):
        print("[green]✓[/green] harness-mcp installed")
    else:
        print("[yellow]~[/yellow] harness-mcp not found — installing...")
        r = subprocess.run(
            ["npm", "install", "-g", "@harness-engineering/cli"],
            capture_output=True, text=True
        )
        if r.returncode == 0:
            print("[green]✓[/green] harness-mcp installed")
        else:
            print("[red]✗[/red] harness-mcp install failed")
            print(f"  {r.stderr.strip()}")
            print("  Try manually: npm install -g @harness-engineering/cli")
            issues.append("harness-mcp install failed")

    # ── API key ───────────────────────────────────────────────
    if os.environ.get("ANTHROPIC_API_KEY"):
        print("[green]✓[/green] ANTHROPIC_API_KEY set")
    else:
        print("[yellow]![/yellow] ANTHROPIC_API_KEY not set")
        print("  Get a key at console.anthropic.com, then add to "
              "~/.zshrc or ~/.bashrc:")
        print("  [dim]export ANTHROPIC_API_KEY=<paste-key-here>[/dim]")

    # ── .claude/settings.local.json ───────────────────────────
    local_settings = repo_root / ".claude" / "settings.local.json"
    if local_settings.exists():
        print("[green]✓[/green] .claude/settings.local.json already exists")
    else:
        (repo_root / ".claude").mkdir(exist_ok=True)
        local_settings.write_text(
            json.dumps({"enableAllProjectMcpServers": True}, indent=2) + "\n"
        )
        print("[green]✓[/green] Created .claude/settings.local.json")
        print("  MCP servers (harness, playwright) will connect automatically.")

    # ── Summary ───────────────────────────────────────────────
    print()
    if not issues:
        print("[bold green]Setup complete.[/bold green] "
              "Run [bold]oracle generate \"...\"[/bold] to create your first test.")
    else:
        print("[bold yellow]Setup incomplete.[/bold yellow] "
              "Fix the issues above and re-run [bold]oracle setup[/bold].")


@app.command()
def version():
    """
    Show Oracle version info.
    """
    print("[bold green]Oracle AI v0.1 (MVP)[/bold green]")


if __name__ == "__main__":
    app()
