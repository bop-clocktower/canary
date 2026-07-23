"""Unit tests for the canary-savant skill scripts (Phase 1: Tier-1 static scan).

canary-savant surfaces order-dependence and shared-state leakage. Phase 1 ships
the always-on static "suspect" tier only: an AST-lite scanner that flags the
shared-state smells that predict order-dependent tests, with no test execution.
Rules SV001-SV004. Framework-conditioned by file extension (pytest idioms in
Python, vitest/jest idioms in JS/TS), mirroring canary-blackhawk.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS = (
    Path(__file__).resolve().parents[2]
    / "agents" / "skills" / "claude-code" / "canary-savant" / "scripts"
)
_SKILL_DIR = _SCRIPTS.parent

# Clear cached modules from sibling skills' test files: every executable skill
# ships its own cli/rules/scanner modules and the bare names collide in a
# full-suite pytest run.
for _mod in ["rules", "scanner", "cli"]:
    sys.modules.pop(_mod, None)

if str(_SCRIPTS) in sys.path:
    sys.path.remove(str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS))

import rules  # noqa: E402
import scanner  # noqa: E402
import cli  # noqa: E402


def _scan(text: str, name: str = "test_a.py") -> list:
    return scanner.scan_text(text, name)


def _ids(text: str, name: str = "test_a.py") -> set:
    return {f.rule_id for f in _scan(text, name)}


# --------------------------------------------------------------------------
# SV001 - module-level mutable global mutated by a test
# --------------------------------------------------------------------------


def test_module_dict_mutated_is_flagged():
    text = "_CACHE = {}\n\ndef test_a():\n    _CACHE['k'] = 1\n"
    findings = _scan(text)
    assert "SV001-module-mutable-global" in {f.rule_id for f in findings}
    # fires on the declaration line, not the mutation site
    sv1 = next(f for f in findings if f.rule_id == "SV001-module-mutable-global")
    assert sv1.line == 1


@pytest.mark.parametrize("decl,mutate", [
    ("_ITEMS = []", "    _ITEMS.append(x)"),
    ("_SEEN = set()", "    _SEEN.add(x)"),
    ("_MAP = dict()", "    _MAP['k'] = 1"),
    ("_ACC = []", "    _ACC += [1]"),
])
def test_various_module_mutables_are_flagged(decl, mutate):
    text = f"{decl}\n\ndef test_a():\n{mutate}\n"
    assert "SV001-module-mutable-global" in _ids(text)


def test_module_mutable_never_mutated_is_not_flagged():
    # A module-level table that is only ever read is a legitimate constant.
    text = "_LOOKUP = {'a': 1}\n\ndef test_a():\n    assert _LOOKUP['a'] == 1\n"
    assert "SV001-module-mutable-global" not in _ids(text)


def test_mutable_declared_inside_a_function_is_not_module_scope():
    text = "def test_a():\n    cache = {}\n    cache['k'] = 1\n"
    assert "SV001-module-mutable-global" not in _ids(text)


def test_js_top_level_let_mutated_is_flagged():
    text = "let cache = {};\n\nit('a', () => { cache.foo = 1; });\n"
    assert "SV001-module-mutable-global" in _ids(text, "a.spec.ts")


def test_js_immutable_primitive_const_is_not_flagged():
    text = "const MAX = 5;\n\nit('a', () => { expect(MAX).toBe(5); });\n"
    assert "SV001-module-mutable-global" not in _ids(text, "a.spec.ts")


# --------------------------------------------------------------------------
# SV002 - setup without matching teardown (framework-conditioned)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("setup", ["setup_method", "setup_class", "setUp", "setUpClass"])
def test_pytest_setup_without_teardown_is_flagged(setup):
    text = f"class TestX:\n    def {setup}(self):\n        self.db = open_db()\n"
    findings = _scan(text)
    assert "SV002-missing-teardown" in {f.rule_id for f in findings}


def test_pytest_setup_with_teardown_is_not_flagged():
    text = (
        "class TestX:\n"
        "    def setup_method(self):\n        self.db = open_db()\n"
        "    def teardown_method(self):\n        self.db.close()\n"
    )
    assert "SV002-missing-teardown" not in _ids(text)


def test_vitest_beforeeach_without_aftereach_is_flagged():
    text = "beforeEach(() => { db = openDb(); });\n"
    assert "SV002-missing-teardown" in _ids(text, "a.spec.ts")


def test_vitest_beforeall_with_afterall_is_not_flagged():
    text = "beforeAll(() => { db = openDb(); });\nafterAll(() => { db.close(); });\n"
    assert "SV002-missing-teardown" not in _ids(text, "a.spec.ts")


# --------------------------------------------------------------------------
# SV003 - shared-singleton / env mutation without restore
# --------------------------------------------------------------------------


@pytest.mark.parametrize("line,name", [
    ("os.environ['API_KEY'] = 'x'", "test_a.py"),
    ("os.environ[\"API_KEY\"] = 'x'", "test_a.py"),
    ("sys.modules['foo'] = fake", "test_a.py"),
    ("process.env.API_KEY = 'x';", "a.spec.ts"),
])
def test_singleton_mutations_are_flagged(line, name):
    assert "SV003-shared-singleton-mutation" in _ids(line, name)


@pytest.mark.parametrize("line", [
    "monkeypatch.setenv('API_KEY', 'x')",
    "key = os.environ['API_KEY']",
    "assert os.environ['API_KEY'] == 'x'",
])
def test_restored_or_read_only_env_access_is_not_flagged(line):
    assert "SV003-shared-singleton-mutation" not in _ids(line, "test_a.py")


# --------------------------------------------------------------------------
# SV004 - order-coupled name or comment
# --------------------------------------------------------------------------


@pytest.mark.parametrize("line,name", [
    ("def test_1_creates_user():", "test_a.py"),
    ("def test_first():", "test_a.py"),
    ("def test_last_cleanup():", "test_a.py"),
    ("# must run before test_b", "test_a.py"),
    ("it('creates admin (must run first)', () => {", "a.spec.ts"),
])
def test_order_coupled_names_are_flagged(line, name):
    assert "SV004-order-coupled-name" in _ids(line, name)


@pytest.mark.parametrize("line", [
    "def test_creates_user():",
    "def test_number_of_items():",
    "# creates a user and asserts the role",
])
def test_ordinary_names_are_not_flagged(line):
    assert "SV004-order-coupled-name" not in _ids(line, "test_a.py")


# --------------------------------------------------------------------------
# Finding shape + line handling
# --------------------------------------------------------------------------


def test_finding_carries_file_line_severity_snippet_and_why():
    text = "_ITEMS = []\n\ndef test_a():\n    _ITEMS.append(1)\n"
    f = next(f for f in _scan(text, "tests/state.py")
             if f.rule_id == "SV001-module-mutable-global")
    assert f.file == "tests/state.py"
    assert f.line == 1
    assert f.severity in rules.SEVERITIES
    assert f.snippet == "_ITEMS = []"
    assert f.why and isinstance(f.why, str) and "\n" not in f.why


def test_finding_to_dict_has_exactly_the_documented_keys():
    f = _scan("os.environ['X'] = '1'")[0]
    assert set(f.to_dict()) == {"file", "line", "rule_id", "severity", "snippet", "why"}


def test_snippet_is_truncated_for_very_long_lines():
    f = _scan("os.environ['X'] = '1'  # " + "x" * 500)[0]
    assert len(f.snippet) <= scanner.SNIPPET_LIMIT


def test_commented_out_code_is_not_flagged():
    assert _ids("# os.environ['X'] = '1'") == set()
    assert _ids("// process.env.X = '1';", "a.spec.ts") == set()


def test_every_rule_declares_id_severity_and_why():
    assert rules.RULES
    for rule in rules.RULES:
        assert rule.rule_id.startswith("SV")
        assert rule.severity in rules.SEVERITIES
        assert rule.why


def test_rule_ids_are_unique():
    ids = [r.rule_id for r in rules.RULES]
    assert len(ids) == len(set(ids))


# --------------------------------------------------------------------------
# File / path selection
# --------------------------------------------------------------------------


def _tree(tmp_path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "src").mkdir()
    (tmp_path / "tests" / "state.spec.ts").write_text(
        "let cache = {};\n\nit('a', () => { cache.x = 1; });\n", encoding="utf-8"
    )
    (tmp_path / "tests" / "test_state.py").write_text(
        "_ITEMS = []\n\ndef test_a():\n    _ITEMS.append(1)\n", encoding="utf-8"
    )
    (tmp_path / "src" / "app.py").write_text(
        "_G = []\n\ndef go():\n    _G.append(1)\n", encoding="utf-8"
    )
    (tmp_path / "notes.txt").write_text("os.environ['X'] = '1'\n", encoding="utf-8")
    return tmp_path


def test_directory_scan_only_visits_test_files(tmp_path):
    result = scanner.scan_paths([_tree(tmp_path)])
    files = {Path(f.file).name for f in result.findings}
    assert files == {"state.spec.ts", "test_state.py"}
    assert result.files_scanned == 2


def test_explicit_non_test_file_is_scanned_anyway(tmp_path):
    _tree(tmp_path)
    result = scanner.scan_paths([tmp_path / "src" / "app.py"])
    assert result.files_scanned == 1
    assert len(result.findings) == 1


def test_unsupported_extension_is_never_scanned(tmp_path):
    _tree(tmp_path)
    result = scanner.scan_paths([tmp_path / "notes.txt"])
    assert result.files_scanned == 0 and result.findings == []


def test_undecodable_file_is_skipped_not_raised(tmp_path):
    binary = tmp_path / "weird.spec.ts"
    binary.write_bytes(b"\xff\xfe\x00let cache = {}")
    result = scanner.scan_paths([tmp_path])  # must not raise
    assert result.findings == []


def test_findings_are_ordered_by_file_then_line(tmp_path):
    p = tmp_path / "b.spec.ts"
    p.write_text("let a = {};\nit('x', () => { a.k = 1; });\n", encoding="utf-8")
    q = tmp_path / "a.spec.ts"
    q.write_text("let a = {};\nit('x', () => { a.k = 1; });\n", encoding="utf-8")
    findings = scanner.scan_paths([tmp_path]).findings
    names = [Path(f.file).name for f in findings]
    assert names == sorted(names)


def test_directory_walk_skips_dependency_dirs(tmp_path):
    vendored = tmp_path / "node_modules" / "pkg"
    vendored.mkdir(parents=True)
    (vendored / "thing.spec.ts").write_text(
        "let a = {};\nit('x', () => { a.k = 1; });\n", encoding="utf-8"
    )
    result = scanner.scan_paths([tmp_path])
    assert result.files_scanned == 0 and result.findings == []


def test_overlapping_paths_are_scanned_once(tmp_path):
    p = tmp_path / "test_state.py"
    p.write_text("_G = []\n\ndef test_a():\n    _G.append(1)\n", encoding="utf-8")
    result = scanner.scan_paths([tmp_path, p])
    assert result.files_scanned == 1
    assert len(result.findings) == 1


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def test_cli_json_shape(tmp_path, capsys):
    _tree(tmp_path)
    rc = cli.main([str(tmp_path), "--json"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["schema_version"] == 1
    assert payload["summary"]["files_scanned"] == 2
    assert payload["summary"]["findings"] >= 2
    row = payload["findings"][0]
    assert set(row) == {"file", "line", "rule_id", "severity", "snippet", "why"}


def test_cli_json_is_valid_when_there_are_no_findings(tmp_path, capsys):
    rc = cli.main([str(tmp_path), "--json"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["findings"] == []
    assert payload["summary"] == {"files_scanned": 0, "findings": 0, "by_severity": {}}


def test_cli_human_output_lists_findings(tmp_path, capsys):
    _tree(tmp_path)
    assert cli.main([str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "SV001-module-mutable-global" in out


def test_cli_human_output_when_clean(tmp_path, capsys):
    assert cli.main([str(tmp_path)]) == 0
    assert "No order-dependence" in capsys.readouterr().out


def test_cli_is_advisory_by_default(tmp_path, capsys):
    _tree(tmp_path)
    assert cli.main([str(tmp_path)]) == 0  # findings, still exit 0


def test_cli_strict_fails_on_findings(tmp_path, capsys):
    _tree(tmp_path)
    assert cli.main([str(tmp_path), "--strict"]) == 1


def test_cli_strict_passes_when_clean(tmp_path, capsys):
    assert cli.main([str(tmp_path), "--strict"]) == 0


def test_cli_missing_path_returns_1(tmp_path, capsys):
    assert cli.main([str(tmp_path / "nope")]) == 1
    assert "not found" in capsys.readouterr().err


def test_cli_defaults_to_cwd_when_no_path_given(tmp_path, monkeypatch, capsys):
    _tree(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert cli.main([]) == 0
    assert "SV001-module-mutable-global" in capsys.readouterr().out


# --------------------------------------------------------------------------
# Skill packaging
# --------------------------------------------------------------------------


def test_skill_md_declares_the_executable_contract():
    text = (_SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    head = text.split("---")[1]
    assert "name: canary-savant" in head
    assert "cli: scripts/cli.py" in head
    assert "requires: [python3>=3.10]" in head


def test_scripts_are_ascii_only_no_emoji():
    for path in _SCRIPTS.rglob("*.py"):
        path.read_text(encoding="utf-8").encode("ascii")


def test_skill_is_self_contained_no_agent_imports():
    for path in _SCRIPTS.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "from agent." not in text and "import agent" not in text


def test_skill_dir_has_no_client_strings():
    banned = ("capi" "llary", "cap" "well")
    for path in _SKILL_DIR.rglob("*"):
        if path.is_file() and path.suffix in (".py", ".md"):
            text = path.read_text(encoding="utf-8").lower()
            for bad in banned:
                assert bad not in text, f"client string {bad!r} in {path}"


from agent.core.skill_registry import SkillRegistry  # noqa: E402


def test_skill_is_discoverable_and_runnable():
    skills = {s.name: s for s in SkillRegistry().discover()}
    assert "canary-savant" in skills
    assert skills["canary-savant"].is_executable
    assert "python3" in " ".join(skills["canary-savant"].requires)
