#!/usr/bin/env node
// canary-strix -- keep company and consumer identifiers out of a public repo.
//
//   --root <path>   repository to scan (default: the current directory).
//   --range <spec>  commit range for the authorship scan; otherwise resolved
//                   from the CI event (GITHUB_BASE_REF / GITHUB_EVENT_BEFORE).
//   --files-only    skip the authorship scan.
//   --json          emit machine-readable findings instead of human text.
//   --strict        exit 1 when there are findings (default is advisory: 0).
//
// Deterministic: no LLM, no network, no execution.
//
// Invoked via `canary skills run canary-strix -- [--json] [--strict] ...`.

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import {
  loadTerms,
  DENYLIST_ENV,
  DENYLIST_FILE,
  COMPANY_FILE,
} from './terms.mjs';
import {
  compileTerms,
  scanFiles,
  scanAuthorship,
  resolveRange,
} from './scanner.mjs';

export const SCHEMA_VERSION = 1;

const PREFIX = 'canary-strix:';

/** Reserved CLI-wide: exit 3 means "abstained -- verified zero items". */
const EXIT_ABSTAINED = 3;

const ARROW = '\u{2192}';

const USAGE =
  'usage: canary-strix [-h] [--json] [--strict] [--files-only] [--root PATH]\n' +
  '                    [--range SPEC]\n' +
  '\n' +
  'Keep company and consumer identifiers out of a public repo.\n' +
  '\n' +
  'options:\n' +
  '  -h, --help     show this help message and exit\n' +
  '  --root PATH    repository to scan (default: the current directory)\n' +
  '  --range SPEC   commit range for the authorship scan (default: the CI event)\n' +
  '  --files-only   skip the authorship scan\n' +
  '  --json         emit machine-readable findings instead of human text\n' +
  '  --strict       exit 1 when there are findings (default is advisory: exit 0)\n' +
  '\n' +
  'rules:\n' +
  '  STRIX-001  company identifier in a tracked file\n' +
  '  STRIX-002  company identity on a commit (author, committer or trailer)\n' +
  '\n' +
  'terms come from, unioned:\n' +
  `  ${DENYLIST_ENV}   a CI secret -- the only source safe for a PUBLIC repo\n` +
  `  ${DENYLIST_FILE}       gitignored, so the desk catches it before a push\n` +
  `  ${COMPANY_FILE}     committed: PRIVATE repos only\n` +
  '\n' +
  'ZERO TERMS IS NOT A CLEAN SCAN. With no terms configured this cannot match\n' +
  'anything, and it exits 3 under --strict rather than reporting a pass.';

export const CLI_SPEC = {
  prog: 'canary-strix',
  booleans: {
    '--json': 'json',
    '--strict': 'strict',
    '--files-only': 'filesOnly',
  },
  values: {
    '--root': { key: 'root' },
    '--range': { key: 'range' },
  },
};

const parseArgs = createParser(CLI_SPEC);

function analyse(opts, env = process.env) {
  const root = opts.root ?? '.';
  const { terms, sources, committedSource } = loadTerms(root, env);

  // A denylist of zero terms matches nothing, whatever it is pointed at. That
  // is an abstention in every environment -- the single most important line in
  // this file, because the alternative reads exactly like a clean repo.
  if (!terms.length) {
    return { abstained: 'no terms configured', terms, sources, findings: [] };
  }

  const matchers = compileTerms(terms);
  const files = scanFiles(root, matchers);
  if (files.unavailable) {
    return { abstained: files.unavailable, terms, sources, findings: [] };
  }

  const findings = [...files.findings];
  let authorship = { skipped: '--files-only' };
  if (!opts.filesOnly) {
    authorship = scanAuthorship(root, matchers, resolveRange(env, opts.range));
    if (authorship.findings) findings.push(...authorship.findings);
  }

  return {
    terms,
    sources,
    committedSource,
    files,
    authorship,
    findings,
  };
}

function reportJson(result) {
  console.log(
    JSON.stringify(
      {
        schema_version: SCHEMA_VERSION,
        skill: 'canary-strix',
        abstained: result.abstained ?? null,
        term_count: result.terms.length,
        sources: result.sources,
        files_scanned: result.files?.scanned ?? 0,
        commits_scanned: result.authorship?.scanned ?? 0,
        findings: result.findings,
      },
      null,
      2,
    ),
  );
}

/** Caveats that qualify an otherwise-clean line. Never silent. */
function reportCaveats(result) {
  if (result.committedSource) {
    console.error(
      `${PREFIX} note: terms were read from ${COMPANY_FILE}, which is ` +
        'COMMITTED. On a public repo that publishes the list of identifiers ' +
        `you are hiding -- use ${DENYLIST_ENV} or ${DENYLIST_FILE} instead.`,
    );
  }
  if (result.authorship?.unavailable) {
    console.error(
      `${PREFIX} authorship scan could not run: ${result.authorship.unavailable}. ` +
        'Files were scanned; commits were not.',
    );
  }
}

function report(result, json) {
  if (json) return reportJson(result);

  if (result.abstained) {
    console.error(
      `${PREFIX} ABSTAINED -- ${result.abstained}.\n` +
        'Nothing was matched, so this is not a clean result. Configure terms in ' +
        `${DENYLIST_ENV}, ${DENYLIST_FILE}, or ${COMPANY_FILE}.`,
    );
    return;
  }

  for (const f of result.findings) {
    const where = f.file ? `${f.file}:${f.line}` : f.commit;
    const what = f.fields ? ` (${f.fields.join('/')})` : '';
    console.log(`${f.rule}  ${where}${what}\n    ${ARROW} ${f.detail}`);
  }

  // The denominators, always -- a verdict without them cannot be checked.
  console.log(
    `${PREFIX} ${result.findings.length} finding(s) over ` +
      `${result.files.scanned} file(s) and ` +
      `${result.authorship?.scanned ?? 0} commit(s), ` +
      `${result.terms.length} term(s) from ${result.sources.join(' + ')}.`,
  );
  reportCaveats(result);
}

export function main(argv = [], env = process.env) {
  const { opts, help, error } = parseArgs(argv);

  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, error));
    return EXIT_USAGE;
  }

  const result = analyse(opts, env);
  report(result, opts.json);

  // Advisory by default: findings are loud, the exit is not. Under --strict the
  // exit-code contract applies, and an abstention takes 3 -- distinct from 1,
  // "found something real".
  if (!opts.strict) return 0;
  if (result.abstained) return EXIT_ABSTAINED;
  if (result.findings.length) return 1;
  // Files scanned but commits not: a PARTIAL scan. Zero findings over a half
  // that never ran is not a pass, and exiting 0 here is precisely the
  // silently-degraded green this skill exists to make impossible. Findings
  // still outrank it above — something real is more informative than "one
  // half was dark".
  if (result.authorship?.unavailable) return EXIT_ABSTAINED;
  return 0;
}

// `process.exitCode`, not `process.exit()`: a large `--json` payload exceeds
// the pipe buffer and `process.exit` tears the process down mid-write, leaving
// truncated JSON that still exits 0 (#791).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
