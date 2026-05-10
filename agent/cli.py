# agent/cli.py

import json
import typer
from rich import print

app = typer.Typer()


@app.command()
def generate(
    prompt: str,
    recommend_only: bool = typer.Option(False, "--recommend-only", "-r", help="Only show the recommendation, skip generation."),
    output_json: bool = typer.Option(False, "--json", help="Output results in JSON format for tool integration."),
    run_test: bool = typer.Option(False, "--run", help="Execute the test immediately after generation.")
):
    """
    Generate test automation code from a natural language prompt.
    """
    from agent.core.orchestrator import OracleOrchestrator

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

    if output_json:
        print(json.dumps({
            "status": "success",
            "mode": "full_generation",
            "test_type": result["test_type"],
            "framework": result["framework"],
            "output_file": result["output_file"],
            "reasoning": result["reason"],
            "execution": result.get("execution")
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
def version():
    """
    Show Oracle version info.
    """
    print("[bold green]Oracle AI v0.1 (MVP)[/bold green]")


if __name__ == "__main__":
    app()
