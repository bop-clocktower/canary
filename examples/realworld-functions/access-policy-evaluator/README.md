# Example: Access Policy Evaluator

Tests an `evaluate_policy` function that performs a simple RBAC check —
given a user's roles, a requested action, and a policy map, it returns
`{ allowed, matched_role }`.

This is a **Python unit** example. RBAC logic is deceptively simple to
implement and easy to get wrong at the edges: wildcard grants, role
ordering, roles absent from the policy entirely. The prompt encodes all
eight of those edges so the generated test suite actually exercises the
contract rather than just the happy path.

## Prompt

```text
Generate pytest unit tests for an evaluate_policy function.

Signature:
    def evaluate_policy(
        user_roles: list[str],
        action: str,
        policy: dict[str, list[str]],
    ) -> dict:

The function performs a simple RBAC check. `policy` maps role names to the
list of actions that role is allowed to perform. The function checks whether
any of the user's roles grants the requested action and returns:
  {
    "allowed": bool,
    "matched_role": str | None,   # first matching role, or None if denied
  }

Matching rules:
  - The wildcard action "*" in a role's action list grants that role access
    to any action.
  - If multiple roles would match, the first match in user_roles order wins
    (matched_role reflects that role).
  - An empty user_roles list is always denied.
  - An action not present in any role's list is denied.

Cover these cases:
  1. Single role, exact action match → allowed, matched_role set
  2. Single role, action not in policy → denied, matched_role None
  3. Wildcard "*" grants access → allowed, matched_role is the wildcard role
  4. Multiple roles, first role matches → allowed, matched_role is first role
  5. Multiple roles, only second role matches → allowed, matched_role is second
  6. Empty user_roles → denied
  7. Role exists in policy but action list is empty → denied
  8. Role not present in policy at all → denied
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/access-policy-evaluator
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `api` (pytest hint, structured dict I/O)
2. Pick `pytest` from the framework registry
3. Write a `test_evaluate_policy.py` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight test functions covering the full decision matrix. The wildcard and
role-ordering cases are where most RBAC implementations fail:

```python
def test_wildcard_grants_any_action():
    policy = {"admin": ["*"], "viewer": ["reports:read"]}
    result = evaluate_policy(["admin"], "anything:delete", policy)
    assert result["allowed"] is True
    assert result["matched_role"] == "admin"

def test_first_matching_role_wins():
    policy = {"editor": ["posts:write"], "viewer": ["posts:read"]}
    result = evaluate_policy(["editor", "viewer"], "posts:write", policy)
    assert result["matched_role"] == "editor"
```

## Running the generated test

```bash
pip install pytest
pytest tests/generated/test_evaluate_policy.py -v
```

## Variations to try

- **Role inheritance:** extend the policy format to support
  `"extends": ["base-role"]` and ask Canary to cover inherited grants
- **Deny rules:** add a `denied_actions` key per role that overrides
  allow entries — useful for "everyone except admins can't delete"
- **Audit log:** change the return to include `{ allowed, matched_role,
  checked_roles: list[str] }` and assert the full evaluation trace

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
