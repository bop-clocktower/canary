# agent/core/reporter.py

"""Standardized reporting for Oracle execution results.

Exports generation and execution results to JSON or SARIF format for
consumption by Datadog, SonarQube, GitHub Code Scanning, and similar
dashboards.

SARIF 2.1.0 spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/
"""

import json
from pathlib import Path
from typing import Optional

_SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json"
_TOOL_NAME = "Oracle"
_TOOL_VERSION = "0.1.0"
_TOOL_URI = "https://github.com/bri-stevenski/oracle-test-ai-agent"

_RULES = (
    {
        "id": "oracle/test-generation",
        "name": "TestGeneration",
        "shortDescription": {"text": "AI-generated test file"},
        "helpUri": _TOOL_URI,
    },
    {
        "id": "oracle/test-execution",
        "name": "TestExecution",
        "shortDescription": {"text": "Automated test execution result"},
        "helpUri": _TOOL_URI,
    },
)

SUPPORTED_FORMATS = ("json", "sarif")


class Reporter:
    """Converts Oracle pipeline results into standardized report formats."""

    def write(self, result: dict, fmt: str, output_path: Optional[str] = None) -> Path:
        """Serialize result to fmt ('json' or 'sarif') and write to disk; raises ValueError for unsupported formats."""
        if fmt not in SUPPORTED_FORMATS:
            raise ValueError(
                f"Unsupported report format '{fmt}'. "
                f"Choose from: {', '.join(SUPPORTED_FORMATS)}"
            )

        if output_path:
            path = Path(output_path)
        else:
            path = Path(f"oracle-report.{fmt}")

        if fmt == "json":
            content = self.to_json(result)
        else:
            content = self.to_sarif(result)

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def to_json(self, result: dict) -> str:
        """Serialize result as pretty-printed JSON."""
        return json.dumps(result, indent=2, default=str)

    def to_sarif(self, result: dict) -> str:
        """Serialize result as SARIF 2.1.0 JSON."""
        sarif = {
            "version": "2.1.0",
            "$schema": _SARIF_SCHEMA,
            "runs": [self._build_run(result)],
        }
        return json.dumps(sarif, indent=2, default=str)

    # ------------------------------------------------------------------
    # SARIF construction
    # ------------------------------------------------------------------

    def _build_run(self, result: dict) -> dict:
        return {
            "tool": {
                "driver": {
                    "name": _TOOL_NAME,
                    "version": _TOOL_VERSION,
                    "informationUri": _TOOL_URI,
                    "rules": _RULES,
                }
            },
            "results": self._build_results(result),
        }

    def _build_results(self, result: dict) -> list:
        sarif_results = []

        output_file = result.get("output_file", "")
        test_type = result.get("test_type", "unknown")
        framework = result.get("framework", "unknown")

        # Generation result — always present
        sarif_results.append({
            "ruleId": "oracle/test-generation",
            "message": {
                "text": (
                    f"Generated {framework} test ({test_type})"
                    + (f" — {output_file}" if output_file else "")
                )
            },
            "level": "none",
            "locations": [_location(output_file)] if output_file else [],
            "properties": {
                "framework": framework,
                "test_type": test_type,
                "reasoning": result.get("reason", []),
            },
        })

        # Execution result — only if the test was run
        execution = result.get("execution")
        if execution:
            exit_code = execution.get("exit_code", -1)
            passed = exit_code == 0
            fixed = execution.get("fixed", False)

            message_parts = [
                f"Test execution {'passed' if passed else 'failed'} "
                f"(exit code {exit_code})"
            ]
            if fixed:
                message_parts.append("Self-healed after initial failure.")
            if not passed:
                stderr = execution.get("stderr") or execution.get("stdout", "")
                if stderr:
                    # Truncate long error output for readability in dashboards
                    preview = stderr[:300] + ("…" if len(stderr) > 300 else "")
                    message_parts.append(f"Error: {preview}")

            sarif_results.append({
                "ruleId": "oracle/test-execution",
                "message": {"text": " ".join(message_parts)},
                "level": "none" if passed else "error",
                "locations": [_location(output_file)] if output_file else [],
                "properties": {
                    "exit_code": exit_code,
                    "fixed": fixed,
                },
            })

        return sarif_results


def _location(uri: str) -> dict:
    return {
        "physicalLocation": {
            "artifactLocation": {"uri": uri, "uriBaseId": "%SRCROOT%"}
        }
    }
