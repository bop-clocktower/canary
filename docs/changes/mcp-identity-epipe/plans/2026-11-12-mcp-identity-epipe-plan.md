# mcp-identity EPIPE flake (#1611): reproduction, root cause, deflake

Refs #1611. Provenance: cicd-fleet lane, fleet-command run fc1112b, fork option
F2-A (reproduce first; deflake only on a confirmed root cause; no retry, skip,
loosened assertion, or generic EPIPE tolerance in `runCapture`).

## Symptom

One full `npm test` from `ts/` (macOS, Node 22.23.2) threw
`Error: spawnSync <node> EPIPE` from `runCapture`
(`ts/test/subprocess-testkit.ts`) via `runHook` in
`ts/test/mcp-identity.test.ts`, test "canary-mcp call is not nagged". The file
passed 3 of 3 times alone. No CI occurrence was found.

## Corrected hypothesis

The issue guessed that the hook exits before it reads stdin. The hook does read
stdin first: `readFileSync(0)` runs before any `process.exit`. The real question
was why the read could end without consuming the payload.

## Reproduction attempts

All runs used throwaway instrumentation in the session scratchpad. None of it is
committed. The harness ran `spawnSync(node, [hook], { input })` from worker
threads, with optional CPU-burner threads, and recorded `error.code`, `status`,
`signal`, `stdout`, and `stderr` for each failure.

| Scenario                                                 | Runs | Failures            |
| -------------------------------------------------------- | ---: | ------------------- |
| Real payload (~45 B), 8 workers, idle                    |  800 | 0                   |
| Real payload, 10 workers + 6 CPU burners                 | 1000 | 0                   |
| Real payload, 32 workers + 10 CPU burners                | 4800 | 0                   |
| 200 KB payload, 16 workers + 4 burners (hook as shipped) | 2400 | 715 EPIPE, status 0 |
| Same, instrumented hook logging the read error           |  800 | 318, all `EAGAIN`   |
| 200 KB payload, single thread, no load                   |  100 | 11 EPIPE            |
| Async `spawn`, payload written 300 ms after spawn        |   10 | 10 (silent exit 0)  |

Each failure had the same shape: `status: 0`, `signal: null`, empty stdout, and
an EPIPE on the parent's write. Logging from the instrumented hook showed that
`readFileSync(0)` threw `EAGAIN: resource temporarily unavailable`. A probe on
an inherited fd 3 showed the stdin socket in O_NONBLOCK mode at that moment. The
hook's fail-open `catch` then exited 0 silently, and the parent's pending write
hit the closed socket.

The large payload and the delayed write both force the same condition: the hook
reads before the payload has arrived. With the real 45-byte payload, that
condition needs the parent to stall for longer than a node startup (about 40 ms)
between spawn and write. Full-suite contention can cause that stall, which
explains the single occurrence. The real-payload stress never hit it in 6600
runs. The delayed-write scenario reproduces it deterministically.

## Root cause

`.harness/hooks/prefer-first-party-mcp.js` read stdin with `readFileSync(0)`. A
synchronous read on a non-blocking stdin socket throws EAGAIN when no data is
buffered yet, so it does not wait for the payload. The hook treated that
exception as "no stdin" and exited 0 with no output.

That has two effects:

1. **Loud (the flake).** The parent's write fails with EPIPE, and `runCapture`
   rethrows it.
2. **Quiet (worse).** A hook that never saw its input still exits 0 with empty
   stdout. The "not nagged" assertions check for exactly that, so they can pass
   vacuously. In real use, a third-party MCP call whose payload arrives late
   silently loses its reminder.

Not verified, and deferred: which layer sets O_NONBLOCK on the child's end of
the socket. Probes from a libuv-spawned grandchild always read the flag as
cleared, because libuv clears O_NONBLOCK on stdio fds 0 to 2 in the child it
spawns. Only the fd-3 probe saw it set. The fix does not depend on the answer,
since the stream API waits in both modes.

## Decision

Deflake by removing the nondeterminism in the hook, not in the test kit. The
hook now reads stdin to EOF through `process.stdin` (async iteration), which
waits for data whether or not the socket is blocking. `runCapture` is unchanged
and still throws on EPIPE. A future EPIPE stays a loud, diagnosable failure
rather than a vacuous pass.

TDD: `ts/test/hook-stdin-eof.test.ts` sends the payload in two halves and holds
the second half back for 1 s. Against the shipped hook, both cases failed. The
hook exited on the partial payload: the third-party call was not nagged, and the
trusted call quit early. With the fix, both pass.

## Verification

- New test: red on the unfixed hook (2/2 failing), green with the fix.
- Stress harness on the fixed hook: 200 KB payload, 16 workers + 4 burners, 2400
  runs, 0 failures. Real payload, 32 workers + 10 burners, 4800 runs, 0
  failures. Control on the unfixed hook in the same session: 670 of 2400 failed.
- The three hook test files (`hook-stdin-eof`, `mcp-identity`,
  `js-hooks-behavior`) passed 25 of 25 consecutive runs.
- Full `npm test` from `ts/` passed 6 of 6 runs (368 files, 7483 tests, 0
  EPIPE).
- `npm run build`, `npm run typecheck`, and `npm run format:check` are green.
  `harness validate` and `harness check-deps` are green. The perf ratchet is OK
  (197 violations against a baseline of 201).

## Assumptions

- The single local occurrence was this mechanism under suite load. The real
  45-byte payload never reproduced the EPIPE on demand. The same code path did
  reproduce it on demand with a late or large payload.
- Claude Code always pipes hook stdin, so a hook that waits for EOF does not
  hang. A TTY stdin (running the hook by hand) now waits for EOF too.

## Out of scope (tracked separately)

Seven other hooks in `.harness/hooks/` read stdin the same way, and so do
several CLI readers (`git grep -n "readFileSync(0"`). They have the same latent
EAGAIN-then-fail-open shape. This change does not touch them; they are filed as
a follow-up issue.
