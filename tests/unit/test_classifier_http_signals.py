"""HTTP verb/path signal detection in TestClassifier (#90)."""

import pytest
from agent.core.classifier import TestClassifier


@pytest.fixture
def clf():
    return TestClassifier()


@pytest.mark.parametrize("prompt", [
    "test getting all avatars from GET /avatars; verify 200 status",
    "test enrolling user in challenge via POST /challenges/{id}/enroll",
    "DELETE /users/{userId} should return 204",
    "PUT /items/{id} updates the item and returns 200",
    "PATCH /profile endpoint updates display name",
    "verify GET /health returns 200",
    "POST /orders creates a new order with the correct payload",
])
def test_http_verb_path_classifies_as_api(clf, prompt):
    result = clf.classify(prompt)
    assert result.test_type == "api", (
        f"Expected 'api' for {prompt!r}, got {result.test_type!r}"
    )
    assert result.confidence >= 0.9


def test_http_verb_without_path_classifies_as_api(clf):
    """Bare HTTP verb (no slash path) is still a strong API signal."""
    result = clf.classify("POST a new order with bearer token")
    assert result.test_type == "api"


def test_verb_match_is_case_insensitive(clf):
    result = clf.classify("get /users should return a list")
    assert result.test_type == "api"


def test_non_http_prompt_unaffected(clf):
    """Words like 'delete' in plain English shouldn't trigger the HTTP rule."""
    result = clf.classify("delete the user account from the UI")
    assert result.test_type != "api" or result.confidence < 0.9
