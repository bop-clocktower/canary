"""Tests for agent/guardian/diff_extractor.py — OpenAPI diff extraction."""

from __future__ import annotations

from agent.guardian.diff_extractor import extract_api_diff, ChangeType


SPEC_V1 = {
    "openapi": "3.0.0",
    "paths": {
        "/v2/members": {
            "get": {"operationId": "listMembers", "summary": "List members"},
            "post": {"operationId": "createMember", "summary": "Create member"},
        },
        "/v2/members/{id}": {
            "get": {"operationId": "getMember", "summary": "Get member"},
            "put": {"operationId": "updateMember", "summary": "Update member"},
        },
        "/v2/auth/login": {
            "post": {"operationId": "login", "summary": "Login"},
        },
    },
}

SPEC_V2_ADD_ENDPOINT = {
    "openapi": "3.0.0",
    "paths": {
        **SPEC_V1["paths"],
        "/v2/members/bulk-import": {
            "post": {"operationId": "bulkImport", "summary": "Bulk import members"},
        },
    },
}

SPEC_V2_REMOVE_ENDPOINT = {
    "openapi": "3.0.0",
    "paths": {
        "/v2/members": SPEC_V1["paths"]["/v2/members"],
        "/v2/auth/login": SPEC_V1["paths"]["/v2/auth/login"],
    },
}

SPEC_V2_CHANGE_METHOD = {
    "openapi": "3.0.0",
    "paths": {
        "/v2/members": {
            "get": {"operationId": "listMembers", "summary": "List members — updated"},
            "post": {"operationId": "createMember", "summary": "Create member"},
        },
        "/v2/members/{id}": SPEC_V1["paths"]["/v2/members/{id}"],
        "/v2/auth/login": SPEC_V1["paths"]["/v2/auth/login"],
    },
}


class TestExtractApiDiff:
    def test_no_changes_returns_empty(self):
        diff = extract_api_diff(SPEC_V1, SPEC_V1)
        assert diff.added == []
        assert diff.removed == []
        assert diff.changed == []

    def test_detects_new_endpoint(self):
        diff = extract_api_diff(SPEC_V1, SPEC_V2_ADD_ENDPOINT)
        assert len(diff.added) == 1
        added = diff.added[0]
        assert added.path == "/v2/members/bulk-import"
        assert added.method == "post"
        assert added.change_type == ChangeType.ADDED

    def test_detects_removed_endpoint(self):
        diff = extract_api_diff(SPEC_V1, SPEC_V2_REMOVE_ENDPOINT)
        removed_paths = {c.path for c in diff.removed}
        assert "/v2/members/{id}" in removed_paths

    def test_detects_changed_summary(self):
        diff = extract_api_diff(SPEC_V1, SPEC_V2_CHANGE_METHOD)
        changed_paths = {c.path for c in diff.changed}
        assert "/v2/members" in changed_paths

    def test_multiple_methods_on_same_path_counted_separately(self):
        v2 = {
            "openapi": "3.0.0",
            "paths": {
                "/v2/members": {
                    "get": {"operationId": "listMembers", "summary": "List"},
                    # POST removed
                },
            },
        }
        diff = extract_api_diff(SPEC_V1, v2)
        removed_methods = {(c.path, c.method) for c in diff.removed}
        # POST /v2/members removed, also /v2/members/{id} and /v2/auth/login removed
        assert ("/v2/members", "post") in removed_methods

    def test_empty_before_spec_treats_all_as_added(self):
        diff = extract_api_diff({"openapi": "3.0.0", "paths": {}}, SPEC_V1)
        assert len(diff.added) == 5  # 5 operations total in SPEC_V1

    def test_endpoint_change_has_operation_id(self):
        diff = extract_api_diff(SPEC_V1, SPEC_V2_ADD_ENDPOINT)
        added = diff.added[0]
        assert added.operation_id == "bulkImport"
