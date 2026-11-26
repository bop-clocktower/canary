// check -- `canary-katana --check`: does the ledger cover every static skip?
// (#1319)
//
// Recording a skip only happens when katana runs on the diff that added it.
// Nothing checked the ledger against the source, so a test switched off with
// `test.skip` and no row stayed invisible while CI stayed green. This mode
// walks the test files (skipscan.mjs), matches each static skip to a ledger
// row on (file, test), and exits:
//
//   0  every static skip has a row
//   1  at least one has none -- each is listed with the command that records it
//   3  abstained (ADR 0009): zero test files read, or the ledger is unreadable.
//      Neither is a pass, and a corrupt ledger is never overwritten.
//
// `--record` is that command: it appends a causeless `skipped` row per
// unledgered skip, with provenance from the commit that added the marker line,
// exactly as a diff-mode capture would have. Why the test is out (`cause`,
// `issue`) stays the quarantine producer's call, as everywhere in katana.

import { runGit, ticketFromMessage } from './diffscan.mjs';
import * as ledger from './ledger.mjs';
import { scanSkips } from './skipscan.mjs';

const PREFIX = 'canary-katana:';
const EXIT_UNLEDGERED = 1;
const EXIT_ABSTAINED = 3;

const pair = (file, test) => `${file}\u0000${test}`;

/** A `removed` row is a deletion record: it cannot account for a test still present. */
function ledgeredPairs(entries) {
  return new Set(
    entries
      .filter((r) => r.kind !== 'removed')
      .map((r) => pair(r.file, r.test)),
  );
}

const SAFE_TOKEN = /^[\w@%+=:,./-]+$/;
const quote = (t) => (SAFE_TOKEN.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`);

/** The exact command that records the skips in `file`. */
function fixCommand(args, file) {
  const argv = ['--check', '--record'];
  if (args.repo !== '.') argv.push('--repo', args.repo);
  if (args.ledger != null) argv.push('--ledger', args.ledger);
  argv.push(file);
  return `canary skills run canary-katana -- ${argv.map(quote).join(' ')}`;
}

/** Who added line `line` of `file`, from blame; null outside git or uncommitted. */
function blameLine(repo, file, line) {
  try {
    const out = runGit(
      repo,
      'blame',
      '--porcelain',
      '-L',
      `${line},${line}`,
      '--',
      file,
    );
    const sha = out.split(' ', 1)[0];
    if (/^0+$/.test(sha)) return null;
    const message = runGit(repo, 'show', '-s', '--format=%an%n%aI%n%B', sha);
    const [author, date, subject, ...body] = message.split('\n');
    const ticket = ticketFromMessage([subject, ...body].join('\n'));
    return { sha, author, date, subject, ticket };
  } catch {
    return null; // missing history is unknown, not fatal
  }
}

function toEntry(repo, skip) {
  const c = blameLine(repo, skip.file, skip.line);
  return ledger.LedgerEntry({
    test: skip.test,
    file: skip.file,
    kind: 'skipped',
    marker: skip.marker,
    commit: c ? c.sha : '',
    author: c ? c.author : 'unknown',
    date: c ? c.date : '',
    reason: c ? c.subject : '',
    issue: c ? c.ticket : '',
  });
}

/** Load the ledger, or `{error}` -- a ledger that cannot be read abstains. */
function readLedger(ledgerPath) {
  try {
    return { entries: ledger.load(ledgerPath).entries };
  } catch (exc) {
    return { error: exc.message };
  }
}

/** Scan, match, and (with --record) append. Pure of output. */
function evaluate(args, positionals, ledgerPath) {
  const scan = scanSkips(args.repo, positionals);
  const read = readLedger(ledgerPath);
  const known = read.error ? new Set() : ledgeredPairs(read.entries);
  const unledgered = scan.skips.filter((s) => !known.has(pair(s.file, s.test)));
  const result = { scan, unledgered, error: read.error ?? null, recorded: 0 };
  if (args.record && !result.error && unledgered.length) {
    ledger.appendEntries(
      ledgerPath,
      unledgered.map((s) => toEntry(args.repo, s)),
    );
    result.recorded = unledgered.length;
  }
  return result;
}

const abstained = (r) => r.error !== null || r.scan.files === 0;

function exitCode(r) {
  if (abstained(r)) return EXIT_ABSTAINED;
  return r.unledgered.length && !r.recorded ? EXIT_UNLEDGERED : 0;
}

function jsonDoc(args, r, ledgerPath) {
  return {
    checked: r.scan.files,
    skips: r.scan.skips.length,
    ledgered: r.scan.skips.length - r.unledgered.length,
    exempt: r.scan.exempt,
    unledgered: r.unledgered.map((s) => ({
      ...s,
      fix: fixCommand(args, s.file),
    })),
    recorded: r.recorded,
    abstained: abstained(r),
    ledger: String(ledgerPath),
    ...(r.error ? { error: r.error } : {}),
  };
}

function renderText(args, r) {
  const { files, skips, exempt } = r.scan;
  const lines = [
    `canary-katana --check: ${skips.length} static skip(s) in ${files} test file(s); ` +
      `${skips.length - r.unledgered.length} ledgered, ${r.unledgered.length} unledgered; ` +
      `${exempt} runtime-conditional skip(s) exempt.`,
  ];
  if (r.error)
    lines.push(
      `\u{26A0} Abstained \u{2014} the ledger cannot be read, so no skip could be matched; this is not a pass.`,
    );
  else if (!files)
    lines.push(
      '\u{26A0} Abstained \u{2014} 0 test file(s) scanned; this is not a pass.',
    );
  else if (r.recorded)
    lines.push(`recorded ${r.recorded} skip(s) into the ledger.`);
  else {
    for (const s of r.unledgered) {
      lines.push(
        `\u{2717} ${s.file}:${s.line}  "${s.test}"  (${s.marker}) has no ledger row`,
      );
      lines.push(`  fix: ${fixCommand(args, s.file)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Usage errors for the check-mode flags: PATHs or --record outside --check,
 * the diff inputs inside it (they would be silently ignored), and --record
 * with --no-write. --strict needs no rule: --check always exits 1 or 3.
 */
export function checkUsageError(args, positionals) {
  if (!args.check) {
    if (args.record) return '--record requires --check';
    return positionals.length
      ? `unrecognized arguments: ${positionals.join(' ')}`
      : null;
  }
  if (args.diffFile != null || args.criticalAreas != null)
    return '--check reads the tree, not a diff: drop --diff-file/--critical-areas';
  if (args.record && args.noWrite)
    return '--record and --no-write contradict each other';
  return null;
}

/** Run check mode; returns the exit code. */
export function runCheck(args, positionals, ledgerPath) {
  let r;
  try {
    r = evaluate(args, positionals, ledgerPath);
  } catch (exc) {
    console.error(`${PREFIX} ${exc.message}`);
    return 1;
  }
  if (r.error) console.error(`${PREFIX} ${r.error}`);
  console.log(
    args.json
      ? JSON.stringify(jsonDoc(args, r, ledgerPath), null, 2)
      : renderText(args, r),
  );
  return exitCode(r);
}
