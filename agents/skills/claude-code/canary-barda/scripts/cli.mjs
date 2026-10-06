#!/usr/bin/env node
// canary-barda -- build a standalone QA site from a canary.site/1 feed
// (#1151 phase 3b).
//
// Validates the feed, then writes index.html, site.json and the site kit into
// --out. An invalid feed builds nothing. A feed with zero runs still builds
// (every run panel abstains on the page) but says so: ABSTAINED, exit 3 under
// --strict (#508). Writes only, never deploys.
//
// Exit: 0 built · 1 unreadable/invalid feed or unusable --out · 2 usage ·
// 3 under --strict when the feed carries zero runs.
//
// Invoked via `canary skills run canary-barda -- --feed <file> --out <dir>`.

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { isMain } from '../../../lib/is-main.mjs';
import { buildSite, outProblem } from './build.mjs';
import { readFeed } from './feed.mjs';

const PREFIX = 'canary-barda:';
const EXIT_ABSTAINED = 3;

const USAGE =
  'usage: canary-barda [-h] --feed PATH --out DIR [--title TEXT] [--strict]\n' +
  '\n' +
  'Build a static QA site (index.html, site.json, kit/) from a canary.site/1\n' +
  'feed. The feed is validated first; an invalid feed builds nothing.';

export const CLI_SPEC = {
  prog: 'canary-barda',
  booleans: { '--strict': 'strict' },
  values: {
    '--feed': { key: 'feed' },
    '--out': { key: 'out' },
    '--title': { key: 'title' },
  },
  defaults: { title: 'QA site' },
  required: ['--feed', '--out'],
};

const parseArgs = createParser(CLI_SPEC);

function summarize(args, doc, files) {
  if (doc.runs.length === 0) {
    // A page of abstentions is honest; a "built" line over it reads as done.
    console.log(
      `${PREFIX} ABSTAINED: built ${args.out} from a feed with 0 runs; every run panel will abstain.`,
    );
    return args.strict ? EXIT_ABSTAINED : 0;
  }
  console.log(
    `${PREFIX} built ${args.out}: ${files} file(s), 6 panels, ${doc.runs.length} run(s)`,
  );
  return 0;
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
  const { doc, errors } = readFeed(args.feed);
  if (!doc) {
    for (const e of errors) console.error(`${PREFIX} invalid feed: ${e}`);
    console.error(`${PREFIX} nothing built`);
    return 1;
  }
  const blocked = outProblem(args.out);
  if (blocked) {
    console.error(`${PREFIX} ${blocked}`);
    return 1;
  }
  let files;
  try {
    files = buildSite(doc, args.out, { title: args.title });
  } catch (exc) {
    // e.g. --out under a regular file: ENOTDIR, never a raw stack trace.
    console.error(`${PREFIX} cannot build into ${args.out}: ${exc.message}`);
    return 1;
  }
  return summarize(args, doc, files);
}

// `process.exitCode`, not `process.exit()` (#791).
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
