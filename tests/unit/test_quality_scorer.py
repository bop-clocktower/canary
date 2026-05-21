"""Unit tests for agent.core.quality_scorer."""

import unittest
from agent.core.quality_scorer import QualityScorer, _grade

scorer = QualityScorer()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_PYTEST_RICH = """\
import pytest

def test_create_user_success():
    resp = client.post("/users", json={"name": "Alice"})
    assert resp.status_code == 201
    assert resp.json()["name"] == "Alice"

def test_create_user_invalid_email():
    resp = client.post("/users", json={"email": "bad"})
    assert resp.status_code == 422

def test_create_user_missing_name():
    resp = client.post("/users", json={})
    assert resp.status_code == 422

@pytest.mark.parametrize("name", ["", " ", None])
def test_create_user_blank_name(name):
    resp = client.post("/users", json={"name": name})
    assert resp.status_code == 422
"""

_PYTEST_TRIVIAL = """\
def test_always_passes():
    assert True
"""

_PLAYWRIGHT_RICH = """\
import { test, expect } from '@playwright/test';

test('login success', async ({ page }) => {
  await page.goto('https://example.com/login');
  await page.fill('#email', 'user@example.com');
  await page.fill('#password', 'secret');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/dashboard');
  await expect(page.locator('h1')).toHaveText('Welcome');
});

test('login invalid password shows error', async ({ page }) => {
  await page.goto('https://example.com/login');
  await page.fill('#email', 'user@example.com');
  await page.fill('#password', 'wrong');
  await page.click('button[type=submit]');
  await expect(page.locator('.error')).toBeVisible();
  await expect(page.locator('.error')).toHaveText('Invalid credentials');
});
"""

_PLAYWRIGHT_FLAKY = """\
import { test, expect } from '@playwright/test';

test('flaky test with sleep', async ({ page }) => {
  await page.goto('https://example.com');
  await page.waitForTimeout(3000);
  await expect(page.locator('h1')).toBeVisible();
  setTimeout(() => {}, 1000);
});
"""

_VITEST_RICH = """\
import { describe, it, expect } from 'vitest';

describe('validateEmail', () => {
  it('accepts valid email', () => {
    expect(validateEmail('user@example.com')).toBe(true);
  });

  it('rejects missing @', () => {
    expect(validateEmail('userexample.com')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateEmail('')).toBe(false);
  });

  it('throws on null input', () => {
    expect(() => validateEmail(null)).toThrow();
  });
});
"""

_K6_RICH = """\
import http from 'k6/http';
import { check } from 'k6';

export default function () {
  const res = http.get('https://example.com/api/users');
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response has users': (r) => r.json().length > 0,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  const postRes = http.post('https://example.com/api/users', JSON.stringify({ name: 'Alice' }));
  check(postRes, {
    'create returns 201': (r) => r.status === 201,
    'id is present': (r) => r.json().id !== undefined,
  });
}
"""

_FLAKY_RANDOM = """\
def test_with_random():
    value = random.random()
    assert value >= 0
    assert value < 1
"""

_FLAKY_TIMESTAMP = """\
def test_with_timestamp():
    ts = datetime.now().isoformat()
    resp = client.get(f"/events?since={ts}")
    assert resp.status_code == 200
"""


# ---------------------------------------------------------------------------
# Grade helper
# ---------------------------------------------------------------------------

class TestGrade(unittest.TestCase):

    def test_grade_a(self):
        self.assertEqual(_grade(90), "A")
        self.assertEqual(_grade(100), "A")

    def test_grade_b(self):
        self.assertEqual(_grade(70), "B")
        self.assertEqual(_grade(84), "B")

    def test_grade_c(self):
        self.assertEqual(_grade(55), "C")
        self.assertEqual(_grade(69), "C")

    def test_grade_d(self):
        self.assertEqual(_grade(40), "D")
        self.assertEqual(_grade(54), "D")

    def test_grade_f(self):
        self.assertEqual(_grade(0), "F")
        self.assertEqual(_grade(39), "F")


# ---------------------------------------------------------------------------
# Coverage breadth
# ---------------------------------------------------------------------------

class TestCoverageBreadth(unittest.TestCase):

    def test_rich_pytest_high_coverage(self):
        result = scorer.score(_PYTEST_RICH, "pytest")
        self.assertGreaterEqual(result["coverage_breadth"], 80)

    def test_trivial_pytest_low_coverage(self):
        result = scorer.score(_PYTEST_TRIVIAL, "pytest")
        self.assertLessEqual(result["coverage_breadth"], 35)

    def test_parametrize_bonus(self):
        result = scorer.score(_PYTEST_RICH, "pytest")
        self.assertIn("Parametrized test cases detected", result["details"])

    def test_negative_path_bonus(self):
        result = scorer.score(_PYTEST_RICH, "pytest")
        self.assertIn("Covers error/invalid paths", result["details"])

    def test_playwright_test_count_detected(self):
        result = scorer.score(_PLAYWRIGHT_RICH, "playwright")
        self.assertGreaterEqual(result["coverage_breadth"], 55)

    def test_vitest_it_blocks_counted(self):
        result = scorer.score(_VITEST_RICH, "vitest")
        self.assertGreaterEqual(result["coverage_breadth"], 75)

    def test_k6_check_calls_counted(self):
        result = scorer.score(_K6_RICH, "k6")
        detail = next(d for d in result["details"] if "check" in d)
        self.assertIn("2", detail)


