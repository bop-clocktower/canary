/**
 * Canary Test Executor — a framework-agnostic execution engine.
 *
 * Faithful TypeScript port of `agent/core/executor.py`. Executes generated
 * test files using the CLI command declared for each supported framework.
 *
 * Python→TS nuances:
 *   - **subprocess → child_process**: Python's `subprocess.run(cmd, ...)` maps
 *     to Node's `spawnSync(cmd[0], cmd.slice(1), ...)`. `cmd[0]` is the program
 *     and the rest are argv, so the file path (already a single token after
 *     `{file}` substitution) never gets re-split by the shell.
 *   - **shlex.split**: reproduced by {@link shlexSplit} (POSIX mode). The
 *     template is tokenized *first*, then `{file}` is substituted into each
 *     token, so a path containing spaces stays exactly one argv element.
 *   - **timeout**: Python's `subprocess.TimeoutExpired` maps to spawnSync's
 *     `result.error.code === 'ETIMEDOUT'`; both yield exit code 124 with the
 *     same byte-exact stderr message. `timeout` is seconds in the API and is
 *     converted to milliseconds for spawnSync.
 */

import { spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';

import { isCi } from './ci-env.js';
import { FrameworkRegistry } from './framework-registry.js';

/** `(exit_code, stdout, stderr)` — mirrors the Python `Tuple[int, str, str]`. */
export type ExecuteResult = [number, string, string];

/**
 * POSIX `shlex.split` equivalent: whitespace-separated tokens with `'…'`
 * (fully literal), `"…"` (literal, but `\"`/`\\` escapes honored), and
 * backslash escaping of the next char outside quotes. Sufficient for the
 * framework execution-command templates, which are simple whitespace-separated
 * strings.
 *
 * Python: `shlex.split`.
 */
export function shlexSplit(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let hasToken = false;
  let i = 0;
  const n = input.length;
  // Python's `shlex.whitespace` is exactly these four characters — form-feed
  // (\f) and vertical-tab (\v) are NOT separators, so keep them inside tokens.
  const isWs = (c: string): boolean =>
    c === ' ' || c === '\t' || c === '\n' || c === '\r';

  while (i < n) {
    const c = input[i]!;
    if (isWs(c)) {
      if (hasToken) {
        tokens.push(cur);
        cur = '';
        hasToken = false;
      }
      i++;
    } else if (c === '\\') {
      hasToken = true;
      if (i + 1 < n) {
        cur += input[i + 1];
        i += 2;
      } else {
        // Python `shlex.split` raises `ValueError: No escaped character` on a
        // trailing backslash; this call sits outside `execute`'s try, so the
        // error propagates to the caller. Mirror that rather than silently
        // dropping the character.
        throw new Error('No escaped character');
      }
    } else if (c === "'") {
      hasToken = true;
      i++;
      while (i < n && input[i] !== "'") {
        cur += input[i];
        i++;
      }
      i++; // consume the closing quote
    } else if (c === '"') {
      hasToken = true;
      i++;
      while (i < n && input[i] !== '"') {
        if (
          input[i] === '\\' &&
          i + 1 < n &&
          (input[i + 1] === '"' || input[i + 1] === '\\')
        ) {
          cur += input[i + 1];
          i += 2;
        } else {
          cur += input[i];
          i++;
        }
      }
      i++; // consume the closing quote
    } else {
      hasToken = true;
      cur += c;
      i++;
    }
  }
  if (hasToken) tokens.push(cur);
  return tokens;
}

/** Render a caught value the way Python's `str(e)` renders an exception. */
function errStr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Handles execution of generated tests in a managed subprocess.
 *
 * Python: `CanaryTestExecutor`. Coordinates with the {@link FrameworkRegistry}
 * to determine the correct execution command for a framework and safely
 * executes the test file.
 */
export class CanaryTestExecutor {
  private readonly registry: FrameworkRegistry;

  constructor(registry: FrameworkRegistry = new FrameworkRegistry()) {
    this.registry = registry;
  }

  /**
   * Execute a test file using the specified framework.
   *
   * Python: `CanaryTestExecutor.execute`.
   *
   * @param filePath Path to the test file.
   * @param frameworkName Name of the framework (e.g. 'playwright').
   * @param timeout Maximum execution time in seconds. Defaults to 30.
   * @returns `[exit_code, stdout, stderr]`.
   */
  execute(
    filePath: string,
    frameworkName: string,
    timeout = 30,
  ): ExecuteResult {
    const framework = this.registry.findByName(frameworkName);
    if (framework === null) {
      throw new Error(`Framework '${frameworkName}' not found in registry.`);
    }

    const cmdTemplate = framework.execution_command;
    if (!cmdTemplate) {
      throw new Error(
        `No execution command defined for framework '${frameworkName}'.`,
      );
    }

    // Split the template first so the file path stays a single argv element
    // even when it contains spaces or shell metacharacters.
    const cmd = shlexSplit(cmdTemplate).map((tok) =>
      tok.split('{file}').join(String(filePath)),
    );

    if (isCi()) {
      cmd.push(...(framework.ci_flags ?? []));
    }

    try {
      const result = spawnSync(cmd[0]!, cmd.slice(1), {
        encoding: 'utf-8',
        timeout: timeout * 1000,
        // Python's subprocess.run has no output ceiling; Node defaults
        // maxBuffer to 1 MiB and, on overflow, kills the child (SIGTERM) and
        // surfaces ENOBUFS with status=null. Test runners (Playwright, Cypress,
        // verbose reporters) routinely exceed 1 MiB, which would flip a passing
        // run into a spurious failure with empty stdout. Remove the cap.
        maxBuffer: Infinity,
      });
      if (result.error) {
        const err = result.error as NodeJS.ErrnoException;
        // spawnSync surfaces a timeout as ETIMEDOUT rather than raising, the
        // analog of Python's subprocess.TimeoutExpired.
        if (err.code === 'ETIMEDOUT') {
          return [
            124,
            result.stdout ?? '',
            `Execution timed out after ${timeout} seconds.`,
          ];
        }
        return [1, '', errStr(err)];
      }
      // A signal death (SIGKILL/SIGSEGV, e.g. OOM) yields status=null; Python's
      // subprocess reports the negative signal number as the return code, so a
      // caller inspecting the exact code can still distinguish an OOM-kill.
      const exitCode =
        result.status ??
        (result.signal ? -(osConstants.signals[result.signal] ?? 1) : 1);
      return [exitCode, result.stdout ?? '', result.stderr ?? ''];
    } catch (e) {
      return [1, '', errStr(e)];
    }
  }
}
