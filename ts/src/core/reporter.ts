/**
 * Standardized reporting for Canary execution results.
 *
 * Faithful TypeScript port of `agent/core/reporter.py`. Exports generation and
 * execution results to JSON or SARIF format for consumption by Datadog,
 * SonarQube, GitHub Code Scanning, and similar dashboards.
 *
 * SARIF 2.1.0 spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/
 *
 * Python→TS nuances:
 *   - **JSON shape is a contract.** Both serializers mirror Python's
 *     `json.dumps(..., indent=2, default=str)`: `JSON.stringify(x, replacer, 2)`
 *     with the library-default `ensure_ascii=True` reproduced via
 *     {@link ensureAscii} (so an em-dash in a message emits `—`, exactly
 *     as the oracle does). Object key insertion order preserves the field order
 *     Python emits.
 *   - **`default=str`.** Python coerces any value its encoder cannot natively
 *     serialize (a `Path`, a `datetime`, ...) via `str()`. JS inputs are already
 *     plain JSON objects; the only common value `JSON.stringify` would *throw*
 *     on is `BigInt`, which the replacer stringifies. There is no JS analog of a
 *     `Path` object, so that specific coercion is not reproducible — see the
 *     ported test, which exercises the BigInt path instead.
 *   - Python truthiness (`""`/`{}`/`None` falsy) via {@link pyTruthy}; missing
 *     dict keys via {@link pyGet}.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const TOOL_NAME = 'Canary';
const TOOL_VERSION = '0.1.0';
const TOOL_URI = 'https://github.com/bop-clocktower/canary';

const RULES = [
  {
    id: 'canary/test-generation',
    name: 'TestGeneration',
    shortDescription: { text: 'AI-generated test file' },
    helpUri: TOOL_URI,
  },
  {
    id: 'canary/test-execution',
    name: 'TestExecution',
    shortDescription: { text: 'Automated test execution result' },
    helpUri: TOOL_URI,
  },
] as const;

export const SUPPORTED_FORMATS = ['json', 'sarif'] as const;

// ---------------------------------------------------------------------------
// Python-compatibility helpers (mirrors `guardian/diff-extractor.ts`)
// ---------------------------------------------------------------------------

/**
 * Python-truthiness for JSON-shaped values: `None`/`undefined`, `false`, `0`,
 * `""`, empty array, and empty object are all falsy (mirrors `if x:`).
 */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `a or b`: the fallback wins only when `a` is falsy. */
function pyOr<T>(value: unknown, fallback: T): unknown {
  return pyTruthy(value) ? value : fallback;
}

/** Python `dict.get(key, default)`: default only on a missing key. */
function pyGet(
  obj: Record<string, unknown>,
  key: string,
  fallback: unknown,
): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

/**
 * Reproduce Python's `json.dumps(..., ensure_ascii=True)` (the library default)
 * on `JSON.stringify` output: escape every code point >= 0x80 as `\uXXXX`. Only
 * touches the >= 0x80 range, so the ASCII escapes `JSON.stringify` already
 * produced are left intact. (Same helper as `guardian/pr-check.ts`.)
 */
