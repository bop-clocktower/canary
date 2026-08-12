#!/usr/bin/env node
// canary-shadow — differential ("shadow") parity runner.
//
// Runs each case's argv through a `baseline` and a `candidate` command,
// normalizes away irrelevant noise, and diffs exit code + stdout. Prints
// ok / accept / DIVERGE per case; exits non-zero if any un-accepted divergence
// remains. See ../SKILL.md for the methodology and cases.example.json for the
// config shape.
//
// Usage: node cli.mjs --cases <cases.json> [--verbose]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';

const USAGE =
  'usage: canary-shadow [-h] --cases PATH [--verbose]\n' +
  '\n' +
  'Run each case through a baseline and a candidate command, normalize away\n' +
  'irrelevant noise, and diff exit code + stdout.\n' +
  '\n' +
  'options:\n' +
  '  -h, --help    show this help message and exit\n' +
  '  --cases PATH  cases file describing baseline, candidate, and cases\n' +
  '  --verbose     print a line per matching case, not just divergences';

/**
 * canary-shadow shipped BEFORE the family had a shared contract, and it showed:
 * no `--help`, no unknown-flag rejection, and a usage line naming `cli.mjs`
 * rather than the skill. Nobody noticed, because there was nothing to violate
 * (#479).
 */
export const CLI_SPEC = {
  prog: 'canary-shadow',
  booleans: { '--verbose': 'verbose' },
  values: { '--cases': { key: 'cases' } },
  required: ['--cases'],
};

const parseArgs = createParser(CLI_SPEC);

// --- built-in normalization masks (name -> {re, replace}). Each records
// whether it fired so the reviewer can see what was hidden. Extend/override per
// project via the cases file's `normalize` list. ---
const MASKS = {
  ansi: { re: /\x1b\[[0-9;]*m/g, replace: '' },
  version: { re: /v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/g, replace: 'vX' },
  timestamp: {
    re: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    replace: 'TS',
  },
  tmppath: { re: /(?:\/private)?\/(?:var|tmp)\/[^\s"']+/g, replace: 'TMP' },
  sha: { re: /\b[0-9a-f]{7,40}\b/g, replace: 'SHA' },
  runid: { re: /\b(?:run|job)[-_]?\d{3,}\b/gi, replace: 'RUNID' },
};
const DEFAULT_MASKS = ['ansi', 'version', 'timestamp', 'tmppath', 'sha'];

function buildMasks(spec) {
  // spec: array of built-in names and/or {name, pattern, flags?, replace}
  const list = [];
  for (const m of spec ?? DEFAULT_MASKS) {
    if (typeof m === 'string') {
      if (!MASKS[m]) throw new Error(`unknown built-in mask: ${m}`);
      list.push({ name: m, ...MASKS[m] });
    } else {
      list.push({
        name: m.name ?? m.pattern,
        re: new RegExp(m.pattern, m.flags ?? 'g'),
        replace: m.replace ?? '',
      });
    }
  }
  return list;
}

function normalize(text, masks, fired) {
  let out = text;
  for (const m of masks) {
    if (m.re.test(out)) fired.add(m.name);
    m.re.lastIndex = 0;
    out = out.replace(m.re, m.replace);
  }
  return out.replace(/[ \t]+$/gm, '').trim();
}

function run(cmd, argv, cwd, env) {
  const r = spawnSync(cmd[0], [...cmd.slice(1), ...argv], {
    cwd,
    env: { ...process.env, NO_COLOR: '1', ...env },
    encoding: 'utf-8',
    maxBuffer: Infinity,
    timeout: 120_000,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

function unifiedDiff(a, b, max = 30) {
  const A = a.split('\n');
  const B = b.split('\n');
  // minimal LCS-free line diff: good enough for review, keeps the runner small.
  const out = [];
  const bSet = new Set(B);
  const aSet = new Set(A);
  for (const line of A) if (!bSet.has(line)) out.push('- ' + line);
  for (const line of B) if (!aSet.has(line)) out.push('+ ' + line);
  return out.slice(0, max);
}

export function main(argv = []) {
  const { opts, help, error } = parseArgs(argv);

  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, error));
    return EXIT_USAGE;
  }

  const { cases: casesPath, verbose } = opts;
  const cfg = JSON.parse(readFileSync(casesPath, 'utf-8'));
  const masks = buildMasks(cfg.normalize);
  // Null-prototype: `accept` comes straight from JSON, so on a plain object a
  // case labelled `toString` resolved to Object.prototype.toString and was
  // reported `accept` instead of DIVERGE -- a parity tool silently suppressing
  // a parity failure, which is the worst place in the family for this bug to
  // have landed (#479).
  const accept = Object.assign(Object.create(null), cfg.accept ?? {});
  const fired = new Set();

  let ok = 0;
  let accepted = 0;
  let diverged = 0;
  for (const c of cfg.cases) {
    let cwd = cfg.cwd;
    let tmp;
    if (c.isolate) {
      tmp = mkdtempSync(join(tmpdir(), 'shadow-'));
      cwd = tmp;
    }
    try {
      const base = run(cfg.baseline, c.argv, cwd, cfg.env);
      const cand = run(cfg.candidate, c.argv, cwd, cfg.env);
      const bOut = normalize(base.stdout, masks, fired);
      const cOut = normalize(cand.stdout, masks, fired);
      const match = base.code === cand.code && bOut === cOut;
      if (match) {
        ok++;
        if (verbose)
          process.stdout.write(`ok     ${c.label}  (exit ${base.code})\n`);
      } else if (accept[c.label]) {
        accepted++;
        process.stdout.write(`accept ${c.label}  — ${accept[c.label]}\n`);
      } else {
        diverged++;
        process.stdout.write(
          `DIVERGE ${c.label}  (exit base=${base.code} cand=${cand.code})\n`,
        );
        if (base.code !== cand.code)
          process.stdout.write(
            `        exit differs: base=${base.code} cand=${cand.code}\n`,
          );
        for (const line of unifiedDiff(bOut, cOut))
          process.stdout.write('        ' + line + '\n');
      }
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }
  process.stdout.write(
    `\n=== ${ok} ok, ${accepted} accepted, ${diverged} DIVERGE ` +
      `(${cfg.cases.length} cases) — masks fired: ${[...fired].join(', ') || 'none'} ===\n`,
  );
  return diverged > 0 ? 1 : 0;
}

// Direct execution (the skill runner execs this file via its shebang).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