# ---------------------------------------------------------------------------
# Assertion density
# ---------------------------------------------------------------------------

class TestAssertionDensity(unittest.TestCase):

    def test_rich_pytest_good_density(self):
        result = scorer.score(_PYTEST_RICH, "pytest")
        self.assertGreaterEqual(result["assertion_density"], 55)

    def test_trivial_pytest_low_density(self):
        result = scorer.score(_PYTEST_TRIVIAL, "pytest")
        self.assertLessEqual(result["assertion_density"], 55)

    def test_playwright_expect_counted(self):
        result = scorer.score(_PLAYWRIGHT_RICH, "playwright")
        detail = next(d for d in result["details"] if "assertion" in d)
        count = int(detail.split()[0])
        self.assertGreaterEqual(count, 4)

    def test_vitest_expect_counted(self):
        result = scorer.score(_VITEST_RICH, "vitest")
        self.assertGreaterEqual(result["assertion_density"], 55)


# ---------------------------------------------------------------------------
# Flakiness risk
# ---------------------------------------------------------------------------

class TestFlakinessRisk(unittest.TestCase):

    def test_clean_test_full_score(self):
        result = scorer.score(_PYTEST_RICH, "pytest")
        self.assertEqual(result["flakiness_risk"], 100)
        self.assertIn("No flakiness signals detected", result["details"])

    def test_sleep_deducted(self):
        result = scorer.score(_PLAYWRIGHT_FLAKY, "playwright")
        self.assertLess(result["flakiness_risk"], 100)
        self.assertTrue(any("wait" in d for d in result["details"]))

    def test_multiple_sleeps_bigger_deduction(self):
        one_sleep = scorer.score(_PLAYWRIGHT_FLAKY.replace("setTimeout(() => {}, 1000);", ""), "playwright")
        two_sleeps = scorer.score(_PLAYWRIGHT_FLAKY, "playwright")
        self.assertLess(two_sleeps["flakiness_risk"], one_sleep["flakiness_risk"])

    def test_random_deducted(self):
        result = scorer.score(_FLAKY_RANDOM, "pytest")
        self.assertLess(result["flakiness_risk"], 100)
        self.assertIn("Non-deterministic random values detected", result["details"])

    def test_timestamp_deducted(self):
        result = scorer.score(_FLAKY_TIMESTAMP, "pytest")
        self.assertLess(result["flakiness_risk"], 100)
        self.assertIn("Timestamp-dependent assertions detected", result["details"])


# ---------------------------------------------------------------------------
# Composite score and output shape
# ---------------------------------------------------------------------------

class TestCompositeScore(unittest.TestCase):

    def _assert_valid_shape(self, result):
        self.assertIn("score", result)
        self.assertIn("grade", result)
        self.assertIn("coverage_breadth", result)
        self.assertIn("assertion_density", result)
        self.assertIn("flakiness_risk", result)
        self.assertIn("details", result)
        self.assertIsInstance(result["score"], int)
        self.assertIn(result["grade"], ("A", "B", "C", "D", "F"))
        self.assertIsInstance(result["details"], list)

    def test_output_shape_pytest(self):
        self._assert_valid_shape(scorer.score(_PYTEST_RICH, "pytest"))

    def test_output_shape_playwright(self):
        self._assert_valid_shape(scorer.score(_PLAYWRIGHT_RICH, "playwright"))

    def test_output_shape_vitest(self):
        self._assert_valid_shape(scorer.score(_VITEST_RICH, "vitest"))

    def test_output_shape_k6(self):
        self._assert_valid_shape(scorer.score(_K6_RICH, "k6"))

    def test_rich_pytest_scores_above_trivial(self):
        rich = scorer.score(_PYTEST_RICH, "pytest")
        trivial = scorer.score(_PYTEST_TRIVIAL, "pytest")
        self.assertGreater(rich["score"], trivial["score"])

    def test_flaky_test_scores_below_clean(self):
        clean = scorer.score(_PLAYWRIGHT_RICH, "playwright")
        flaky = scorer.score(_PLAYWRIGHT_FLAKY, "playwright")
        self.assertGreater(clean["score"], flaky["score"])

    def test_score_bounded_0_100(self):
        for code, fw in [
            (_PYTEST_RICH, "pytest"),
            (_PYTEST_TRIVIAL, "pytest"),
            (_PLAYWRIGHT_FLAKY, "playwright"),
        ]:
            result = scorer.score(code, fw)
            self.assertGreaterEqual(result["score"], 0)
            self.assertLessEqual(result["score"], 100)

    def test_score_from_path(self):
        import tempfile
        from pathlib import Path
        with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False) as f:
            f.write(_PYTEST_RICH)
            tmp = Path(f.name)
        try:
            result = scorer.score(tmp, "pytest")
            self._assert_valid_shape(result)
        finally:
            tmp.unlink()

    def test_unknown_framework_falls_back_gracefully(self):
        result = scorer.score(_PYTEST_TRIVIAL, "unknown_framework")
        self._assert_valid_shape(result)


if __name__ == "__main__":
    unittest.main()
