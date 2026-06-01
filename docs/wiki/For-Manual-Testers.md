# Canary for Manual Testers

You've spent years finding bugs, writing test cases, and knowing
exactly what "this should do X but it does Y" looks like in
practice. That skill set is exactly what Canary needs from you.

Canary handles the coding. You handle the thinking.

## The Mental Model

In manual testing, you write test cases: a description of the
steps to take and the expected outcome. In Canary, you do the
same thing — you just describe it in plain English, and Canary
writes the code.

| Manual Testing | With Canary |
| --- | --- |
| Write a test case in a spreadsheet | Describe the test in a prompt |
| Execute the test by hand | Canary generates and can run it |
| Note "Expected: 200, Actual: 500" | Canary asserts the expected outcome |
| File a bug if it fails | Canary flags the failure for you |

You don't need to know Python, JavaScript, or any testing
framework to use Canary. If you can describe what you're testing
clearly, Canary can write the test.

## Your First Test — Step by Step

Let's say you want to test that a user can log in successfully.
Here's how you'd think through it:

1. **What are you testing?** The login feature.
2. **What's the action?** Submitting valid credentials.
3. **What's the expected outcome?** The user is redirected to
   the dashboard.

Turn that into a prompt:

```text
Test that submitting valid credentials on the login page
redirects the user to the dashboard
```

Run it — in Claude Code:

```text
/canary-write-test  Test that submitting valid credentials on the
login page redirects the user to the dashboard
```

Canary classifies this as an end-to-end UI test and generates
a Playwright test for you.

## Describing Tests You Know Well

You've probably tested dozens of scenarios by hand. Pick one
you know inside and out — that familiarity makes you the best
person to prompt Canary on it, because you already know:

- What the expected behavior is
- What a failure looks like
- What edge cases exist

For example, a manual tester who has tested a search feature
hundreds of times can prompt:

```text
Test that searching for an empty string shows a "no results"
message rather than an error
```

That's a much stronger prompt than a developer who's never
clicked through the search feature would write.

## Types of Tests Canary Can Generate

You don't need to know what these mean technically — just
pick the one that sounds closest to what you're testing:

- **End-to-end (E2E):** Testing a user flow in a browser.
  "A user goes to X, clicks Y, sees Z."
- **API:** Testing what a server returns when called.
  "When we send this request, we expect this response."
- **Unit:** Testing a single function or calculation.
  "Given this input, the output should be X."
- **Performance/Load:** Testing how the system handles traffic.
  "Under N users, the page should load in under X seconds."

If you're not sure which type applies, just describe what you
want to test. Canary will classify it — and if it guesses wrong,
you can tell it which type you meant and try again.

## What to Do with the Generated Test

Canary writes the test; you review it. Here's a simple checklist:

1. **Does it test what I asked?** Read the assertions — do they
   match the expected behavior you described?
2. **Are there any placeholder values?** Look for things like
   `"YOUR_URL_HERE"` or `"TODO"` — fill those in.
3. **Does it pass?** Run it. If it fails, check whether the
   failure is in the test or in the feature being tested.
4. **Is it worth keeping?** If yes, promote it to the committed
   suite. If not, discard it and regenerate with a better prompt.

You don't need to understand every line of the generated code
to evaluate whether the test is correct. Read the assertions
(the parts that say "expect X to equal Y") — those are the
parts that matter.

## Tips from Manual Testing That Apply Here

- **Be specific.** "Test the login page" is too vague. "Test
  that logging in with an expired password shows an error
  message" is much better.
- **Test one thing at a time.** Manual test cases that cover
  one scenario are better than tests that cover five. The same
  is true for Canary prompts.
- **Include the expected outcome.** "The user sees the dashboard"
  or "the API returns 201 with the order ID" — Canary uses this
  to write the assertion.
- **Edge cases matter.** If you've found a bug in a weird edge
  case before, that's exactly the kind of test worth generating.
  Those tests are the most valuable to have automated.

## When Canary Gets It Wrong

Canary sometimes misclassifies a test type or generates a test
that's close but not quite right. This is normal — it's a first
draft, not a final product.

If the type is wrong, tell it explicitly:

```text
/canary-write-test  Test that the cart persists after page refresh
-- this is an end-to-end browser test
```

If the generated test is almost right but misses something,
either adjust your prompt and regenerate, or (for small fixes)
edit the file directly before promoting it.

See [Writing Good Prompts](Writing-Good-Prompts.md) for detailed
guidance on getting it right the first time.

## You're Not Replacing Yourself

Generating a test with Canary still requires you to:

- Know what the correct behavior is
- Review whether the test actually checks that behavior
- Decide if the test is worth keeping

Canary speeds up the work of writing the code. It doesn't
replace the judgment of someone who understands the product.
That's you.
