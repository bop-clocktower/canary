# Example: Path Normalizer (POSIX containment)

Tests a `resolveWithin` function that resolves a relative POSIX path against a
base directory and refuses any result that escapes it — the check between a
user-supplied file name and a path traversal.

This is a **Vitest unit** example, and it is the catalog's one function where
the _rejection_ path is the whole point. Most examples reject malformed input as
a side rule; here, deciding what counts as "outside" is the contract. The
surface is deliberately bounded: no symlinks, no Windows paths, no URL or
percent-encoding, no filesystem access. Those each fork the semantics, and every
fork would have to be pinned before two implementations could agree.

Three assertions naive implementations miss. Case 6 is the **prefix trap** — the
best-known defect in this exact function.
`"/srv/app-evil/x".startsWith( "/srv/app")` is `true`, so a string-prefix
containment check accepts a sibling directory whose name merely begins with the
base's. Containment has to compare segments. Cases 4 and 5 are the **off-by-one
boundary**: `a/b/../..` lands exactly on the base (inside), while one more `..`
lands on its parent (outside); an implementation that treats "equal to base" as
escaping fails case 4, and one that counts `..` against the target's depth
instead of the base's fails case 5. Case 7 pins **final-path judgment** —
`../app/x` leaves the base and comes back, and is accepted. Without that rule a
prompt leaves it ambiguous, and two reasonable implementations disagree on it.

## Prompt

```text
Generate Vitest unit tests for a path-containment function.

Signature:
    function resolveWithin(base: string, target: string): string

The function resolves a relative POSIX path against a base directory and
returns the normalized absolute result, refusing any result that lands
outside the base. It is the check that stands between a user-supplied file
name and a path traversal.

Rules:
  - `base` must be an absolute path (starts with "/") that is already
    normalized: no "." or ".." segments. A trailing "/" is ignored, and "/"
    alone is a valid base. Anything else throws a RangeError.
  - `target` must be a relative path (does not start with "/"). An absolute
    target throws a RangeError — it would discard the base entirely.
  - Either path containing a NUL character ("\0") throws a RangeError.
  - Split on "/". Empty segments (from "//" or a trailing "/") and "."
    segments are dropped. A ".." segment removes the previous segment; at the
    filesystem root it does nothing, because "/.." is "/".
  - Containment is judged on the FINAL path only, and SEGMENT by segment: the
    result is inside `base` when its leading segments equal all of base's
    segments. A plain string-prefix check is wrong — "/srv/app-evil" starts
    with the string "/srv/app" but is not inside it.
  - A path that leaves the base and comes back ("../app/x" against
    "/srv/app") is accepted, because only the final path is judged.
  - A result outside `base` throws an Error whose message contains
    "escapes base". The base itself counts as inside.
  - The result is "/" followed by the segments joined with "/", with no
    trailing slash. The function is pure.

Cover these cases (hand-verified against the rules, base "/srv/app" unless
stated):
  1. Plain descent — resolveWithin("/srv/app", "docs/readme.md")
     -> "/srv/app/docs/readme.md"
  2. "." and empty segments collapse — resolveWithin("/srv/app", "./a//b/./c")
     -> "/srv/app/a/b/c"
  3. ".." inside the base — resolveWithin("/srv/app", "a/b/../c")
     -> "/srv/app/a/c"
  4. Back to the base exactly, which is inside —
     resolveWithin("/srv/app", "a/b/../..") -> "/srv/app"
  5. One ".." too many escapes — resolveWithin("/srv/app", "a/b/../../..")
     -> throws "escapes base" (the result would be "/srv")
  6. The prefix trap — resolveWithin("/srv/app", "../app-evil/x")
     -> throws "escapes base" (the result "/srv/app-evil/x" shares the
     string prefix "/srv/app", so a startsWith check wrongly accepts it)
  7. Leave and come back — resolveWithin("/srv/app", "../app/x")
     -> "/srv/app/x"
  8. Empty target and trailing slashes — resolveWithin("/srv/app", "")
     -> "/srv/app"; resolveWithin("/srv/app/", "x") -> "/srv/app/x";
     resolveWithin("/srv/app", "a/b/") -> "/srv/app/a/b"
  9. Root base: ".." stops at the root — resolveWithin("/", "../../etc")
     -> "/etc" (nothing can escape "/")
  10. Malformed input throws RangeError — an absolute target
      resolveWithin("/srv/app", "/etc/passwd"); a relative base
      resolveWithin("srv/app", "x"); an unnormalized base
      resolveWithin("/srv/../app", "x"); and a NUL byte
      resolveWithin("/srv/app", "a\0b")
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/path-normalizer-posix
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `frontend_unit` (pure string function, TS signature)
2. Pick `vitest` from the framework registry
3. Write a `resolve-within.test.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Ten tests covering normalization, the containment boundary and the rejection
paths. The prefix trap, the base-boundary pair and the leave-and-return case are
the ones that separate a containment-aware suite from a plausible-looking one:

```typescript
it('compares segments, not string prefixes', () => {
  // "/srv/app-evil/x" starts with the string "/srv/app" -- a startsWith check
  // accepts it. It is a sibling directory, not a child.
  expect(() => resolveWithin('/srv/app', '../app-evil/x')).toThrow(
    /escapes base/,
  );
});

it('treats the base itself as inside, and its parent as outside', () => {
  expect(resolveWithin('/srv/app', 'a/b/../..')).toBe('/srv/app');
  expect(() => resolveWithin('/srv/app', 'a/b/../../..')).toThrow(
    /escapes base/,
  );
});

it('judges only the final path', () => {
  expect(resolveWithin('/srv/app', '../app/x')).toBe('/srv/app/x');
});
```

## Running the generated test

```bash
npm install -D vitest
npx vitest run tests/generated/resolve-within.test.ts
```

## Variations to try

- **Transient escape is rejected:** change the rule so any `..` that steps above
  the base throws immediately, even if later segments return. Ask which case
  flips — only case 7 should, and a suite that notices nothing else changed is
  the evidence the rest is pinned
- **Against `node:path`:** ask for a second implementation on
  `path.posix.resolve` plus `path.posix.relative`, and a test asserting both
  agree on all ten cases — then find the input where `relative(...)` starting
  with `..` is the only thing standing between them and the prefix trap
- **Symlinks in scope:** add an injected `realpath` and ask what new cases are
  needed; this is where the bounded surface ends, so expect the case list to
  grow quickly

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
