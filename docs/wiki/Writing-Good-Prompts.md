# Writing Good Prompts

The quality of Canary's output depends directly on how well
you describe what you want. This guide shows you the difference
between prompts that produce vague tests and prompts that
produce useful ones.

## The Core Principle

A good prompt answers three questions:

1. **What are you testing?** (feature, endpoint, component)
2. **What action or input triggers the behavior?**
3. **What is the expected outcome?**

Vague answers to any of these produce vague tests.

## Anatomy of a Good Prompt

```text
[Test type, if you know it]: [action] on [target]
with [input] should [expected outcome]
```

Examples:

- `API test: POST /v1/orders with a valid payload returns 201`
- `E2E test: logging in with an expired password shows an error`
- `Unit test: calculate_discount with a 20% discount on $100
  returns $80`

You don't need to use this exact format. Just make sure all
three pieces are in there.

## Vague vs. Specific — Side by Side

| Vague | Specific |
| --- | --- |
| "Test the login page" | "Test that entering an invalid email on the login page shows a validation error below the field" |
| "Test the API" | "API test: GET /v1/users/{id} returns 404 when the user doesn't exist" |
| "Test the search" | "Test that searching for a string with special characters (%&<>) returns results without an error page" |
| "Load test the checkout" | "Load test: 100 concurrent users hitting POST /v1/checkout for 2 minutes, p95 latency under 500ms" |

## By Test Type

### API Tests

Include:

- HTTP method (GET, POST, PUT, DELETE)
- Full path (e.g., `/v1/orders`)
- Request payload or params (if any)
- Expected status code
- Expected response shape (if you care about the body)

**Good example:**

```text
API test: POST /v1/orders with
{"product_id": "abc", "quantity": 2} returns 201 and a
response body containing an "order_id" field
```

### End-to-End (Browser/UI) Tests

Include:

- Starting state (which page, what's logged in)
- The user action (click, fill in, submit)
- The expected result (what the user sees next)

**Good example:**

```text
E2E test: on the checkout page, clicking "Place Order" with
no items in the cart shows a "Your cart is empty" message
and does not navigate away from the page
```

### Unit Tests

Include:

- The function or class name (if you know it)
- The input
- The expected output

**Good example:**

```text
Unit test: the calculate_tax function with a subtotal of 100
and a tax rate of 0.08 returns 8.0
```

### Performance Tests

Include:

- The endpoint or feature under load
- Number of concurrent users or requests per second
- Duration
- The threshold that should not be exceeded

**Good example:**

```text
Load test: 200 virtual users hitting GET /v1/products for
5 minutes, p95 response time under 300ms, error rate
under 1%
```

## Helping Canary Pick the Right Type

Canary classifies your prompt automatically. If it picks the
wrong type, add the type explicitly:

```text
/canary-write-test  E2E test: ...
/canary-write-test  API test: ...
/canary-write-test  Unit test: ...
/canary-write-test  Load test: ...
```

You can also use `canary recommend` to preview Canary's
classification without generating (deterministic, no LLM call):

```bash
canary recommend "test the login"
```

If Canary's recommendation doesn't match your intent, refine
the prompt before running the full generation.

## When to Regenerate vs. Edit

After Canary generates a test, you might find small things to
fix. Use this rule:

- **1-2 small fixes** (a wrong URL, a missing import): edit
  the file directly.
- **3+ issues** or a wrong test type: regenerate with a better
  prompt. Fixing many issues by hand takes longer than writing
  a better prompt, and the next time you need a similar test
  you'll have a prompt that works.

## Prompts for Edge Cases

Edge cases are where Canary shines, because they're the tests
that are tedious to write by hand but easy to describe:

```text
API test: POST /v1/orders with a negative quantity returns 400
with an error message about invalid quantity
```

```text
E2E test: submitting the registration form with an email
that's already registered shows "email already in use" and
keeps the other form fields populated
```

```text
API test: GET /v1/users with an expired auth token returns
401, not 500
```

These tests are high-value because they protect against
regressions in error handling — exactly the kind of thing
that gets broken when someone touches the happy path code.

## Prompts for Things You've Manually Tested Before

If you've tested something by hand many times, you already
know the edge cases, the expected outcomes, and the gotchas.
Turn that knowledge into prompts:

Think: "What would I write in the test case section of a
test plan?" Then write that as an Canary prompt.

Your manual testing expertise makes you better at writing
Canary prompts than someone who has never used the feature.
Use it.
