/**
 * `canary manhunter`: the release quality dossier (#611).
 *
 * Reads evidence other canary producers already wrote -- the run-history
 * store, guardian analysis records, ci-ready's inputs, the katana ledger, a
 * sweep report, a hand-kept escape log -- and emits one dossier. Emit-only: no
 * network, no posting; it writes stdout, or the paths `--out`/`--json-out`
 * name, and nothing else.
 *
 * Exit codes are the release-checklist item "quality evidence is complete":
 *   - 0 every section fed, or declared out with `--exclude id=reason`;
 *   - 1 at least one section dark and undeclared;
 *   - 3 (EXIT_ABSTAINED) nothing was read at all;
 *   - 2 usage error (bad `--exclude`, bad `--window`).
 * Worth-your-eyes items never change the exit code.
 *
 * `canary manhunter verify <dossier.json>` recomputes the content digest:
 * 0 match, 1 mismatch, 2 unreadable or not a dossier.
 *
 * Lives in its own folder, not beside the engine, for the reason
 * `rewind/rewind-cli.ts` does: filename binds the `cli` layer, and a top-level
 * `ts/src` file would grow that module's file count.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';

import { CliExitError, normalizeUsageExit } from '../cli-common.js';
import { EXIT_ABSTAINED } from '../core/gate-result.js';
import {
  assembleDossier,
  finalizeDossier,
  verifyDossier,
  type Dossier,
  type Exclusions,
} from '../analysis/manhunter/assemble.js';
import { escapesSection } from '../analysis/manhunter/escapes.js';
import { guardianSections } from '../analysis/manhunter/guardian.js';
import { historySection } from '../analysis/manhunter/history.js';
import { ledgerSection } from '../analysis/manhunter/ledger.js';
import { readinessSection } from '../analysis/manhunter/readiness.js';
import { renderDossier } from '../analysis/manhunter/render.js';
import { sweepSection } from '../analysis/manhunter/sweep.js';
import { SECTION_IDS, type Section } from '../analysis/manhunter/types.js';
import type { MainDeps } from '../main-deps.js';

const EXIT_USAGE = 2;

interface DossierOpts {
  root?: string;
  release: string;
  history: string;
  analyses: string;
  ledger: string;
  escapes: string;
  sweep?: string;
  window: string;
  exclude: string[];
  out?: string;
  jsonOut?: string;
}

function usage(deps: MainDeps, message: string): never {
  deps.err(`manhunter: ${message}`);
  throw new CliExitError(EXIT_USAGE);
}

function parseExclusions(deps: MainDeps, raw: string[]): Exclusions {
  const out: Record<string, string> = {};
  for (const entry of raw) {
    const at = entry.indexOf('=');
    const id = at === -1 ? entry : entry.slice(0, at);
    const reason = at === -1 ? '' : entry.slice(at + 1).trim();
    if (!(SECTION_IDS as readonly string[]).includes(id)) {
      usage(
        deps,
        `unknown section "${id}" in --exclude (known: ${SECTION_IDS.join(', ')})`,
      );
    }
    if (reason === '') {
      usage(deps, `--exclude ${id} needs a reason: --exclude ${id}=<reason>`);
    }
    out[id] = reason;
  }
  return out;
}

function parseWindow(deps: MainDeps, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    usage(deps, `--window must be a positive integer, got "${raw}"`);
  }
  return n;
}

function gatherSections(
  opts: DossierOpts,
  root: string,
  now: string,
  windowRuns: number,
): Section[] {
  const at = (p: string) => resolve(root, p);
  const historyPath = at(opts.history);
  return [
    historySection(historyPath, windowRuns),
    ...guardianSections(at(opts.analyses)),
    readinessSection({
      historyPath,
      inventoryPath: at('.canary/test-inventory.json'),
      criticalAreasPath: at('.canary/critical-areas.json'),
    }),
    ledgerSection(at(opts.ledger), now),
    sweepSection(opts.sweep === undefined ? null : at(opts.sweep)),
    escapesSection(at(opts.escapes)),
  ];
}

function exitCodeFor(dossier: Dossier): number {
  if (dossier.verdict === 'abstained') return EXIT_ABSTAINED;
  return dossier.verdict === 'incomplete' ? 1 : 0;
}

function emit(deps: MainDeps, dossier: Dossier, opts: DossierOpts): void {
  const markdown = renderDossier(dossier);
  if (opts.jsonOut !== undefined) {
    writeFileSync(opts.jsonOut, `${JSON.stringify(dossier, null, 2)}\n`);
  }
  if (opts.out !== undefined) writeFileSync(opts.out, markdown);
  else deps.out(markdown.trimEnd());
}

function runDossier(deps: MainDeps, opts: DossierOpts): void {
  const exclusions = parseExclusions(deps, opts.exclude);
  const windowRuns = parseWindow(deps, opts.window);
  const root = opts.root ?? deps.cwd();
  const now = new Date().toISOString();
  const payload = assembleDossier({
    release: opts.release,
    sections: gatherSections(opts, root, now, windowRuns),
    exclusions,
  });
  const dossier = finalizeDossier(payload, now);
  emit(deps, dossier, opts);
  const code = exitCodeFor(dossier);
  if (code !== 0) throw new CliExitError(code);
}

function runVerify(deps: MainDeps, file: string): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    usage(deps, `cannot read ${file}`);
  }
  const result = verifyDossier(text);
  if (result === 'malformed') usage(deps, `${file} is not a JSON dossier`);
  if (result === 'mismatch') {
    deps.out(
      `${file}: digest MISMATCH, the dossier was edited after it was generated`,
    );
    throw new CliExitError(1);
  }
  deps.out(`${file}: digest matches its content`);
}

const collect = (value: string, prev: string[]): string[] => [...prev, value];

function buildVerifyCommand(deps: MainDeps): Command {
  return new Command('verify')
    .description(
      'Recompute a JSON dossier content digest (0 match, 1 mismatch).',
    )
    .argument('<dossier>', 'the file written by --json-out')
    .exitOverride(normalizeUsageExit)
    .action((file: string) => runVerify(deps, file));
}

/** Where each source is read from, relative to `--root`. */
function addSourceOptions(command: Command): Command {
  return command
    .option(
      '--history <path>',
      'Run-history store.',
      'test-results/reports/history-v2.jsonl',
    )
    .option(
      '--analyses <dir>',
      'Guardian analysis records directory.',
      '.harness/analyses',
    )
    .option(
      '--ledger <path>',
      'canary-katana quarantine ledger.',
      '.canary/quarantine.json',
    )
    .option(
      '--escapes <path>',
      'Hand-kept escaped-defect log.',
      '.canary/escapes.json',
    )
    .option('--sweep <path>', 'canary-sweep JSON report (no default).');
}

export function buildManhunterCommand(deps: MainDeps): Command {
  const command = new Command('manhunter').description(
    'Assemble a release quality dossier from existing evidence; a dark source is named, never read as clean.',
  );
  addSourceOptions(command)
    .option(
      '--root <dir>',
      'Repository root inputs resolve against (default: cwd).',
    )
    .option(
      '--release <label>',
      'Release label for the dossier title.',
      'unlabelled release',
    )
    .option('--window <runs>', 'Run window for flaky tests.', '30')
    .option(
      '--exclude <id=reason>',
      'Declare a section out of scope, with a reason (repeatable).',
      collect,
      [],
    )
    .option(
      '--out <file>',
      'Write the markdown dossier here instead of stdout.',
    )
    .option(
      '--json-out <file>',
      'Also write the JSON dossier (with digest) here.',
    )
    .action((opts: DossierOpts) => runDossier(deps, opts));
  command.addCommand(buildVerifyCommand(deps));
  return command;
}
