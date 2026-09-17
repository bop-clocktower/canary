#!/usr/bin/env node
// canary-sweep -- component-level dedup for axe-core findings (#594).
//
// A POST-PROCESSOR, not a scanner. Someone else ran axe (harness's
// a11y-testing-automation, @axe-core/playwright, jest-axe, the axe CLI); this
// reads what they produced, collapses findings by COMPONENT rather than by
// page, and emits a WCAG-mapped report with fix snippets.
//
// No crawler, no route discovery, no browser, no network. The scanning half is
// upstream work that harness already ships eleven skills for; duplicating it
// here would have meant shipping a route discoverer that silently misses half a
// site, which is the exact abstention failure this repo exists to prevent. The
// dedup is the part nothing upstream does: one bad button in a shared header,
// reported forty times across forty pages, is forty rows of noise, and noise is
// how a11y tooling gets muted.
//
// Advisory by default (#508 D3): exit 0 whatever it finds, unless --strict.
// Under --strict: 1 = violations found, 3 = abstained, 0 = clean.
//
// Invoked via `canary skills run canary-sweep -- --results <path>`.

import fs from 'node:fs';
import path from 'node:path';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { ingest } from './ingest.mjs';
import { DEFAULT_ATTRS } from './component.mjs';
import {
  buildReport,
  renderMarkdown,
  renderJson,
  abstentionLine,
} from './report.mjs';

const PREFIX = 'canary-sweep:';

/** Exit code reserved family-wide for "abstained" (#508 D4). */
const EXIT_ABSTAINED = 3;

const USAGE =
  'usage: canary-sweep [-h] --results PATH [--routes PATH] [--component-attr LIST]\n' +
  '                    [--markdown-out PATH] [--json-out PATH] [--strict]\n' +
  '\n' +
  'Dedupe axe-core findings by component and emit a WCAG-mapped report.';

export const CLI_SPEC = {
  prog: 'canary-sweep',
  booleans: { '--strict': 'strict' },
  values: {
    '--results': { key: 'results' },
    '--routes': { key: 'routes' },
    '--component-attr': { key: 'componentAttr' },
    '--markdown-out': { key: 'markdownOut' },
    '--json-out': { key: 'jsonOut' },
  },
  required: ['--results'],
};

const parseArgs = createParser(CLI_SPEC);

/** `--component-attr a, b ,c` -> ['a','b','c']; absent -> the D1 default. */
function attrsFrom(value) {
  if (!value) return DEFAULT_ATTRS;
  const attrs = value
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  return attrs.length ? attrs : DEFAULT_ATTRS;
}

/** Write a file, creating its directory; returns a message on failure. */
function writeOut(target, contents) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, contents, 'utf8');
    return null;
  } catch (exc) {
    return `cannot write ${target}: ${exc.message}`;
  }
}

/** The --strict exit contract. Advisory callers never reach this. */
function strictExitFor(summary) {
  if (summary.abstained) return EXIT_ABSTAINED;
  return summary.violation_nodes > 0 ? 1 : 0;
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

  let report;
  try {
    report = buildReport(ingest(args.results), {
      attrs: attrsFrom(args.componentAttr),
      routesPath: args.routes,
    });
  } catch (exc) {
    console.error(`${PREFIX} ${exc.message}`);
    return 1;
  }

  // The abstention goes to stderr as well as into the artifact. A run whose
  // Markdown was redirected to a file would otherwise print nothing at all,
  // and silence is the one thing an abstention must never look like.
  if (report.summary.abstained) {
    console.error(`${PREFIX} ${abstentionLine(report)}`);
  }

  const markdown = renderMarkdown(report);
  const failures = [];
  if (args.markdownOut) failures.push(writeOut(args.markdownOut, markdown));
  if (args.jsonOut) failures.push(writeOut(args.jsonOut, renderJson(report)));
  if (!args.markdownOut && !args.jsonOut) process.stdout.write(markdown);

  for (const failure of failures.filter(Boolean)) {
    console.error(`${PREFIX} ${failure}`);
    return 1;
  }

  return args.strict ? strictExitFor(report.summary) : 0;
}

// Direct execution (the skill runner execs this file via its shebang).
//
// `process.exitCode`, not `process.exit()`: a large payload exceeds the pipe
// buffer, and `process.exit` tears the process down mid-write, leaving a
// truncated document that still exits 0 (#791).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
