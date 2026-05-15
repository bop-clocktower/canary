# agent/core/orchestrator.py

"""
Oracle Orchestrator - The central execution engine for the Oracle agent.

This module coordinates the entire test generation pipeline, including
classification, recommendation, generation, file management, and self-healing.
"""

from pathlib import Path
from datetime import datetime

from rich import print
from agent.core.classifier import TestClassifier
from agent.core.metadata_scanner import MetadataScanner
from agent.core.pattern_matcher import PatternMatcher
from agent.core.recommender import FrameworkRecommender
from agent.llm import generate_response


class OracleOrchestrator:
    """
    Coordinates the test generation and execution lifecycle.

    This class manages the sequence of operations required to transform a
    natural language prompt into a functional, validated test file.
    """

    def __init__(self):
        """
        Initializes the orchestrator with required sub-components.
        """
        self.classifier = TestClassifier()
        self.recommender = FrameworkRecommender()
        self.metadata_scanner = MetadataScanner()
        self.pattern_matcher = PatternMatcher()

        self.output_dir = Path(__file__).resolve().parents[2] / "tests" / "generated"
        self.output_dir.mkdir(parents=True, exist_ok=True)

    # @perf-critical
    def run(self, user_prompt: str, execute: bool = False) -> dict:
        """
        Executes the full Oracle pipeline for a given prompt.

        Args:
            user_prompt: The natural language requirement from the user.
            execute: Whether to run the test immediately after generation.

        Returns:
            A dictionary containing the pipeline results, including file paths
            and execution status.
        """
        from agent.core.executor import TestExecutor

        # 1. Scan project metadata from cwd
        metadata = self.metadata_scanner.scan()

        # 2. Classify intent
        classification = self.classifier.classify(user_prompt)

        # 3. Recommend framework
        recommendation = self.recommender.recommend(classification)

        framework = recommendation["framework"]
        if not framework:
            raise ValueError(
                f"No framework available for test_type '{classification.test_type}'. "
                f"Reason: {'; '.join(recommendation.get('reason', []))}"
            )

        # --- EXTENSION VALIDATION & SANITIZATION ---
        raw_ext = recommendation.get("file_extension", "ts")
        extension = self._sanitize_extension(raw_ext)

        # 4. Scan existing test patterns
        patterns = self.pattern_matcher.scan(
            framework=framework,
            test_type=classification.test_type,
        )

        # 5. Build generation prompt
        generation_prompt = self._build_prompt(
            user_prompt,
            classification.test_type,
            framework,
            metadata,
            patterns,
        )

        # 6. Generate test code
        generated_code = generate_response(generation_prompt)

        # 7. Write file
        file_path = self._write_test_file(generated_code, framework, extension)

        result = {
            "input": user_prompt,
            "test_type": classification.test_type,
            "framework": framework,
            "reason": recommendation["reason"],
            "output_file": str(file_path)
        }

        # 8. Execute if requested
        if execute:
            executor = TestExecutor()
            exit_code, stdout, stderr = executor.execute(file_path, framework)
            
            result["execution"] = {
                "exit_code": exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "fixed": False
            }

            # Self-healing loop (MVP: 1 attempt)
            if exit_code != 0:
                print(f"\n[yellow]⚠️ Test failed (Exit {exit_code}). Oracle attempting to self-heal...[/yellow]")
                
                fixed_code = self._attempt_fix(
                    user_prompt, 
                    framework, 
                    generated_code, 
                    stderr or stdout
                )
                
                # Overwrite file with fixed code
                with open(file_path, "w") as f:
                    f.write(fixed_code)
                
                # Re-execute
                exit_code_fixed, stdout_fixed, stderr_fixed = executor.execute(file_path, framework)
                
                result["execution"] = {
                    "exit_code": exit_code_fixed,
                    "stdout": stdout_fixed,
                    "stderr": stderr_fixed,
                    "fixed": True,
                    "original_error": stderr or stdout
                }

        return result

    def _attempt_fix(self, user_prompt: str, framework: str, original_code: str, error: str) -> str:
        """
        Requests a code fix from the LLM based on execution errors.

        Args:
            user_prompt: The original test requirement.
            framework: The framework being used.
            original_code: The failing code implementation.
            error: The error output from the failed execution.

        Returns:
            The fixed code implementation as a string.
        """
        fix_prompt = f"""
You are Oracle, a senior test automation engineer. 
A test you generated for the following requirement has FAILED.

--- REQUIREMENT ---
{user_prompt}

--- ORIGINAL CODE ---
{original_code}

--- ERROR OUTPUT ---
{error}

--- TASK ---
Fix the code so it passes. 
- Maintain all original test logic
- Address the specific error provided
- Ensure the result is a complete, runnable file
- Return ONLY the code, no explanation
"""
        return generate_response(fix_prompt)

    def _build_prompt(self, user_prompt: str, test_type: str, framework: str, metadata=None, patterns=None) -> str:
        """
        Constructs the framework-aware prompt for the LLM.

        Args:
            user_prompt: The user's requirement.
            test_type: The classified test type (e.g., e2e_ui).
            framework: The recommended framework (e.g., playwright).
            metadata: Optional ProjectMetadata from the scanner.
            patterns: Optional PatternProfile from the pattern matcher.

        Returns:
            A formatted prompt string for the LLM.
        """
        context_lines = [
            f"Test Type: {test_type}",
            f"Framework: {framework}",
        ]

        if metadata and not metadata.is_empty:
            if metadata.js_dependencies:
                deps_str = ", ".join(
                    f"{k}@{v.lstrip('>=~^')}" if v else k
                    for k, v in sorted(metadata.js_dependencies.items())
                )
                context_lines.append(f"JS dependencies: {deps_str}")
            if metadata.python_packages:
                pkgs_str = ", ".join(
                    f"{k}{v}" if v else k
                    for k, v in sorted(metadata.python_packages.items())
                )
                context_lines.append(f"Python packages: {pkgs_str}")
            if metadata.tsconfig:
                highlights = {
                    k: v for k, v in metadata.tsconfig.items()
                    if k in ("target", "module", "strict", "jsx")
                }
                if highlights:
                    context_lines.append(f"TypeScript config: {highlights}")

        if patterns and not patterns.is_empty:
            context_lines.append(f"Existing test count: {patterns.test_count}")
            if patterns.naming_style:
                context_lines.append(f"Naming style: {patterns.naming_style}")
            if patterns.assertion_style:
                context_lines.append(f"Assertion style: {patterns.assertion_style}")
            if patterns.common_imports:
                context_lines.append(f"Common imports: {', '.join(patterns.common_imports)}")
            if patterns.sample_names:
                context_lines.append(f"Example test names: {', '.join(patterns.sample_names)}")

        context = "\n".join(context_lines)

        return f"""
You are Oracle, a senior test automation engineer.

Generate high-quality {framework} tests for the following requirement:

--- REQUIREMENT ---
{user_prompt}

--- CONTEXT ---
{context}

--- RULES ---
- Follow best practices for {framework}
- Write clean, maintainable tests
- Avoid brittle selectors
- Include comments explaining key logic
- Ensure code is production-ready
- Use the exact library versions detected in the project where relevant
- Match the naming style and assertion patterns of the existing test suite
"""

    def _write_test_file(self, code: str, framework: str, extension: str) -> Path:
        """
        Writes the generated code to a uniquely named file.

        Args:
            code: The generated test code.
            framework: The framework name (used for filename).
            extension: The file extension (e.g., spec.ts).

        Returns:
            The Path object representing the created file.
        """

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")

        file_name = f"{framework}_test_{timestamp}.{extension}"

        file_path = self.output_dir / file_name

        with open(file_path, "w") as f:
            f.write(code)

        return file_path

    def _sanitize_extension(self, ext: str) -> str:
        """
        Validates and sanitizes file extensions to prevent path traversal.

        Args:
            ext: The raw extension string from the recommender.

        Returns:
            A sanitized extension string. Defaults to 'ts' if invalid.
        """
        if not ext or not isinstance(ext, str):
            return "ts"

        # Strip leading dots and spaces
        ext = ext.strip().lstrip(".")

        # Whitelist of characters: alphanumeric and single dots
        # Reject if contains path separators or ".."
        if "/" in ext or "\\" in ext or ".." in ext:
            return "ts"

        # Ensure only alphanumeric and dots are present
        import re
        if not re.match(r"^[a-zA-Z0-9.]+$", ext):
            return "ts"

        # Final whitelist check for common extensions
        allowed = {"ts", "js", "py", "txt", "md", "spec.ts", "test.ts", "spec.js", "test.js", "test.py", "load.js"}
        if ext not in allowed:
            return "ts"

        return ext
