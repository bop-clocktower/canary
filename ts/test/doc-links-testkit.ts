/**
 * Fixture helpers for `scripts/check_doc_links.mjs` (#686).
 *
 * Each case in `doc-links.test.ts` builds a small Markdown tree in a temp
 * directory and runs the script against it, so the helpers are the same four
 * every time: write a file, run the script, parse its trailing contract line,
 * pull the findings out. They live here rather than in the spec file for the
 * ordinary reason a testkit exists — the spec reads as prose about the two
 * upstream detector defects, not as plumbing.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The script under test, invoked as a subprocess so exit codes are real. */
const SCRIPT = join(REPO_ROOT, 'scripts', 'check_doc_links.mjs');

type Run = { status: number; out: string };

/** Run the script with arbitrary arguments (no `--root` implied). */
export function exec(args: string[]): Run {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/**
 * The trailing `{"…","check":"doc-links"}` contract line, parsed.
 *
 * Findings are printed to stderr and the contract line to stdout, so the two
 * streams are concatenated by the caller and the LAST JSON line wins.
 */
export function parseContract(out: string): Record<string, unknown> {
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .at(-1);
  if (!line) throw new Error(`no JSON contract line in output:\n${out}`);
  return JSON.parse(line) as Record<string, unknown>;
}

/** The helpers bound to one case's fixture directory. */
export type Kit = {
  write: (rel: string, content: string) => void;
  run: (extra?: string[]) => Run;
  report: (extra?: string[]) => Record<string, unknown>;
  findings: (extra?: string[]) => Array<Record<string, string>>;
};

export function kitFor(root: string): Kit {
  const run = (extra: string[] = []): Run => exec(['--root', root, ...extra]);
  const report = (extra: string[] = []): Record<string, unknown> =>
    parseContract(run(['--json', ...extra]).out);

  return {
    write(rel, content) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    },
    run,
    report,
    findings: (extra: string[] = []) =>
      report(extra).findings as Array<Record<string, string>>,
  };
}
