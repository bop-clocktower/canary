# Example: Playwright E2E — Login Flow

Generates a browser-level Playwright test covering a happy-path and one
error-path of a login form.

## Prompt

```text
Generate a Playwright test for a login page at https://example.com/login.
Cover two scenarios in the same file:

1. Happy path: user enters "user@example.com" / "correct-horse-battery-staple",
   clicks the Sign In button, ends up on /dashboard.

2. Error path: user enters the same email with "wrong-password", clicks
   Sign In, sees an error message containing "Invalid credentials", and
   the URL stays on /login.

Use page object model where it adds clarity but don't over-engineer.
Assertions should be specific (URL, visible text), not loose (just "page
loaded"). No screenshots, no video.
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/playwright-e2e-login
oracle generate "$(cat prompt.txt)"
```

Oracle will:

1. Classify the request as `e2e_ui`
2. Pick `playwright` from the framework registry
3. Write a `*.spec.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Oracle should produce

The exact code varies between runs and providers, but expect roughly:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Login flow', () => {
  test('redirects to /dashboard on valid credentials', async ({ page }) => {
    await page.goto('https://example.com/login');
    await page.fill('input[name="email"]', 'user@example.com');
    await page.fill('input[name="password"]', 'correct-horse-battery-staple');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('shows error on invalid credentials', async ({ page }) => {
    await page.goto('https://example.com/login');
    await page.fill('input[name="email"]', 'user@example.com');
    await page.fill('input[name="password"]', 'wrong-password');
    await page.click('button[type="submit"]');
    await expect(page.getByText(/invalid credentials/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});
```

## Running the generated test

```bash
npm install -D @playwright/test
npx playwright install
oracle run tests/generated/<filename>.spec.ts playwright
```

The test will fail against `example.com` (no real login form). To adapt:

- Replace the URL with your app's actual login page
- Update selectors (`input[name="email"]`, etc.) to match your DOM
- Replace the credentials with a test-only account

## Variations to try

- **Smaller scope:** drop the error path and ask for just the happy path
- **Bigger scope:** add a forgot-password flow as a third scenario
- **Different framework:** rephrase the prompt to ask for a Cypress version
  (Oracle's framework advisor agent can recommend; see
  [Plugin Agents](../../docs/wiki/Plugin-Agents.md))

## See also

- [CLI Reference → `oracle generate`](../../docs/wiki/CLI-Reference.md)
- [Writing Good Prompts](../../docs/wiki/Writing-Good-Prompts.md)
