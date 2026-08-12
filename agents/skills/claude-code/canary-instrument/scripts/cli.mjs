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
import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';

import { RunArtifact } from './run_types.mjs';
import { readTraces } from './span_reader.mjs';

const USAGE =
  'usage: canary-instrument [-h] --spans PATH --output PATH\n' +
  '                         [--suite-type TYPE]\n' +
  '\n' +
  "Correlate a Playwright run's tests to their outbound HTTP spans and write a\n" +
  'run.json v1 artifact.\n' +
  '\n' +
  'options:\n' +
  '  -h, --help         show this help message and exit\n' +
  '  --spans PATH       directory of OTel span JSONL files to read\n' +
  '  --output PATH      directory to write run.json into (created if missing)\n' +
  '  --suite-type TYPE  suite label recorded in the artifact (e.g. e2e_ui)';

/**
 * Both value flags are required, and `--suite-type` is a free-form label. Two
 * deliberate divergences from argparse survive the move to the shared parser
 * (#479): flags must be spelled in full (no prefix abbreviation, so `--out` is
 * an unknown flag rather than `--output`), and an empty value is now REJECTED
 * rather than passed through -- `--spans=` used to yield an empty trace, which
 * is the missing-value case wearing a disguise.
 */
export const CLI_SPEC = {
  prog: 'canary-instrument',
  values: {
    '--spans': { key: 'spans' },
    '--output': { key: 'output' },
    '--suite-type': { key: 'suiteType' },
  },
  defaults: { suiteType: '' },
  required: ['--spans', '--output'],
};

const parseArgs = createParser(CLI_SPEC);

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
  const { opts: args, help, error } = parseArgs(argv);

  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, error));
    return EXIT_USAGE;
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
