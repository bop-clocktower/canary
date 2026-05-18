# agent/core/orchestrator.py

"""
Oracle Orchestrator - The central execution engine for the Oracle agent.

This module coordinates the entire test generation pipeline, including
classification, recommendation, generation, file management, and self-healing.
"""

import re
from pathlib import Path
from datetime import datetime

from rich import print
from rich.console import Console
from agent.core.classifier import TestClassifier
from agent.core.domain_scanner import DomainScanner
from agent.core.metadata_scanner import MetadataScanner
from agent.core.pattern_matcher import PatternMatcher
from agent.core.recommender import FrameworkRecommender
from agent.core.selector_healer import SelectorHealer
from agent.llm import generate_response


_err = Console(stderr=True)

_MAX_HEAL_ATTEMPTS = 3
_CONTEXT_SEARCH_FILES = 20
_CONTEXT_SNIPPETS = 5
_IGNORED_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    "dist", "build", "tests", "test", "__tests__",
}


class OracleOrchestrator:
    """
    Coordinates the test generation and execution lifecycle.

    This class manages the sequence of operations required to transform a
    natural language prompt into a functional, validated test file.
    """

    def __init__(self, max_heal_attempts: int = _MAX_HEAL_ATTEMPTS):
        self.classifier = TestClassifier()
        self.recommender = FrameworkRecommender()
        self.metadata_scanner = MetadataScanner()
        self.pattern_matcher = PatternMatcher()
        self.domain_scanner = DomainScanner()
        self.selector_healer = SelectorHealer()
        self.max_heal_attempts = max_heal_attempts

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
        from agent.core.executor import OracleTestExecutor

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

        # 5. Scan project domain knowledge
        domain = self.domain_scanner.scan()

        # 6. Build generation prompt
        generation_prompt = self._build_prompt(
            user_prompt,
            classification.test_type,
            framework,
            metadata,
            patterns,
            domain,
        )

        # 7. Generate test code
        generated_code = generate_response(generation_prompt)

        # 8. Write file
        file_path = self._write_test_file(generated_code, framework, extension)

        result = {
            "input": user_prompt,
            "test_type": classification.test_type,
            "framework": framework,
            "reasoning": recommendation["reason"],
            "output_file": str(file_path)
        }

        # 9. Execute if requested
        if execute:
            executor = OracleTestExecutor()
            exit_code, stdout, stderr = executor.execute(file_path, framework)

            original_error = stderr or stdout
            current_code = generated_code
            attempts = 0

            while exit_code != 0 and attempts < self.max_heal_attempts:
                attempts += 1
                error_output = stderr or stdout
                _err.print(
                    f"\n[yellow]⚠️  Test failed (exit {exit_code}). "
                    f"Self-heal attempt {attempts}/{self.max_heal_attempts}...[/yellow]"
                )
                if self.selector_healer.is_selector_failure(error_output):
                    fixed_code = self._attempt_selector_fix(
                        user_prompt, framework, current_code, error_output, file_path
                    )
                else:
                    error_context = self._search_error_context(error_output)
                    fixed_code = self._attempt_fix(
                        user_prompt, framework, current_code, error_output, error_context
                    )
                with open(file_path, "w") as f:
                    f.write(fixed_code)
                exit_code, stdout, stderr = executor.execute(file_path, framework)
                current_code = fixed_code

            result["execution"] = {
                "exit_code": exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "fixed": exit_code == 0 and attempts > 0,
                "attempts": attempts,
                "original_error": original_error,
            }

        return result

    def _attempt_fix(
        self,
        user_prompt: str,
        framework: str,
        original_code: str,
        error: str,
        context: str = "",
    ) -> str:
        """Request a code fix from the LLM, optionally enriched with local project context."""
        context_section = f"\n--- LOCAL PROJECT CONTEXT ---\n{context}\n" if context else ""
        fix_prompt = f"""You are Oracle, a senior test automation engineer.
A test you generated for the following requirement has FAILED.

--- REQUIREMENT ---
{user_prompt}

--- ORIGINAL CODE ---
{original_code}

--- ERROR OUTPUT ---
{error}
{context_section}
--- TASK ---
Fix the code so it passes.
- Maintain all original test logic
- Address the specific error provided
- Ensure the result is a complete, runnable file
- Return ONLY the code, no explanation
"""
        return generate_response(fix_prompt)

    def _attempt_selector_fix(
        self,
        user_prompt: str,
        framework: str,
        original_code: str,
        error: str,
        test_file: Path,
    ) -> str:
        """Fix selector-related failures using DOM context when available."""
        failing_selector = self.selector_healer.extract_failing_selector(error)
        report_dir = test_file.parent / "playwright-report"
        dom_context = self.selector_healer.dom_context_from_report(report_dir)
        prompt = self.selector_healer.build_heal_prompt(
            user_prompt=user_prompt,
            framework=framework,
            original_code=original_code,
            error=error,
            failing_selector=failing_selector,
            dom_context=dom_context,
        )
        return generate_response(prompt)

    def _search_error_context(self, error: str, project_root: str = ".") -> str:
        """Search project source files for symbol definitions referenced in the error message."""
        root = Path(project_root).resolve()
        candidates: set = set()

        # Quoted identifiers: 'Foo', "bar.baz"
        for m in re.finditer(r"""['"]([A-Za-z_]\w*(?:\.\w+)*)['"]""", error):
            candidates.add(m.group(1).split(".")[0])

        # "name 'foo' is not defined", "module 'x'", "attribute 'y'"
        for m in re.finditer(
            r"\b(?:name|module|attribute|class|function)\s+['\"]?(\w+)", error, re.IGNORECASE
        ):
            candidates.add(m.group(1))

        # File references: something.py:42
        for m in re.finditer(r"(\w+)\.(?:py|ts|js):\d+", error):
            candidates.add(m.group(1))

        if not candidates:
            return ""

        snippets: list = []
        seen_entries: set = set()
        source_globs = ["**/*.py", "**/*.ts", "**/*.tsx", "**/*.js"]
        files_scanned = 0

        for glob_pattern in source_globs:
            for path in sorted(root.glob(glob_pattern)):
                if any(part in _IGNORED_DIRS for part in path.parts):
                    continue
                files_scanned += 1
                if files_scanned > _CONTEXT_SEARCH_FILES:
                    break
                try:
                    text = path.read_text(encoding="utf-8", errors="ignore")
                except OSError:
                    continue
                lines = text.splitlines()
                for candidate in candidates:
                    for i, line in enumerate(lines):
                        if candidate in line and any(
                            kw in line
                            for kw in ("def ", "class ", "export ", "function ", "const ", "import ")
                        ):
                            start = max(0, i - 1)
                            end = min(len(lines), i + 8)
                            entry = f"# {path.name}:{i + 1}\n" + "\n".join(lines[start:end])
                            if entry not in seen_entries:
                                seen_entries.add(entry)
                                snippets.append(entry)
                            break
                if len(snippets) >= _CONTEXT_SNIPPETS or files_scanned > _CONTEXT_SEARCH_FILES:
                    break
            if len(snippets) >= _CONTEXT_SNIPPETS or files_scanned > _CONTEXT_SEARCH_FILES:
                break

        if not snippets:
            return ""
        return "\n\n".join(snippets[:_CONTEXT_SNIPPETS])

    def _build_prompt(self, user_prompt: str, test_type: str, framework: str, metadata=None, patterns=None, domain=None) -> str:
        """
        Constructs the framework-aware prompt for the LLM.

        Args:
            user_prompt: The user's requirement.
            test_type: The classified test type (e.g., e2e_ui).
            framework: The recommended framework (e.g., playwright).
            metadata: Optional ProjectMetadata from the scanner.
            patterns: Optional PatternProfile from the pattern matcher.
            domain: Optional DomainContext from the domain scanner.

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

        if domain and not domain.is_empty:
            if domain.components:
                context_lines.append(f"Available components/classes: {', '.join(domain.components)}")
            if domain.functions:
                context_lines.append(f"Public functions: {', '.join(domain.functions)}")
            if domain.api_routes:
                context_lines.append(f"API routes: {', '.join(domain.api_routes)}")
            if domain.modules:
                context_lines.append(f"Modules: {', '.join(domain.modules[:8])}")

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
