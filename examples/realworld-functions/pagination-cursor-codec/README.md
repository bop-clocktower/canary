# Example: Pagination Cursor Codec

Tests a paired `encodeCursor` / `decodeCursor` that serialize pagination
state into an opaque, tamper-evident cursor string.

This is a **TypeScript unit** example — no HTTP, no DOM, no fixtures. A
pagination cursor looks trivial — just base64-encode the state — until a
client edits the string. This example pins a checksum into the cursor so
`decodeCursor` can prove the payload wasn't tampered with, and pins `id` /
`createdAt` to integers (rather than a generic `Record<string, unknown>`)
so the contract stays testable. The tamper case (3) is the whole point:
most naive cursor implementations skip integrity checking entirely.

## Prompt

```text
Generate Vitest unit tests for encodeCursor and decodeCursor functions.

Signature:
    function encodeCursor(state: { id: number; createdAt: number }): string
    function decodeCursor(cursor: string): { id: number; createdAt: number }

encodeCursor JSON-serializes `state`, appends a checksum, and base64url-encodes
the result into an opaque pagination cursor. decodeCursor reverses this: it
base64url-decodes the cursor, verifies the checksum, and returns the original
state — rejecting any tampered or malformed input.

Rules:
  - `id` and `createdAt` must both be integers (Number.isInteger). encodeCursor
    throws a RangeError if either is not an integer.
  - decodeCursor throws a RangeError if the checksum does not match (tampered
    payload), if the input is not valid base64url, if the input is empty, or
    if the decoded payload is too short to contain both a state and a checksum
    (truncated cursor).
  - decodeCursor(encodeCursor(state)) returns a value deep-equal to the
    original state for every valid integer-keyed input.

Cover these cases:
  1. Round-trip preserves exact state — decodeCursor(encodeCursor({ id: 42, createdAt: 1700000000000 })) → { id: 42, createdAt: 1700000000000 }
  2. Round-trip with id: 0 — decodeCursor(encodeCursor({ id: 0, createdAt: 1700000000000 })) → { id: 0, createdAt: 1700000000000 }
  3. Tampered payload — flip one character of a valid encodeCursor(...) output → decodeCursor throws RangeError
  4. Malformed base64 — decodeCursor("not-valid-base64!!!") → throws RangeError
  5. Empty string — decodeCursor("") → throws RangeError
  6. Truncated cursor — a syntactically valid base64url string too short to contain a payload plus checksum → decodeCursor throws RangeError
  7. Non-integer id/createdAt at encode time — encodeCursor({ id: 1.5, createdAt: 1700000000000 }) → throws RangeError
  8. Number.MAX_SAFE_INTEGER values round-trip — decodeCursor(encodeCursor({ id: Number.MAX_SAFE_INTEGER, createdAt: Number.MAX_SAFE_INTEGER })) → { id: Number.MAX_SAFE_INTEGER, createdAt: Number.MAX_SAFE_INTEGER }
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/pagination-cursor-codec
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `frontend_unit` (Vitest hint)
2. Pick `vitest` from the framework registry
3. Write a `paginationCursorCodec.test.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight `it()` / `test()` cases. The tamper case is the one that proves the
checksum is load-bearing, not decorative:

```typescript
it('rejects a tampered cursor', () => {
  const cursor = encodeCursor({ id: 42, createdAt: 1700000000000 })
  const tampered = cursor.slice(0, -1) + (cursor.at(-1) === 'A' ? 'B' : 'A')
  expect(() => decodeCursor(tampered)).toThrow(RangeError)
})

it('round-trips Number.MAX_SAFE_INTEGER values', () => {
  const state = { id: Number.MAX_SAFE_INTEGER, createdAt: Number.MAX_SAFE_INTEGER }
  expect(decodeCursor(encodeCursor(state))).toEqual(state)
})
```

## Running the generated test

```bash
npm install -D vitest
npx vitest run tests/generated/paginationCursorCodec.test.ts
```

The tests import `encodeCursor`/`decodeCursor` stubs — paste your real
implementation or point the import at your module before running.

## Variations to try

- **Property check:** ask Canary for a test asserting
  `decodeCursor(encodeCursor(s))` round-trips across a table of random
  integer `id`/`createdAt` pairs, including negative and large values
- **Multi-byte tamper:** extend case 3 to flip a byte in the middle of the
  payload rather than the last character, and confirm the checksum still
  catches it
- **Versioned cursor:** add a `version` byte to the encoded payload and ask
  Canary for a test that rejects cursors from a future/unknown version

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
