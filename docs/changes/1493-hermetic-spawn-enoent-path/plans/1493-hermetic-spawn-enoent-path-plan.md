# Plan: make the spawnExec exit-127 test hermetic (#1493)

Deflake from cicd-fleet run fc1026b. Pipeline: harness-debugging (investigate,
analyze, hypothesize, fix with revert-and-fail).

## Root cause

`spawnExec` in `ts/src/analysis/rewind/workspace.ts` spawns with
`env: { ...process.env, ...opts.env }`. The test
`spawnExec > reports a command that cannot be spawned as exit 127` passed
`env: {}`, so the lookup for `canary-rewind-no-such-binary` walked the host's
real `PATH`. When a `PATH` entry exists but can't be traversed (the reporting
host had `/usr/local/bin` as `drwx------ root`), the lookup fails with `EACCES`
instead of `ENOENT`. `res.code` is still 127. Only the `/ENOENT/` message check
depended on the host.

## Reproduction of the host dependency

On this host `/usr/local/bin` is now `drwxr-xr-x`, so the unmodified test
passes. To show the dependency anyway, prepend a mode-000 directory to `PATH`:

```sh
mkdir locked1493 && chmod 000 locked1493
PATH="$PWD/locked1493:$PATH" npx vitest run test/rewind-workspace.test.ts -t "cannot be spawned"
# before fix: Tests 1 failed. AssertionError: "spawn canary-rewind-no-such-binary EACCES"
```

## Fix

The test only changes: it passes `env: { PATH: dir }`, where `dir` is the
per-test empty `mkdtemp` directory that `useTmpDir()` already creates and
removes. The binary lookup sees only an empty, traversable directory, so the
miss is always `ENOENT`. The `/ENOENT/` assertion stays as strict as before.

`spawnExec` already merges `opts.env` over `process.env`, so the test can
control `PATH` without any product change.

## Evidence

- Revert-and-fail: with the fix reverted, under a hostile PATH the result is 1
  failed / 21 passed. With the fix restored, 22/22 pass.
- Repeated runs of `npx vitest run test/rewind-workspace.test.ts`:
  - with a mode-000 dir first on PATH: **20/20 passed**
  - with the host PATH: **20/20 passed**
- Gates (from `ts/`, Node 22.23.2): build 0, typecheck 0, format:check clean,
  `npm test`: 347/347 files, 6691 passed, 2 skipped (6693).

## Remediation actions / assumptions made

- Fixed the test, not the product. `spawnExec`'s env merge is correct. A missing
  command still maps to exit 127 with the spawn error message.
- Reused the per-test temp dir as `PATH`, instead of making a second temp dir.
  It is empty in this test (nothing is written to it), and `useTmpDir()`'s
  `afterEach` already cleans it up.
- Did not loosen the regex, skip, or retry. The assertion is unchanged.
- The reporting host's `/usr/local/bin` permissions have since changed, so the
  original failure was reproduced synthetically (mode-000 PATH entry) rather
  than on the original host state.
- The debug session file is written under the gitignored `.harness/debug/`, so
  it stays local and isn't committed.
