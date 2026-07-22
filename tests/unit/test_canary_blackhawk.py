"""Unit tests for the canary-blackhawk skill scripts.

canary-blackhawk is a temporal-dependency linter for test files: it statically
flags tests that lean on the wall clock, a real delay, or the local timezone —
the ones that pass all day and fail at midnight, across a DST boundary, or on
Feb 29.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS = (
    Path(__file__).resolve().parents[2]
    / "agents" / "skills" / "claude-code" / "canary-blackhawk" / "scripts"
)
_SKILL_DIR = _SCRIPTS.parent

# Clear cached modules from other skills' test files to avoid namespace
# collision in a full-suite pytest run (every executable skill ships its own
# `cli` module, and generic names like `rules`/`scanner` collide just as easily).
for _mod in ["rules", "scanner", "cli"]:
    sys.modules.pop(_mod, None)

if str(_SCRIPTS) in sys.path:
    sys.path.remove(str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS))

import rules  # noqa: E402
import scanner  # noqa: E402
import cli  # noqa: E402


def _scan(text: str, name: str = "a.spec.ts") -> list:
    return scanner.scan_text(text, name)


def _ids(text: str, name: str = "a.spec.ts") -> set:
    return {f.rule_id for f in _scan(text, name)}


# --------------------------------------------------------------------------
# BH001 — wall clock
# --------------------------------------------------------------------------


@pytest.mark.parametrize("line,name", [
    ("const t = Date.now();", "a.spec.ts"),
    ("const d = new Date();", "a.spec.ts"),
    ("const m = moment();", "a.spec.ts"),
    ("now = datetime.now()", "test_a.py"),
    ("now = datetime.today()", "test_a.py"),
    ("now = datetime.utcnow()", "test_a.py"),
    ("now = datetime.datetime.now()", "test_a.py"),
    ("today = date.today()", "test_a.py"),
    ("start = time.time()", "test_a.py"),
    ("ts = pd.Timestamp.now()", "test_a.py"),
])
def test_wall_clock_sources_are_flagged(line, name):
    assert "BH001-wall-clock" in _ids(line, name)


@pytest.mark.parametrize("line,name", [
    ("const d = new Date('2024-01-01T00:00:00Z');", "a.spec.ts"),
    ("const d = new Date(1704067200000);", "a.spec.ts"),
    ("const m = moment('2024-01-01');", "a.spec.ts"),
    ("d = datetime(2024, 1, 1)", "test_a.py"),
])
def test_pinned_time_constructors_are_not_flagged(line, name):
    assert "BH001-wall-clock" not in _ids(line, name)


# --------------------------------------------------------------------------
# BH002 — real delay
# --------------------------------------------------------------------------


@pytest.mark.parametrize("line,name", [
    ("time.sleep(2)", "test_a.py"),
    ("time.sleep(0.5)", "test_a.py"),
    ("await new Promise((r) => setTimeout(r, 500));", "a.spec.ts"),
    ("setTimeout(done, 1000);", "a.spec.ts"),
])
def test_real_delays_are_flagged(line, name):
    assert "BH002-real-delay" in _ids(line, name)


@pytest.mark.parametrize("line,name", [
    ("time.sleep(0)", "test_a.py"),
    ("setTimeout(done, 0);", "a.spec.ts"),
    ("setTimeout(done, delayMs);", "a.spec.ts"),
])
def test_zero_or_symbolic_delays_are_not_flagged(line, name):
    assert "BH002-real-delay" not in _ids(line, name)


def test_underscore_separated_delay_is_flagged():
    # Python numeric separators (`1_000`) are legal syntax; the positivity guard
    # strips underscores before parsing, so a very long real sleep still fires.
    assert "BH002-real-delay" in _ids("time.sleep(1_000)", "test_a.py")


# --------------------------------------------------------------------------
# BH003 — local timezone
# --------------------------------------------------------------------------


@pytest.mark.parametrize("line,name", [
    ("expect(d.toLocaleString()).toBe('1/1/2024');", "a.spec.ts"),
    ("expect(d.toLocaleDateString()).toBe('1/1/2024');", "a.spec.ts"),
    ("expect(d.toLocaleTimeString()).toBe('12:00:00 AM');", "a.spec.ts"),
    ("assert d.strftime('%Y %Z') == 'UTC'", "test_a.py"),
    ("assert d.strftime('%z') == '+0000'", "test_a.py"),
])
def test_local_timezone_hazards_are_flagged(line, name):
    assert "BH003-local-timezone" in _ids(line, name)


def test_utc_formatting_is_not_flagged():
    assert _ids("expect(d.toISOString()).toBe('2024-01-01T00:00:00.000Z');") == set()


def test_strftime_without_tz_directive_is_not_flagged():
    assert "BH003-local-timezone" not in _ids(
        "assert d.strftime('%Y-%m-%d') == '2024-01-01'", "test_a.py"
    )


# --------------------------------------------------------------------------
# BH004 — naive datetime comparison
# --------------------------------------------------------------------------


@pytest.mark.parametrize("line", [
    "assert result == datetime(2024, 1, 1)",
    "assert result < datetime.datetime(2024, 3, 10, 2, 30)",
    "assert parsed == datetime.strptime('2024-01-01', '%Y-%m-%d')",
])
def test_naive_datetime_comparisons_are_flagged(line):
    assert "BH004-naive-datetime-compare" in _ids(line, "test_a.py")


@pytest.mark.parametrize("line", [
    "assert result == datetime(2024, 1, 1, tzinfo=timezone.utc)",
    "assert result == datetime(2024, 1, 1, tzinfo=pytz.UTC)",
])
def test_tz_aware_datetime_comparisons_are_not_flagged(line):
    assert "BH004-naive-datetime-compare" not in _ids(line, "test_a.py")


def test_naive_rule_does_not_double_fire_on_a_wall_clock_line():
    # `datetime.now()` is BH001's business; BH004 must not pile on.
    assert _ids("assert result == datetime.now()", "test_a.py") == {"BH001-wall-clock"}


def test_datetime_construction_without_comparison_is_not_flagged():
    assert _ids("d = datetime(2024, 1, 1)", "test_a.py") == set()


# --------------------------------------------------------------------------
# Framework-conditioned suppression (the accepted-risk core of the skill)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("marker,name", [
    ("vi.useFakeTimers();", "a.spec.ts"),
    ("jest.useFakeTimers();", "a.spec.ts"),
    ("jest.setSystemTime(new Date('2024-01-01'));", "a.spec.ts"),
    ("sinon.useFakeTimers();", "a.spec.ts"),
    ("MockDate.set('2024-01-01');", "a.spec.ts"),
    ("@freeze_time('2024-01-01')", "test_a.py"),
    ("from freezegun import freeze_time", "test_a.py"),
    ("import time_machine", "test_a.py"),
])
def test_frozen_clock_idioms_suppress_wall_clock_findings(marker, name):
    usage = "const t = Date.now();" if name.endswith(".ts") else "now = datetime.now()"
    assert "BH001-wall-clock" in _ids(usage, name)  # control: fires without the marker
    assert _ids(marker + "\n" + usage, name) == set()


def test_frozen_clock_suppresses_real_delays_too():
    text = "vi.useFakeTimers();\nawait new Promise((r) => setTimeout(r, 500));"
    assert _ids(text) == set()


def test_frozen_clock_does_not_suppress_timezone_findings():
    # Freezing the clock pins *when*, never *where* — TZ hazards survive.
    text = "vi.useFakeTimers();\nexpect(d.toLocaleString()).toBe('1/1/2024');"
    assert _ids(text) == {"BH003-local-timezone"}


def test_suppression_is_file_wide_even_when_the_marker_trails_the_usage():
    text = "const t = Date.now();\nbeforeEach(() => { vi.useFakeTimers(); });"
    assert _ids(text) == set()


def test_is_frozen_clock_file_reports_the_matched_markers():
    assert scanner.frozen_clock_markers("vi.useFakeTimers();") == ["vi.useFakeTimers"]
    assert scanner.frozen_clock_markers("const t = Date.now();") == []


# --------------------------------------------------------------------------
# Finding shape + line handling
# --------------------------------------------------------------------------


def test_finding_carries_file_line_severity_snippet_and_why():
    findings = _scan("const a = 1;\nconst t = Date.now();\n", "tests/clock.spec.ts")
    assert len(findings) == 1
    f = findings[0]
    assert f.file == "tests/clock.spec.ts"
    assert f.line == 2
    assert f.rule_id == "BH001-wall-clock"
    assert f.severity == "high"
    assert f.snippet == "const t = Date.now();"
    assert f.why and isinstance(f.why, str) and "\n" not in f.why


def test_finding_to_dict_has_exactly_the_documented_keys():
    f = _scan("const t = Date.now();")[0]
    assert set(f.to_dict()) == {"file", "line", "rule_id", "severity", "snippet", "why"}


def test_snippet_is_truncated_for_very_long_lines():
    f = _scan("const t = Date.now(); // " + "x" * 500)[0]
    assert len(f.snippet) <= scanner.SNIPPET_LIMIT


@pytest.mark.parametrize("line,name", [
    ("// const t = Date.now();", "a.spec.ts"),
    ("  * const t = Date.now();", "a.spec.ts"),
    ("# now = datetime.now()", "test_a.py"),
])
def test_commented_out_code_is_not_flagged(line, name):
    assert _ids(line, name) == set()


def test_every_rule_declares_id_severity_and_why():
    assert rules.RULES
    for rule in rules.RULES:
        assert rule.rule_id.startswith("BH")
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
    (tmp_path / "tests" / "clock.spec.ts").write_text(
        "const t = Date.now();\n", encoding="utf-8"
    )
    (tmp_path / "tests" / "test_clock.py").write_text(
        "now = datetime.now()\n", encoding="utf-8"
    )
    (tmp_path / "src" / "app.ts").write_text("const t = Date.now();\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("Date.now()\n", encoding="utf-8")
    return tmp_path


def test_directory_scan_only_visits_test_files(tmp_path):
    result = scanner.scan_paths([_tree(tmp_path)])
    files = {Path(f.file).name for f in result.findings}
    assert files == {"clock.spec.ts", "test_clock.py"}
    assert result.files_scanned == 2


def test_explicit_non_test_file_is_scanned_anyway(tmp_path):
    _tree(tmp_path)
    result = scanner.scan_paths([tmp_path / "src" / "app.ts"])
    assert result.files_scanned == 1
    assert len(result.findings) == 1


def test_unsupported_extension_is_never_scanned(tmp_path):
    _tree(tmp_path)
    result = scanner.scan_paths([tmp_path / "notes.txt"])
    assert result.files_scanned == 0 and result.findings == []


def test_empty_directory_yields_no_findings(tmp_path):
    result = scanner.scan_paths([tmp_path])
    assert result.files_scanned == 0 and result.findings == []


def test_undecodable_file_is_skipped_not_raised(tmp_path):
    binary = tmp_path / "weird.spec.ts"
    binary.write_bytes(b"\xff\xfe\x00Date.now()")
    result = scanner.scan_paths([tmp_path])  # must not raise
    assert result.findings == []


def test_findings_are_ordered_by_file_then_line(tmp_path):
    p = tmp_path / "b.spec.ts"
    p.write_text("const t = Date.now();\ntime.sleep(1)\n", encoding="utf-8")
    q = tmp_path / "a.spec.ts"
    q.write_text("const t = Date.now();\n", encoding="utf-8")
    findings = scanner.scan_paths([tmp_path]).findings
    assert [(Path(f.file).name, f.line) for f in findings] == [
        ("a.spec.ts", 1), ("b.spec.ts", 1), ("b.spec.ts", 2),
    ]


def test_directory_walk_skips_dependency_dirs(tmp_path):
    # A test-named file buried in node_modules is a vendored artifact, not our
    # code: the walk must never descend into _SKIP_DIRS, so it is neither
    # scanned nor flagged.
    vendored = tmp_path / "node_modules" / "pkg"
    vendored.mkdir(parents=True)
    (vendored / "thing.spec.ts").write_text("const t = Date.now();\n", encoding="utf-8")
    result = scanner.scan_paths([tmp_path])
    assert result.files_scanned == 0
    assert result.findings == []


def test_overlapping_paths_are_scanned_once(tmp_path):
    # A directory and a file inside it name the same target; de-duplication by
    # resolved path means the file is counted and scanned exactly once.
    p = tmp_path / "clock.spec.ts"
    p.write_text("const t = Date.now();\n", encoding="utf-8")
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
    assert payload["summary"]["findings"] == 2
    assert payload["summary"]["by_severity"]["high"] == 2
    row = payload["findings"][0]
    assert set(row) == {"file", "line", "rule_id", "severity", "snippet", "why"}


def test_cli_json_is_valid_when_there_are_no_findings(tmp_path, capsys):
    rc = cli.main([str(tmp_path), "--json"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["findings"] == []
    assert payload["summary"] == {"files_scanned": 0, "findings": 0, "by_severity": {}}


def test_cli_human_output_lists_each_finding(tmp_path, capsys):
    _tree(tmp_path)
    assert cli.main([str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "BH001-wall-clock" in out
    assert "clock.spec.ts:1" in out
    assert "2 temporal-dependency findings" in out


def test_cli_human_output_when_clean(tmp_path, capsys):
    assert cli.main([str(tmp_path)]) == 0
    assert "No temporal-dependency findings" in capsys.readouterr().out


def test_cli_is_advisory_by_default(tmp_path, capsys):
    _tree(tmp_path)
    assert cli.main([str(tmp_path)]) == 0  # findings, still exit 0


def test_cli_strict_fails_on_findings(tmp_path, capsys):
    _tree(tmp_path)
    assert cli.main([str(tmp_path), "--strict"]) == 1


def test_cli_strict_passes_when_clean(tmp_path, capsys):
    assert cli.main([str(tmp_path), "--strict"]) == 0


def test_cli_strict_and_json_still_emits_parseable_json(tmp_path, capsys):
    _tree(tmp_path)
    assert cli.main([str(tmp_path), "--strict", "--json"]) == 1
    assert json.loads(capsys.readouterr().out)["summary"]["findings"] == 2


def test_cli_missing_path_returns_1(tmp_path, capsys):
    assert cli.main([str(tmp_path / "nope")]) == 1
    assert "not found" in capsys.readouterr().err


def test_cli_defaults_to_cwd_when_no_path_given(tmp_path, monkeypatch, capsys):
    _tree(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert cli.main([]) == 0
    assert "2 temporal-dependency findings" in capsys.readouterr().out


def test_cli_accepts_multiple_paths(tmp_path, capsys):
    _tree(tmp_path)
    rc = cli.main([
        str(tmp_path / "tests" / "clock.spec.ts"),
        str(tmp_path / "src" / "app.ts"),
        "--json",
    ])
    assert rc == 0
    assert json.loads(capsys.readouterr().out)["summary"]["files_scanned"] == 2


# --------------------------------------------------------------------------
# Skill packaging
# --------------------------------------------------------------------------


def test_skill_md_declares_the_executable_contract():
    text = (_SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    head = text.split("---")[1]
    assert "name: canary-blackhawk" in head
    assert "cli: scripts/cli.py" in head
    assert "requires: [python3>=3.10]" in head


def test_scripts_are_ascii_only_no_emoji():
    for path in _SCRIPTS.rglob("*.py"):
        path.read_text(encoding="utf-8").encode("ascii")  # raises if emoji slipped in


def test_skill_is_self_contained_no_agent_imports():
    for path in _SCRIPTS.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "from agent." not in text and "import agent" not in text


def test_skill_dir_has_no_client_strings():
    # Split string literals so this public file does not itself contain the
    # proprietary tokens it guards against.
    banned = ("capi" "llary", "cap" "well")
    for path in _SKILL_DIR.rglob("*"):
        if path.is_file() and path.suffix in (".py", ".md"):
            text = path.read_text(encoding="utf-8").lower()
            for bad in banned:
                assert bad not in text, f"client string {bad!r} in {path}"


from agent.core.skill_registry import SkillRegistry  # noqa: E402


def test_skill_is_discoverable_and_runnable():
    skills = {s.name: s for s in SkillRegistry().discover()}
    assert "canary-blackhawk" in skills
    assert skills["canary-blackhawk"].is_executable
    assert "python3" in " ".join(skills["canary-blackhawk"].requires)
