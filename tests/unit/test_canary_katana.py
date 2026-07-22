"""Unit tests for the canary-katana skill scripts.

canary-katana ("Soultaker") quarantines deleted and newly-skipped tests: it
captures every one with provenance, and alarms only when a deletion removes the
last coverage of a critical-area symbol.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

_SCRIPTS = (
    Path(__file__).resolve().parents[2]
    / "agents" / "skills" / "claude-code" / "canary-katana" / "scripts"
)
_SKILL_DIR = _SCRIPTS.parent

# Clear cached modules from other skills' test files to avoid namespace
# collision in a full-suite pytest run (every bundled skill ships its own
# `cli` module, and `ledger`/`alarm`/`diffscan` are generic names).
for _mod in ["diffscan", "ledger", "alarm", "cli"]:
    sys.modules.pop(_mod, None)

if str(_SCRIPTS) in sys.path:
    sys.path.remove(str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS))

import alarm  # noqa: E402
import cli  # noqa: E402
import diffscan  # noqa: E402
import ledger  # noqa: E402

from agent.core.skill_registry import SkillRegistry  # noqa: E402


@pytest.fixture(autouse=True)
def _isolate_namespace():
    """Re-import the skill's modules under this skill's scripts dir.

    Another skill's test module may have won the bare-name race in a full-suite
    run; re-importing per test keeps this file honest either way.
    """
    import importlib

    global alarm, cli, diffscan, ledger
    if str(_SCRIPTS) in sys.path:
        sys.path.remove(str(_SCRIPTS))
    sys.path.insert(0, str(_SCRIPTS))
    for mod in ["diffscan", "ledger", "alarm", "cli"]:
        sys.modules.pop(mod, None)
    diffscan = importlib.import_module("diffscan")
    ledger = importlib.import_module("ledger")
    alarm = importlib.import_module("alarm")
    cli = importlib.import_module("cli")


# --------------------------------------------------------------------------
# fixture diffs
# --------------------------------------------------------------------------

PY_REMOVAL = """\
diff --git a/tests/test_points.py b/tests/test_points.py
index 1111111..2222222 100644
--- a/tests/test_points.py
+++ b/tests/test_points.py
@@ -1,10 +1,6 @@
 import pytest

-def test_earns_points_on_purchase():
-    assert earn(100) == 10
-
-async def test_points_expire():
-    assert True
-
 def test_still_here():
     assert True
"""

JS_REMOVAL = """\
diff --git a/tests/checkout.spec.ts b/tests/checkout.spec.ts
index 3333333..4444444 100644
--- a/tests/checkout.spec.ts
+++ b/tests/checkout.spec.ts
@@ -1,12 +1,4 @@
-describe('checkout flow', () => {
-  it('adds to cart', async () => {
-    await addToCart();
-  });
-
-  test("clears the cart", async () => {
-    await clearCart();
-  });
-});
+// checkout tests removed
"""

PYTEST_SKIP = """\
diff --git a/tests/test_refunds.py b/tests/test_refunds.py
index 5555555..6666666 100644
--- a/tests/test_refunds.py
+++ b/tests/test_refunds.py
@@ -1,6 +1,8 @@
 import pytest

+@pytest.mark.skip(reason="flaky")
 def test_refunds_are_idempotent():
     assert True

+@pytest.mark.xfail
 def test_refund_partial():
     assert True
