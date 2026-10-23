/**
 * Business exit signal. Thrown from a handler to carry an exit code the way
 * Python's `typer.Exit(code)` did; the runner catches it to read the code.
 *
 * Lives in a leaf module with no imports (#1377) so a CLI can throw it without
 * pulling `guardian/cli.ts` -- and its `node:child_process` closure -- into its
 * import graph. ADR 0041 requires gen-data's closure to stay model- and
 * spawn-free; `ts/test/gen-data-model-free.test.ts` enforces it.
 * `guardian/cli.ts` and `cli-common.ts` re-export this class, so the whole
 * command tree still throws ONE `CliExitError`.
 */
export class CliExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = 'CliExitError';
  }
}
