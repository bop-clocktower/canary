// run -- print a produced brief, write --out, and choose the exit code (#666,
// spec Q4). Findings never reach the exit code: only an abstention (3) or a
// failed --out write (1) does.

import fs from 'node:fs';
import path from 'node:path';

import { clean } from './escape.mjs';
import { produce } from './brief.mjs';

const PREFIX = 'canary-dev-pipeline:';

const EXIT_WRITE = 1;
const EXIT_ABSTAINED = 3;

/** @returns {string|null} null on success */
function writeArtifact(out, text) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${text}\n`, 'utf8');
    return null;
  } catch (exc) {
    return `cannot write artifact: ${exc.message}`;
  }
}

/**
 * @param {{repo: string, paths: string[], budgetMs: number, json: boolean,
 *          out: string|null}} opts
 * @param {{clock?: () => number, cwd?: string}} deps
 * @returns {number} exit code
 */
export function execute(opts, deps) {
  const { text, alert } = produce(opts, {
    clock: deps.clock ?? (() => globalThis.performance.now()),
    cwd: deps.cwd ?? process.cwd(),
  });
  console.log(text);
  // The abstention goes to stderr as well: a brief redirected to a file must
  // still say, where a person will see it, that nothing was checked.
  if (alert) console.error(`${PREFIX} ${clean(alert, 1000)}`);
  const failure = opts.out ? writeArtifact(opts.out, text) : null;
  if (failure) {
    console.error(`${PREFIX} ${clean(failure)}`);
    return EXIT_WRITE;
  }
  return alert ? EXIT_ABSTAINED : 0;
}
