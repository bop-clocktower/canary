# Example: Vitest Unit — Validation Helper

Generates a pure-function unit test for a small validation helper. No browser,
no HTTP — fastest type of test Canary produces.

## Prompt

```text
Generate a Vitest unit test for a function `validateEmail(input: string):
{ ok: boolean; error?: string }`.

Rules the function implements:
- Returns { ok: true } for any string matching the basic shape
  "<local>@<domain>.<tld>" with local and domain non-empty and tld at least
  2 characters.
- Returns { ok: false, error: "empty" } if input is "" or whitespace-only.
- Returns { ok: false, error: "invalid" } for anything else (missing @, no
  tld, etc.).

Cover at minimum:
- valid: "user@example.com", "a.b+c@sub.example.co.uk"
- empty: "", "   "
- invalid: "user@", "user@example", "@example.com", "user.example.com",
  "user@@example.com"

Use describe/it blocks. Don't use snapshot testing — assertions only.
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/vitest-unit-validation
cat prompt.txt        # the scenario
```

Then, in Claude Code, generate the test from the scenario:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary classifies as `unit`, picks `vitest`, writes a `*.test.ts` file.

## Running the generated test

```bash
npm install -D vitest
canary run tests/generated/<filename>.test.ts vitest
```

The test will fail because `validateEmail` doesn't exist yet — this example is
**test-first**. To complete the loop:

1. Implement `validateEmail` in a source file matching what the test imports
2. Re-run the test
3. Iterate

This pattern (write tests against a contract, then implement) is what the
`@canary-test-author` plugin agent shines at — see
[Plugin Agents](../../docs/wiki/Plugin-Agents.md).

## What to expect

Roughly:

```typescript
import { describe, it, expect } from 'vitest';
import { validateEmail } from '../src/validateEmail';

describe('validateEmail', () => {
  describe('valid inputs', () => {
    it.each(['user@example.com', 'a.b+c@sub.example.co.uk'])(
      'accepts %s',
      (input) => {
        expect(validateEmail(input)).toEqual({ ok: true });
      },
    );
  });

  describe('empty inputs', () => {
    it.each(['', '   '])('rejects "%s" as empty', (input) => {
      expect(validateEmail(input)).toEqual({ ok: false, error: 'empty' });
    });
  });

  describe('invalid inputs', () => {
    it.each([
      'user@',
      'user@example',
      '@example.com',
      'user.example.com',
      'user@@example.com',
    ])('rejects %s as invalid', (input) => {
      expect(validateEmail(input)).toEqual({ ok: false, error: 'invalid' });
    });
  });
});
```

## Variations to try

- **Property-based:** rephrase the prompt to use fast-check
- **More edge cases:** Unicode local parts, very long inputs, IPv4-as-domain
- **Different framework:** Ask for Jest instead of Vitest — Canary's framework
  advisor agent will explain when each makes sense

## See also

- [Getting Started → generating tests](../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../docs/wiki/Writing-Good-Prompts.md)
- [Plugin Agents](../../docs/wiki/Plugin-Agents.md)
