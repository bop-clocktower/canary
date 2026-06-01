"""Schemathesis spike runner.

Starts the FastAPI checkout app in-process via ASGI transport,
runs Schemathesis against it, and prints a structured report.
"""

import json
import sys
from io import StringIO

import schemathesis
from schemathesis.specs.openapi.stateful import APIWorkflow

from app import app

# ---------------------------------------------------------------------------
# Load schema from live ASGI app (no server process needed)
# ---------------------------------------------------------------------------

schema = schemathesis.from_asgi("/openapi.json", app=app)

# ---------------------------------------------------------------------------
# Run tests and collect results
# ---------------------------------------------------------------------------

findings = []
total_cases = 0
errors = []
failures = []

@schema.parametrize()
def test_api(case):
    global total_cases
    total_cases += 1

    # Inject a valid token so auth failures don't dominate the output
    case.headers = case.headers or {}
    case.headers["Authorization"] = "Bearer spike-token"

    response = case.call_asgi(app=app)

    try:
        case.validate_response(response)
    except schemathesis.exceptions.CheckFailed as e:
        failures.append({
            "path": case.path,
            "method": case.method,
            "status_code": response.status_code,
            "body": case.body,
            "error": str(e),
        })


if __name__ == "__main__":
    import pytest

    # Run via pytest to capture schemathesis output
    result = pytest.main(
        [__file__, "-x", "--tb=short", "-q",
         "--schemathesis-base-url=http://localhost",
         ],
        plugins=[],
    )
    sys.exit(result)
