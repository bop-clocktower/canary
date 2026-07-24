"""TDD for `is_assertion_free_test` — the high-precision 'weak test' signal the
guardian consumes. True only when the code defines a test function AND contains
no assertions (a test that asserts nothing). Snapshot/table-driven tests still
match an assertion pattern, so they must NOT trip it.
"""

from __future__ import annotations

from agent.core.quality_scorer import is_assertion_free_test


class TestPytest:
    def test_test_with_assert_is_not_flagged(self) -> None:
        code = "def test_add():\n    assert add(1, 2) == 3\n"
        assert is_assertion_free_test(code, "pytest") is False

    def test_test_without_assert_is_flagged(self) -> None:
        code = "def test_add():\n    result = add(1, 2)\n    print(result)\n"
        assert is_assertion_free_test(code, "pytest") is True

    def test_non_test_helper_is_not_flagged(self) -> None:
        # A helper added to a test file has no test function → not a weak test.
        code = "def _make_widget():\n    return Widget(size=1)\n"
        assert is_assertion_free_test(code, "pytest") is False

    def test_pytest_raises_counts_as_assertion(self) -> None:
        code = "def test_boom():\n    with pytest.raises(ValueError):\n        boom()\n"
        assert is_assertion_free_test(code, "pytest") is False


class TestVitest:
    def test_it_with_expect_is_not_flagged(self) -> None:
        code = "it('adds', () => {\n  expect(add(1,2)).toBe(3)\n})\n"
        assert is_assertion_free_test(code, "vitest") is False

    def test_it_without_expect_is_flagged(self) -> None:
        code = "it('adds', () => {\n  const r = add(1,2)\n  console.log(r)\n})\n"
        assert is_assertion_free_test(code, "vitest") is True

    def test_snapshot_test_is_not_flagged(self) -> None:
        # Snapshot assertion still matches `expect(` → not weak.
        code = "it('renders', () => {\n  expect(render()).toMatchSnapshot()\n})\n"
        assert is_assertion_free_test(code, "vitest") is False


class TestNonExpectJsAssertions:
    # FP-1: TS/JS tests that assert without bare expect() must NOT be flagged.
    def test_chai_should_style(self) -> None:
        code = "it('x', () => {\n  result.should.equal(5)\n})\n"
        assert is_assertion_free_test(code, "vitest") is False

    def test_node_assert_equal(self) -> None:
        code = "it('x', () => {\n  assert.equal(result, 5)\n})\n"
        assert is_assertion_free_test(code, "vitest") is False

    def test_bare_assert_call(self) -> None:
        code = "it('x', () => {\n  assert(result === 5)\n})\n"
        assert is_assertion_free_test(code, "vitest") is False


class TestPytestAssertHelpers:
    # FP-2 (partial): a call to an assert*-named helper counts as an assertion.
    def test_assert_prefixed_helper_call(self) -> None:
        code = "def test_api():\n    assert_valid(call())\n"
        assert is_assertion_free_test(code, "pytest") is False


class TestUnknownFrameworkFallsBackToPytest:
    def test_unknown_framework_uses_pytest_patterns(self) -> None:
        code = "def test_x():\n    assert True\n"
        assert is_assertion_free_test(code, "somethingelse") is False
