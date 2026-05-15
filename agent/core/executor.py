# agent/core/executor.py

"""
Oracle Test Executor - A framework-agnostic execution engine.

This module provides the capability to execute generated test files
using the appropriate CLI commands for each supported framework.
"""

import subprocess
import shlex
from pathlib import Path
from typing import Tuple
from agent.core.framework_registry import FrameworkRegistry
from agent.core.ci_env import is_ci

class TestExecutor:
    """
    Handles execution of generated tests in a managed subprocess.

    This class coordinates with the FrameworkRegistry to determine the
    correct execution command for a given framework and safely executes
    the test file.
    """

    def __init__(self):
        """
        Initializes the executor with the framework registry.
        """
        self.registry = FrameworkRegistry()

    def execute(self, file_path: Path, framework_name: str, timeout: int = 30) -> Tuple[int, str, str]:
        """
        Executes a test file using the specified framework.

        Args:
            file_path: Absolute path to the test file.
            framework_name: Name of the framework (e.g., 'playwright').
            timeout: Maximum execution time in seconds. Defaults to 30.

        Returns:
            A tuple of (exit_code, stdout, stderr).
        """
        framework = self.registry.find_by_name(framework_name)
        if not framework:
            raise ValueError(f"Framework '{framework_name}' not found in registry.")

        cmd_template = framework.get("execution_command")
        if not cmd_template:
            raise ValueError(f"No execution command defined for framework '{framework_name}'.")

        # Split the template first so the file path stays a single argv
        # element even when it contains spaces or shell metacharacters.
        cmd = [
            tok.replace("{file}", str(file_path))
            for tok in shlex.split(cmd_template)
        ]

        if is_ci():
            cmd.extend(list(framework.get("ci_flags") or []))

        try:
            process = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout
            )
            return process.returncode, process.stdout, process.stderr
        except subprocess.TimeoutExpired as e:
            return 124, e.stdout or "", f"Execution timed out after {timeout} seconds."
        except Exception as e:
            return 1, "", str(e)
