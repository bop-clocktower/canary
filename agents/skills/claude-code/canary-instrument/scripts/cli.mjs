#!/usr/bin/env node
// canary-instrument -- correlate a Playwright run's tests to their outbound
// HTTP spans. Ported from cli.py, behavior-preserving.
//
// Reads OTel span JSONL files written by otel_bootstrap/instrument.mjs (see
// SKILL.md for the two manual wiring steps), resolves each Playwright test's
// root span (set by otel_bootstrap/playwright-fixture.ts), attaches HTTP child
// spans, and writes a run.json v1 artifact (trace-only; see run_types.mjs for
// the contract).
//
// Invoked via:
//   canary skills run canary-instrument -- \
//     --spans test-results/trace --output test-results [--suite-type e2e_ui]
//
// Missing/empty --spans is not a failure -- it produces an empty trace block.
// Self-contained -- no external skill dependency.

import fs from 'node:fs';
import path from 'node:path';

import { RunArtifact } from './run_types.mjs';
import { readTraces } from './span_reader.mjs';

/**
 * Parse argv into { spans, output, suiteType }. Supports both `--flag value`
 * and `--flag=value`. Throws a usage error (matching argparse's behavior) when
 * a required flag is missing, an unknown flag appears, or a value-flag is left
 * without a value; callers map that to exit code 2.
 *
 * Two intentional, safer-than-argparse simplifications (deliberate, not
 * oversights):
 *   (a) Flags must be spelled in full -- there is no argparse-style prefix
 *       abbreviation, so `--out` is an unrecognized flag, not `--output`.
 *   (b) An empty value (e.g. `--spans=`) is passed through verbatim; an empty
 *       spans path simply yields an empty trace rather than globbing the CWD.
 */
function parseArgs(argv) {
  const opts = { spans: null, output: null, suiteType: '' };
  for (let i = 0; i < argv.length; i += 1) {
    let flag = argv[i];
    let inlineVal = null;
    if (flag.startsWith('--')) {
      const eq = flag.indexOf('=');
      if (eq !== -1) {
        inlineVal = flag.slice(eq + 1);
        flag = flag.slice(0, eq);
      }
    }
    // A value-flag with no `=value` consumes the next token. It is a usage
    // error (argparse: "expected one argument") when that token is missing --
    // the flag was last -- or is itself a flag (starts with `-`).
    const value = () => {
      if (inlineVal !== null) return inlineVal;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw usageError(`argument ${flag}: expected one argument`);
      }
      i += 1;
      return next;
    };
    if (flag === '--spans') opts.spans = value();
    else if (flag === '--output') opts.output = value();
    else if (flag === '--suite-type') opts.suiteType = value();
    else throw usageError(`unrecognized arguments: ${argv[i]}`);
  }

  // Nullish so an accidental undefined is caught alongside the initial null.
  const missing = [];
  if (opts.spans == null) missing.push('--spans');
  if (opts.output == null) missing.push('--output');
  if (missing.length) {
    throw usageError(
      `the following arguments are required: ${missing.join(', ')}`,
    );
  }
  return opts;
}

function usageError(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

/**
 * Serialize like Python's json.dumps(obj, indent=2): 2-space indent AND
 * ensure_ascii=True. JSON.stringify already matches the indentation and empty
 * container ("[]"/"{}") forms, but leaves non-ASCII raw -- so escape every code
 * unit above 0x7F to a \uXXXX sequence (astral chars become their two UTF-16
 * surrogate escapes, exactly as Python emits them). No trailing newline,
 * matching cli.py's write_text.
 */
function dumpsIndent2Ascii(obj) {
  const nonAscii = /[\u0080-\uffff]/g;
  return JSON.stringify(obj, null, 2).replace(
    nonAscii,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Python's datetime.now(timezone.utc).isoformat() renders a "+00:00" offset;
 * JS toISOString() renders "Z". Normalize the suffix so generated_at keeps the
 * documented "+00:00" convention. (Python emits microseconds, JS milliseconds;
 * generated_at is a wall-clock stamp and is never asserted against.)
 */
function nowIso() {
  return new Date().toISOString().replace('Z', '+00:00');
}

export function main(argv = []) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    console.error(`canary-instrument: error: ${exc.message}`);
    return 2; // argparse exits 2 on a usage/argument error
  }

  const spansDir = args.spans;
  if (existsButNotDir(spansDir)) {
    console.error(`canary-instrument: --spans is not a directory: ${spansDir}`);
    return 1;
  }

  const trace = readTraces(spansDir);
  const artifact = RunArtifact({
    schema_version: 1,
    suite_type: args.suiteType,
    generated_at: nowIso(),
    trace,
  });

  const outputDir = args.output;
  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, 'run.json');
  fs.writeFileSync(outPath, dumpsIndent2Ascii(artifact), 'utf8');

  console.log(
    `canary-instrument: wrote ${outPath} ` +
      `(${trace.spans_total} spans, ${trace.by_test.length} test buckets)`,
  );
  return 0;
}

function existsButNotDir(p) {
  try {
    return !fs.statSync(p).isDirectory();
  } catch {
    return false; // missing path is fine -- yields an empty trace
  }
}

// Direct execution (the skill runner execs this file via its shebang).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