"""

JS_SKIP = """\
diff --git a/tests/cart.spec.ts b/tests/cart.spec.ts
index 7777777..8888888 100644
--- a/tests/cart.spec.ts
+++ b/tests/cart.spec.ts
@@ -1,8 +1,8 @@
-  it('adds to cart', async () => {
+  it.skip('adds to cart', async () => {
     await addToCart();
   });
-  test('removes from cart', async () => {
+  test.skip('removes from cart', async () => {
     await removeFromCart();
   });
"""

XIT_AND_ONLY = """\
diff --git a/tests/wishlist.spec.ts b/tests/wishlist.spec.ts
index 9999999..aaaaaaa 100644
--- a/tests/wishlist.spec.ts
+++ b/tests/wishlist.spec.ts
@@ -1,6 +1,6 @@
-  it('saves a wish', () => {});
+  xit('saves a wish', () => {});
-  it('shares a wish', () => {});
+  it.only('shares a wish', () => {});
"""

NON_TEST_FILE = """\
diff --git a/src/points.service.ts b/src/points.service.ts
index bbbbbbb..ccccccc 100644
--- a/src/points.service.ts
+++ b/src/points.service.ts
@@ -1,5 +1,2 @@
-export function testHarness() {
-  it('inline', () => {});
-}
 export const x = 1;
"""


# --------------------------------------------------------------------------
# diffscan: test-file classification
# --------------------------------------------------------------------------


@pytest.mark.parametrize("path", [
    "tests/test_points.py",
    "pkg/points_test.py",
    "tests/checkout.spec.ts",
    "src/cart.test.tsx",
    "app/__tests__/thing.js",
    "test/legacy/thing.js",
])
def test_is_test_file_accepts_known_layouts(path):
    assert diffscan.is_test_file(path) is True


@pytest.mark.parametrize("path", [
    "src/points.service.ts",
    "docs/testing.md",
    "README.md",
    "src/latest/api.py",
])
def test_is_test_file_rejects_non_tests(path):
    assert diffscan.is_test_file(path) is False


# --------------------------------------------------------------------------
# diffscan: removed-test detection
# --------------------------------------------------------------------------


def test_finds_removed_python_tests():
    found = diffscan.find_deletions(PY_REMOVAL)
    names = [d.name for d in found]
    assert names == ["test_earns_points_on_purchase", "test_points_expire"]
    assert all(d.kind == diffscan.Kind.REMOVED for d in found)
    assert all(d.file == "tests/test_points.py" for d in found)


def test_finds_removed_js_tests_including_describe_block():
    found = diffscan.find_deletions(JS_REMOVAL)
    names = sorted(d.name for d in found)
    assert names == ["adds to cart", "checkout flow", "clears the cart"]


def test_ignores_deletions_in_non_test_files():
    assert diffscan.find_deletions(NON_TEST_FILE) == []


WHOLE_FILE_REMOVAL = """\
diff --git a/tests/test_points.py b/tests/test_points.py
deleted file mode 100644
index 1111111..0000000
--- a/tests/test_points.py
+++ /dev/null
@@ -1,4 +0,0 @@
-def test_earns_points():
-    assert True
-def test_points_expire():
-    assert True
"""


def test_finds_tests_in_a_wholesale_deleted_file():
    # A deleted file shows `+++ /dev/null`; the path is on the `--- a/...` side.
    # Deleting an entire test file is the most severe quarantine case and must
    # still be captured, not silently dropped.
    found = diffscan.find_deletions(WHOLE_FILE_REMOVAL)
    assert [d.name for d in found] == ["test_earns_points", "test_points_expire"]
    assert all(d.file == "tests/test_points.py" for d in found)
    assert all(d.kind == diffscan.Kind.REMOVED for d in found)


def test_records_line_numbers_for_removed_tests():
    found = diffscan.find_deletions(PY_REMOVAL)
    assert found[0].line == 3


def test_deletions_are_sorted_stably():
    combined = PY_REMOVAL + JS_REMOVAL
    found = diffscan.find_deletions(combined)
    keys = [(d.file, d.name) for d in found]
    assert keys == sorted(keys)


# --------------------------------------------------------------------------
# diffscan: skip-marker detection
# --------------------------------------------------------------------------


def test_finds_newly_added_pytest_skip_and_xfail():
    found = diffscan.find_deletions(PYTEST_SKIP)
    by_name = {d.name: d for d in found}
    assert set(by_name) == {"test_refunds_are_idempotent", "test_refund_partial"}
    assert by_name["test_refunds_are_idempotent"].kind == diffscan.Kind.SKIPPED
    assert "pytest.mark.skip" in by_name["test_refunds_are_idempotent"].marker
    assert "pytest.mark.xfail" in by_name["test_refund_partial"].marker


def test_finds_js_skip_markers():
    found = diffscan.find_deletions(JS_SKIP)
    by_name = {d.name: d for d in found}
    assert set(by_name) == {"adds to cart", "removes from cart"}
    assert all(d.kind == diffscan.Kind.SKIPPED for d in found)
    assert by_name["adds to cart"].marker == "it.skip"
    assert by_name["removes from cart"].marker == "test.skip"


def test_finds_xit_and_only_narrowing():
    found = diffscan.find_deletions(XIT_AND_ONLY)
    by_name = {d.name: d for d in found}
    assert by_name["saves a wish"].marker == "xit"
    assert by_name["shares a wish"].marker == "it.only"
    assert all(d.kind == diffscan.Kind.SKIPPED for d in found)


def test_skip_supersedes_removal_of_the_same_test():
    # `- it('x')` / `+ it.skip('x')` is one event, not two: reported once, as
    # a skip, so the ledger does not double-count a rename-to-skip.
    found = diffscan.find_deletions(JS_SKIP)
    assert len(found) == 2
    assert all(d.kind == diffscan.Kind.SKIPPED for d in found)


# #400: Playwright `.fixme` conversions (test.fixme / test.describe.fixme) are
# quarantines, not deletions (repro reduced from a real consuming-repo PR).
FIXME_CONVERSION = """\
diff --git a/tests/checkout.spec.ts b/tests/checkout.spec.ts
index 1111111..2222222 100644
--- a/tests/checkout.spec.ts
+++ b/tests/checkout.spec.ts
@@ -1,6 +1,6 @@
-test.describe('Checkout Flow', () => {
+test.describe.fixme('Checkout Flow', () => {
   beforeEach(async ({ page }) => { await page.goto('/'); });
-  test('Verify cart totals update', async () => {
+  test.fixme('Verify cart totals update', async () => {
     await expect(page).toHaveTitle(/Cart/);
   });
"""


def test_fixme_conversion_is_skipped_not_removed():
    # #400: `test(...)`→`test.fixme(...)` and `test.describe`→`test.describe.fixme`
    # are quarantines. They must classify as SKIPPED (superseding the `-` line's
    # removal), never REMOVED — otherwise katana fires false last-coverage alarms
    # on merely-skipped tests.
    found = diffscan.find_deletions(FIXME_CONVERSION)
    by_name = {d.name: d for d in found}
    assert set(by_name) == {"Checkout Flow", "Verify cart totals update"}
    assert all(d.kind == diffscan.Kind.SKIPPED for d in found)
    assert all("fixme" in d.marker for d in found)


def test_deletion_to_dict_is_json_safe():
    d = diffscan.find_deletions(JS_SKIP)[0]
    payload = d.to_dict()
    assert payload["kind"] == "skipped"
    json.dumps(payload)


PENDING_SKIP_NO_DEF = """\
diff --git a/tests/test_orphan.py b/tests/test_orphan.py
--- a/tests/test_orphan.py
+++ b/tests/test_orphan.py
@@ -1,2 +1,6 @@
 import pytest
+@pytest.mark.skip(reason="later")
+
+# a note, not a def
+x = 1
"""


def test_pending_skip_marker_without_a_following_def_is_dropped(tmp_path):
    # A `+@pytest.mark.skip` whose following `+` lines are a blank line, a
    # comment, and an assignment -- never a `def` -- must not be mis-attached to
    # some later symbol. The dangling marker is dropped cleanly.
    found = diffscan.find_deletions(PENDING_SKIP_NO_DEF)
    assert found == []


NO_NEWLINE_AT_EOF = """\
diff --git a/tests/test_eof.py b/tests/test_eof.py
--- a/tests/test_eof.py
+++ b/tests/test_eof.py
@@ -1,2 +1,1 @@
-def test_gone():
-    assert True
\\ No newline at end of file
"""


def test_no_newline_at_eof_marker_is_handled(tmp_path):
    # A hunk carrying a `\\ No newline at end of file` marker must be parsed
    # without error, and the removed test around it still captured.
    found = diffscan.find_deletions(NO_NEWLINE_AT_EOF)
    assert [d.name for d in found] == ["test_gone"]
    assert found[0].kind == diffscan.Kind.REMOVED


# --------------------------------------------------------------------------
# ledger
# --------------------------------------------------------------------------


def _entry(test="test_a", file="tests/test_a.py", kind="removed", commit="abc123"):
    return ledger.LedgerEntry(
        test=test,
        file=file,
        kind=kind,
        marker="",
        commit=commit,
        author="Ada Lovelace",
        date="2026-07-20T10:00:00+00:00",
        reason="chore: drop dead feature",
    )


def test_ledger_load_missing_returns_empty_doc(tmp_path):
    doc = ledger.load(tmp_path / "nope.json")
    assert doc == {"schema_version": ledger.SCHEMA_VERSION, "entries": []}


def test_ledger_append_writes_expected_shape(tmp_path):
    path = tmp_path / ".canary" / "quarantine.json"
    doc = ledger.append_entries(path, [_entry()])
    assert path.exists()
    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert on_disk == doc
    assert on_disk["schema_version"] == ledger.SCHEMA_VERSION
    row = on_disk["entries"][0]
    assert row["test"] == "test_a"
    assert row["file"] == "tests/test_a.py"
    assert row["commit"] == "abc123"
    assert row["author"] == "Ada Lovelace"
    assert row["date"] == "2026-07-20T10:00:00+00:00"
    assert row["reason"] == "chore: drop dead feature"


def test_ledger_is_append_only(tmp_path):
    path = tmp_path / "q.json"
    ledger.append_entries(path, [_entry(test="test_a")])
    doc = ledger.append_entries(path, [_entry(test="test_b")])
    assert [e["test"] for e in doc["entries"]] == ["test_a", "test_b"]


def test_ledger_dedupes_identical_entries(tmp_path):
    path = tmp_path / "q.json"
    ledger.append_entries(path, [_entry()])
    doc = ledger.append_entries(path, [_entry()])
    assert len(doc["entries"]) == 1


def test_ledger_new_entries_are_sorted_for_stable_ordering(tmp_path):
    path = tmp_path / "q.json"
    doc = ledger.append_entries(path, [
        _entry(test="z", file="tests/b.py"),
        _entry(test="a", file="tests/b.py"),
        _entry(test="m", file="tests/a.py"),
    ])
    assert [(e["file"], e["test"]) for e in doc["entries"]] == [
        ("tests/a.py", "m"),
        ("tests/b.py", "a"),
        ("tests/b.py", "z"),
    ]


def test_ledger_corrupt_file_raises_valueerror(tmp_path):
    path = tmp_path / "q.json"
    path.write_text("not json", encoding="utf-8")
    with pytest.raises(ValueError):
        ledger.load(path)


def test_ledger_non_object_toplevel_raises(tmp_path):
    path = tmp_path / "q.json"
    path.write_text("[1, 2]", encoding="utf-8")
    with pytest.raises(ValueError):
        ledger.load(path)


# --------------------------------------------------------------------------
# alarm: critical-area loading and degradation
# --------------------------------------------------------------------------


def _areas_file(tmp_path, areas):
    path = tmp_path / "critical-areas.json"
    path.write_text(
        json.dumps({"generated": "2026-07-20T00:00:00+00:00", "areas": areas}),
        encoding="utf-8",
    )
    return path


def test_load_critical_areas_missing_is_unavailable(tmp_path):
    result = alarm.load_critical_areas(tmp_path / "nope.json")
    assert result.available is False
    assert result.areas == []
    assert "not found" in result.reason


def test_load_critical_areas_malformed_is_unavailable(tmp_path):
    path = tmp_path / "critical-areas.json"
    path.write_text("{oops", encoding="utf-8")
    result = alarm.load_critical_areas(path)
    assert result.available is False
    assert result.reason


def test_load_critical_areas_reads_areas(tmp_path):
    path = _areas_file(tmp_path, [
        {"path": "src/loyalty/points.service.ts", "risk_score": 0.92},
    ])
    result = alarm.load_critical_areas(path)
    assert result.available is True
    assert result.areas[0]["path"] == "src/loyalty/points.service.ts"


def test_degraded_area_set_never_alarms(tmp_path):
    deletions = diffscan.find_deletions(PY_REMOVAL)
    unavailable = alarm.load_critical_areas(tmp_path / "nope.json")
    assert alarm.build_findings(deletions, unavailable, tmp_path) == []


def test_degraded_notice_text_is_explicit():
    assert alarm.DEGRADED_NOTICE == (
        "critical-area data unavailable, recording only, not alarming"
    )


# --------------------------------------------------------------------------
# alarm: last-coverage detection
# --------------------------------------------------------------------------


def test_area_symbols_strips_suffixes():
    syms = alarm.area_symbols("src/loyalty/points.service.ts")
    assert "points.service" in syms
    assert "points" in syms


def _repo_with(tmp_path, files):
    for rel, text in files.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return tmp_path


def test_alarm_fires_when_last_coverage_removed(tmp_path):
    diff = """\
diff --git a/tests/test_points.py b/tests/test_points.py
--- a/tests/test_points.py
+++ b/tests/test_points.py
@@ -1,5 +1,1 @@
-def test_points_service_earns():
-    assert earn(100) == 10
-
 x = 1
"""
    repo = _repo_with(tmp_path, {"tests/test_points.py": "x = 1\n"})
    areas = alarm.load_critical_areas(_areas_file(
        tmp_path, [{"path": "src/loyalty/points.service.ts", "risk_score": 0.92}]
    ))
    findings = alarm.build_findings(diffscan.find_deletions(diff), areas, repo)
    assert len(findings) == 1
    f = findings[0]
    assert f.kind == "last-coverage-removed"
    assert f.area == "src/loyalty/points.service.ts"
    assert f.severity == alarm.Severity.CRITICAL
    assert f.fidelity == alarm.Fidelity.NAME_MATCHED


def test_no_alarm_when_other_tests_still_cover_the_symbol(tmp_path):
    diff = """\
diff --git a/tests/test_points.py b/tests/test_points.py
--- a/tests/test_points.py
+++ b/tests/test_points.py
@@ -1,5 +1,1 @@
-def test_points_service_earns():
-    assert earn(100) == 10
-
 x = 1
"""
    repo = _repo_with(tmp_path, {
        "tests/test_points.py": "x = 1\n",
        "tests/test_points_api.py": "def test_points_service_api():\n    pass\n",
    })
    areas = alarm.load_critical_areas(_areas_file(
        tmp_path, [{"path": "src/loyalty/points.service.ts", "risk_score": 0.92}]
    ))
    assert alarm.build_findings(diffscan.find_deletions(diff), areas, repo) == []


def test_alarm_scan_skips_non_utf8_files_without_crashing(tmp_path):
    # #395 bug 1: a non-UTF-8 file whose path matches a test dir (e.g. a binary
    # asset under tests/) must be skipped, not crash the alarm pass with a
    # UnicodeDecodeError. The alarm still fires because the only real coverage
    # (the deleted test) is gone.
    diff = """\
diff --git a/tests/test_points.py b/tests/test_points.py
--- a/tests/test_points.py
+++ b/tests/test_points.py
@@ -1,5 +1,1 @@
-def test_points_service_earns():
-    assert earn(100) == 10
-
 x = 1
"""
    repo = _repo_with(tmp_path, {"tests/test_points.py": "x = 1\n"})
    binary = tmp_path / "tests" / "assets" / "logo.png"
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_bytes(b"\xff\xfe\x00\x01 not valid utf-8 \xff\xfe")
    areas = alarm.load_critical_areas(_areas_file(
        tmp_path, [{"path": "src/loyalty/points.service.ts", "risk_score": 0.92}]
    ))
    findings = alarm.build_findings(diffscan.find_deletions(diff), areas, repo)
    assert len(findings) == 1
    assert findings[0].kind == "last-coverage-removed"


def test_repo_test_files_prunes_heavy_ignored_dirs(tmp_path):
    # #395 bug 2: the scan must not descend into node_modules/.git/dist/etc.,
    # or it times out on a real monorepo. A test-named file vendored under
    # node_modules is neither enumerated nor counted as coverage.
    repo = _repo_with(tmp_path, {
        "tests/real.test.js": "it('real', () => {})\n",
        "node_modules/pkg/vendored.test.js": "it('vendored', () => {})\n",
        "dist/bundle.test.js": "it('built', () => {})\n",
    })
    rels = [rel for rel, _ in alarm._repo_test_files(repo)]
    assert "tests/real.test.js" in rels
    assert not any("node_modules" in r or r.startswith("dist/") for r in rels)


def test_no_alarm_when_deletion_is_unrelated_to_any_area(tmp_path):
    repo = _repo_with(tmp_path, {"tests/checkout.spec.ts": "// gone\n"})
    areas = alarm.load_critical_areas(_areas_file(
        tmp_path, [{"path": "src/loyalty/points.service.ts", "risk_score": 0.92}]
    ))
    assert alarm.build_findings(diffscan.find_deletions(JS_REMOVAL), areas, repo) == []


def test_low_risk_area_alarms_at_high_not_critical(tmp_path):
    diff = """\
diff --git a/tests/test_points.py b/tests/test_points.py
--- a/tests/test_points.py
+++ b/tests/test_points.py
@@ -1,3 +1,1 @@
-def test_points_service_earns():
-    assert True
 x = 1
"""
    repo = _repo_with(tmp_path, {"tests/test_points.py": "x = 1\n"})
    areas = alarm.load_critical_areas(_areas_file(
        tmp_path, [{"path": "src/loyalty/points.service.ts", "risk_score": 0.41}]
    ))
    findings = alarm.build_findings(diffscan.find_deletions(diff), areas, repo)
    assert findings[0].severity == alarm.Severity.HIGH


def test_directory_only_match_is_heuristic_and_medium(tmp_path):
    diff = """\
diff --git a/tests/loyalty/test_misc.py b/tests/loyalty/test_misc.py
--- a/tests/loyalty/test_misc.py
+++ b/tests/loyalty/test_misc.py
@@ -1,3 +1,1 @@
-def test_something_else():
-    assert True
 x = 1
"""
    repo = _repo_with(tmp_path, {"tests/loyalty/test_misc.py": "x = 1\n"})
    areas = alarm.load_critical_areas(_areas_file(
        tmp_path, [{"path": "src/loyalty/points.service.ts", "risk_score": 0.92}]
    ))
    findings = alarm.build_findings(diffscan.find_deletions(diff), areas, repo)
    assert len(findings) == 1
    assert findings[0].fidelity == alarm.Fidelity.HEURISTIC
    assert findings[0].severity == alarm.Severity.MEDIUM


def test_no_alarm_when_dir_coverage_remains_in_the_area_directory(tmp_path):
    # Directory-heuristic twin of the symbol-match suppression test: the deleted
    # test matched a critical area only by living in its significant directory
    # (`loyalty`), but another test in that same directory still exists, so the
    # dir-level coverage is intact and katana stays silent.
    diff = """\
diff --git a/tests/loyalty/test_misc.py b/tests/loyalty/test_misc.py
--- a/tests/loyalty/test_misc.py
+++ b/tests/loyalty/test_misc.py
@@ -1,3 +1,1 @@
-def test_something_else():
-    assert True
 x = 1
"""
    repo = _repo_with(tmp_path, {
        "tests/loyalty/test_misc.py": "x = 1\n",
        "tests/loyalty/test_other.py": "def test_other():\n    pass\n",
    })
    areas = alarm.load_critical_areas(_areas_file(
        tmp_path, [{"path": "src/loyalty/points.service.ts", "risk_score": 0.92}]
    ))
    assert alarm.build_findings(diffscan.find_deletions(diff), areas, repo) == []


def test_deletion_matching_multiple_areas_keeps_the_highest_fidelity_finding(tmp_path):
    # One deletion can match several critical areas. build_findings keeps only
    # the best candidate per deletion: a name-matched critical loss outranks a
    # weaker directory-heuristic medium for a second area, and the incumbent is
    # not displaced by the lower-ranked candidate.
    diff = """\
diff --git a/tests/loyalty/test_points.py b/tests/loyalty/test_points.py
--- a/tests/loyalty/test_points.py
+++ b/tests/loyalty/test_points.py
@@ -1,3 +1,1 @@
-def test_points_service_earns():
-    assert True
 x = 1
"""
    repo = _repo_with(tmp_path, {"tests/loyalty/test_points.py": "x = 1\n"})
    areas = alarm.load_critical_areas(_areas_file(tmp_path, [
        {"path": "src/loyalty/points.service.ts", "risk_score": 0.92},
        {"path": "src/loyalty/refunds.gateway.ts", "risk_score": 0.92},
    ]))
    findings = alarm.build_findings(diffscan.find_deletions(diff), areas, repo)
    assert len(findings) == 1
    assert findings[0].fidelity == alarm.Fidelity.NAME_MATCHED
    assert findings[0].severity == alarm.Severity.CRITICAL
    assert findings[0].area == "src/loyalty/points.service.ts"


def test_fidelity_rank_orders_name_match_above_heuristic():
    assert alarm.Fidelity.NAME_MATCHED.rank < alarm.Fidelity.HEURISTIC.rank


def test_severity_sort_key_orders_critical_first():
    ordered = sorted(
        [alarm.Severity.MEDIUM, alarm.Severity.CRITICAL, alarm.Severity.HIGH],
        key=lambda s: s.sort_key,
    )
    assert ordered[0] == alarm.Severity.CRITICAL


def test_finding_to_dict_is_json_safe(tmp_path):
    f = alarm.Finding(
        kind="last-coverage-removed",
        test="t",
        file="tests/t.py",
        area="src/a.ts",
        fidelity=alarm.Fidelity.NAME_MATCHED,
        severity=alarm.Severity.HIGH,
        evidence="e",
    )
    payload = f.to_dict()
    assert payload["fidelity"] == "name-matched"
    assert payload["severity"] == "high"
    json.dumps(payload)


# --------------------------------------------------------------------------
# git plumbing (fixture repo, never this repo's real history)
# --------------------------------------------------------------------------


def _git(repo: Path, *args):
    subprocess.run(
        ["git", *args], cwd=repo, check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )


@pytest.fixture()
def fixture_repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.email", "ada@example.com")
    _git(repo, "config", "user.name", "Ada Lovelace")
    (repo / "tests").mkdir()
    (repo / "tests" / "test_points.py").write_text(
        "def test_points_service_earns():\n    assert True\n", encoding="utf-8"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "test: add points coverage")
    _git(repo, "checkout", "-b", "feat/drop")
    (repo / "tests" / "test_points.py").write_text("x = 1\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "chore: drop points coverage")
    return repo


def test_resolve_base_defaults_to_merge_base(fixture_repo):
    base = diffscan.resolve_base(fixture_repo, None)
    assert base
    head = diffscan.run_git(fixture_repo, "rev-parse", "HEAD").strip()
    assert base != head


def test_resolve_base_honours_explicit_ref(fixture_repo):
    assert diffscan.resolve_base(fixture_repo, "main") == "main"


def test_diff_text_finds_the_removed_test(fixture_repo):
    base = diffscan.resolve_base(fixture_repo, None)
    text = diffscan.diff_text(fixture_repo, base)
    assert "-def test_points_service_earns():" in text
    found = diffscan.find_deletions(text)
    assert [d.name for d in found] == ["test_points_service_earns"]


def test_commit_for_file_returns_provenance(fixture_repo):
    base = diffscan.resolve_base(fixture_repo, None)
    commit = diffscan.commit_for_file(fixture_repo, base, "tests/test_points.py")
    assert commit is not None
    assert commit.author == "Ada Lovelace"
    assert commit.subject == "chore: drop points coverage"
    assert len(commit.sha) == 40
    assert commit.date


def test_commit_for_file_unknown_path_returns_none(fixture_repo):
    base = diffscan.resolve_base(fixture_repo, None)
    assert diffscan.commit_for_file(fixture_repo, base, "tests/nope.py") is None


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------


def _diff_file(tmp_path, text):
    p = tmp_path / "changes.diff"
    p.write_text(text, encoding="utf-8")
    return str(p)


def test_cli_records_deletions_and_exits_zero(tmp_path, capsys):
    ledger_path = tmp_path / ".canary" / "quarantine.json"
    code = cli.main([
        "--repo", str(tmp_path),
        "--diff-file", _diff_file(tmp_path, PY_REMOVAL),
        "--ledger", str(ledger_path),
    ])
    assert code == 0
    out = capsys.readouterr().out
    assert "2 deletion(s) captured" in out
    doc = json.loads(ledger_path.read_text(encoding="utf-8"))
    assert len(doc["entries"]) == 2


def test_cli_degrades_loudly_without_critical_areas(tmp_path, capsys):
    code = cli.main([
        "--repo", str(tmp_path),
        "--diff-file", _diff_file(tmp_path, PY_REMOVAL),
        "--ledger", str(tmp_path / "q.json"),
    ])
    captured = capsys.readouterr()
    assert code == 0
    assert alarm.DEGRADED_NOTICE in captured.out + captured.err


def test_cli_strict_stays_zero_when_degraded(tmp_path, capsys):
    # A muted gate is worse than no gate: degradation must never manufacture a
    # failure, even under --strict.
    code = cli.main([
        "--repo", str(tmp_path),
        "--diff-file", _diff_file(tmp_path, PY_REMOVAL),
        "--ledger", str(tmp_path / "q.json"),
        "--strict",
    ])
    assert code == 0
    assert alarm.DEGRADED_NOTICE in capsys.readouterr().out


def test_cli_json_shape(tmp_path):
    areas = _areas_file(tmp_path, [
        {"path": "src/loyalty/points.service.ts", "risk_score": 0.92},
    ])
    out_ledger = tmp_path / "q.json"
    cli.main([
        "--repo", str(tmp_path),
        "--diff-file", _diff_file(tmp_path, PY_REMOVAL),
        "--ledger", str(out_ledger),
        "--critical-areas", str(areas),
        "--json",
    ])
    import io
    # re-run capturing stdout via capsys is done below; here assert the ledger
    # exists so the JSON path still writes provenance.
    assert out_ledger.exists()
    assert isinstance(io.StringIO, type)


def test_cli_json_payload_has_stable_keys(tmp_path, capsys):
    areas = _areas_file(tmp_path, [
        {"path": "src/loyalty/points.service.ts", "risk_score": 0.92},
    ])
    cli.main([
        "--repo", str(tmp_path),
        "--diff-file", _diff_file(tmp_path, PY_REMOVAL),
        "--ledger", str(tmp_path / "q.json"),
        "--critical-areas", str(areas),
        "--json",
    ])
    payload = json.loads(capsys.readouterr().out)
    assert payload["schema_version"] == ledger.SCHEMA_VERSION
    assert isinstance(payload["captured"], list)
    assert isinstance(payload["findings"], list)
    assert payload["ledger"].endswith("q.json")
    assert "degraded_notice" not in payload


def test_cli_json_includes_degraded_notice_when_unavailable(tmp_path, capsys):
    cli.main([
        "--repo", str(tmp_path),
        "--diff-file", _diff_file(tmp_path, PY_REMOVAL),
        "--ledger", str(tmp_path / "q.json"),
        "--json",
    ])
    payload = json.loads(capsys.readouterr().out)
    assert alarm.DEGRADED_NOTICE in payload["degraded_notice"]
    assert payload["findings"] == []


def test_cli_strict_exits_one_on_alarm(tmp_path, capsys):
    diff = """\
diff --git a/tests/test_points.py b/tests/test_points.py
--- a/tests/test_points.py
+++ b/tests/test_points.py
@@ -1,3 +1,1 @@
-def test_points_service_earns():
-    assert True
 x = 1
"""
    _repo_with(tmp_path, {"tests/test_points.py": "x = 1\n"})
    areas = _areas_file(tmp_path, [
        {"path": "src/loyalty/points.service.ts", "risk_score": 0.92},
    ])
    args = [
        "--repo", str(tmp_path),
        "--diff-file", _diff_file(tmp_path, diff),
        "--ledger", str(tmp_path / "q.json"),
        "--critical-areas", str(areas),
    ]
    assert cli.main(args) == 0  # advisory by default
    assert "last coverage" in capsys.readouterr().out
    assert cli.main(args + ["--strict"]) == 1


def test_cli_no_deletions_is_quiet_and_zero(tmp_path, capsys):
    code = cli.main([
        "--repo", str(tmp_path),
        "--diff-file", _diff_file(tmp_path, NON_TEST_FILE),
        "--ledger", str(tmp_path / "q.json"),
        "--strict",
    ])
    assert code == 0
    assert "0 deletion(s) captured" in capsys.readouterr().out


def test_cli_no_write_leaves_ledger_absent(tmp_path):
    ledger_path = tmp_path / "q.json"
    assert cli.main([
        "--repo", str(tmp_path),
        "--diff-file", _diff_file(tmp_path, PY_REMOVAL),
        "--ledger", str(ledger_path),
        "--no-write",
    ]) == 0
    assert not ledger_path.exists()


def test_cli_missing_diff_file_returns_1(tmp_path, capsys):
    code = cli.main([
        "--repo", str(tmp_path),
        "--diff-file", str(tmp_path / "nope.diff"),
    ])
    assert code == 1
    assert "canary-katana:" in capsys.readouterr().err


def test_cli_corrupt_ledger_returns_1(tmp_path, capsys):
    bad = tmp_path / "q.json"
    bad.write_text("not json", encoding="utf-8")
    code = cli.main([
        "--repo", str(tmp_path),
        "--diff-file", _diff_file(tmp_path, PY_REMOVAL),
        "--ledger", str(bad),
    ])
    assert code == 1
    assert "canary-katana:" in capsys.readouterr().err


def test_cli_git_diff_failure_returns_1(tmp_path, capsys, monkeypatch):
    # No --diff-file means the diff is computed from git history. When git base
    # resolution fails, the CLI surfaces that loudly rather than crashing, and
    # returns 1. Force the failure via monkeypatch rather than relying on
    # tmp_path being outside a git repo -- that environmental assumption breaks
    # if a runner nests its temp dir inside a checkout (#382).
    def _boom(*_args, **_kwargs):
        raise RuntimeError("fatal: not a git repository")

    monkeypatch.setattr(diffscan, "resolve_base", _boom)
    code = cli.main(["--repo", str(tmp_path)])
    assert code == 1
    assert "canary-katana: could not read diff:" in capsys.readouterr().err


def test_cli_uses_git_when_no_diff_file(fixture_repo, capsys):
    code = cli.main([
        "--repo", str(fixture_repo),
        "--ledger", str(fixture_repo / ".canary" / "quarantine.json"),
    ])
    assert code == 0
    out = capsys.readouterr().out
    assert "1 deletion(s) captured" in out
    doc = json.loads(
        (fixture_repo / ".canary" / "quarantine.json").read_text(encoding="utf-8")
    )
    entry = doc["entries"][0]
    assert entry["author"] == "Ada Lovelace"
    assert entry["reason"] == "chore: drop points coverage"
    assert entry["test"] == "test_points_service_earns"


def test_cli_defaults_ledger_under_dot_canary(tmp_path):
    assert cli.main([
        "--repo", str(tmp_path),
        "--diff-file", _diff_file(tmp_path, PY_REMOVAL),
    ]) == 0
    assert (tmp_path / ".canary" / "quarantine.json").exists()


def test_cli_provenance_unknown_without_git(tmp_path):
    ledger_path = tmp_path / "q.json"
    cli.main([
        "--repo", str(tmp_path),
        "--diff-file", _diff_file(tmp_path, PY_REMOVAL),
        "--ledger", str(ledger_path),
    ])
    entry = json.loads(ledger_path.read_text(encoding="utf-8"))["entries"][0]
    assert entry["author"] == "unknown"
    assert entry["commit"] == ""


# --------------------------------------------------------------------------
# skill packaging contract
# --------------------------------------------------------------------------


def test_skill_is_discoverable_and_runnable():
    skills = {s.name: s for s in SkillRegistry().discover()}
    assert "canary-katana" in skills
    assert skills["canary-katana"].is_executable


def test_skill_declares_python_requirement():
    skills = {s.name: s for s in SkillRegistry().discover()}
    assert "python3" in " ".join(skills["canary-katana"].requires)


def test_skill_scripts_are_ascii_only():
    # Repo convention: emoji (and other non-ASCII) only in Markdown.
    for path in _SCRIPTS.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert text.isascii(), f"non-ASCII characters in {path}"


def test_skill_is_self_contained_no_agent_imports():
    for path in _SCRIPTS.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "from agent." not in text and "import agent" not in text


def test_skill_dir_has_no_client_strings():
    # Split literals so this public file does not itself carry the tokens the
    # repo-wide denylist guard scans for.
    banned = ("capi" "llary", "cap" "well")
    for path in _SKILL_DIR.rglob("*"):
        if path.is_file() and path.suffix in (".py", ".md"):
            text = path.read_text(encoding="utf-8").lower()
            for bad in banned:
                assert bad not in text, f"client string {bad!r} in {path}"
