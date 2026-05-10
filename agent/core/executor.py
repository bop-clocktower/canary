# agent/core/executor.py

import subprocess
import shlex
from pathlib import Path
from typing import Tuple, Optional
from agent.core.framework_registry import FrameworkRegistry

class TestExecutor:
    """
    Handles execution of generated tests in a subprocess.
    """

    def __init__(self):
        self.registry = FrameworkRegistry()

    def execute(self, file_path: Path, framework_name: str, timeout: int = 30) -> Tuple[int, str, str]:
        """
        Executes a test file using the specified framework.
        Returns (exit_code, stdout, stderr).
        """
        framework = self.registry.find_by_name(framework_name)
        if not framework:
            raise ValueError(f"Framework '{framework_name}' not found in registry.")

        cmd_template = framework.get("execution_command")
        if not cmd_template:
            raise ValueError(f"No execution command defined for framework '{framework_name}'.")

        # Interpolate file path
        cmd_str = cmd_template.replace("{file}", str(file_path))
        
        # Split command for subprocess while respecting quotes
        # Note: shlex.split might be tricky if cmd_template has shell-isms
        # For simplicity in MVP, we use shell=True if needed, but safer to use list
        cmd = shlex.split(cmd_str)

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