function ensureAscii(json: string): string {
  return json.replace(
    /[-￿]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

/**
 * `json.dumps(default=str)` replacer. Values the encoder can't natively handle
 * are coerced via `str()`; in JS the only common such value that would
 * otherwise *throw* is `BigInt`, which we stringify.
 */
function pyDefaultStr(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

type ReportResult = Record<string, unknown>;

/** Converts Canary pipeline results into standardized report formats. */
export class Reporter {
  /**
   * Serialize `result` to `fmt` ('json' or 'sarif') and write to disk; throws
   * `Error` (Python `ValueError`) for unsupported formats. Returns the written
   * path (Python returns a `Path`; here a string).
   */
  write(result: ReportResult, fmt: string, outputPath?: string | null): string {
    if (!(SUPPORTED_FORMATS as readonly string[]).includes(fmt)) {
      throw new Error(
        `Unsupported report format '${fmt}'. ` +
          `Choose from: ${SUPPORTED_FORMATS.join(', ')}`,
      );
    }

    const path = pyTruthy(outputPath)
      ? (outputPath as string)
      : `canary-report.${fmt}`;

    const content = fmt === 'json' ? this.toJson(result) : this.toSarif(result);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  /** Serialize `result` as pretty-printed JSON. */
  toJson(result: ReportResult): string {
    return ensureAscii(JSON.stringify(result, pyDefaultStr, 2));
  }

  /** Serialize `result` as SARIF 2.1.0 JSON. */
  toSarif(result: ReportResult): string {
    const sarif = {
      version: '2.1.0',
      $schema: SARIF_SCHEMA,
      runs: [this.buildRun(result)],
    };
    return ensureAscii(JSON.stringify(sarif, pyDefaultStr, 2));
  }

  // --------------------------------------------------------------------
  // SARIF construction
  // --------------------------------------------------------------------

  private buildRun(result: ReportResult): Record<string, unknown> {
    return {
      tool: {
        driver: {
          name: TOOL_NAME,
          version: TOOL_VERSION,
          informationUri: TOOL_URI,
          rules: RULES,
        },
      },
      results: this.buildResults(result),
    };
  }

  private buildResults(result: ReportResult): Record<string, unknown>[] {
    const sarifResults: Record<string, unknown>[] = [];

    const outputFile = pyGet(result, 'output_file', '');
    const testType = pyGet(result, 'test_type', 'unknown');
    const framework = pyGet(result, 'framework', 'unknown');

    // Generation result — always present.
    const genProps: Record<string, unknown> = {
      framework,
      test_type: testType,
      reasoning: pyGet(result, 'reasoning', []),
    };
    if (pyTruthy(pyGet(result, 'quality', null))) {
      genProps['quality'] = result['quality'];
    }
    sarifResults.push({
      ruleId: 'canary/test-generation',
      message: {
        text:
          `Generated ${String(framework)} test (${String(testType)})` +
          (pyTruthy(outputFile) ? ` — ${String(outputFile)}` : ''),
      },
      level: 'none',
      locations: pyTruthy(outputFile) ? [location(String(outputFile))] : [],
      properties: genProps,
    });

    // Execution result — only if the test was run.
    const execution = pyGet(result, 'execution', null);
    if (pyTruthy(execution)) {
      const exec = execution as Record<string, unknown>;
      const exitCode = pyGet(exec, 'exit_code', -1);
      const passed = exitCode === 0;
      const fixed = pyGet(exec, 'fixed', false);

      const messageParts: string[] = [
        `Test execution ${passed ? 'passed' : 'failed'} ` +
          `(exit code ${String(exitCode)})`,
      ];
      if (pyTruthy(fixed)) {
        messageParts.push('Self-healed after initial failure.');
      }
      if (!passed) {
        const stderr = pyOr(
          pyGet(exec, 'stderr', null),
          pyGet(exec, 'stdout', ''),
        );
        if (pyTruthy(stderr)) {
          const s = String(stderr);
          // Truncate long error output for readability in dashboards. Python
          // `stderr[:300]` and `len(stderr) > 300` count code points; JS slice
          // and .length count UTF-16 units, so astral chars would truncate
          // early and flip the >300 guard. Count/slice by code point instead.
          const chars = Array.from(s);
          const preview =
            chars.slice(0, 300).join('') + (chars.length > 300 ? '…' : '');
          messageParts.push(`Error: ${preview}`);
        }
      }

      sarifResults.push({
        ruleId: 'canary/test-execution',
        message: { text: messageParts.join(' ') },
        level: passed ? 'none' : 'error',
        locations: pyTruthy(outputFile) ? [location(String(outputFile))] : [],
        properties: {
          exit_code: exitCode,
          fixed,
        },
      });
    }

    return sarifResults;
  }
}

function location(uri: string): Record<string, unknown> {
  return {
    physicalLocation: {
      artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
    },
  };
}
