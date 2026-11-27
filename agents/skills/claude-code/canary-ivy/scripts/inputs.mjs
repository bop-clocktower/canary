// inputs -- read the three inputs canary-ivy reports on. Split from cli.mjs so
// the entry point stays within the perf coupling rule (at most five imports).
//
// A named input that cannot be read throws; `gather` turns that into the
// message cli.mjs prints for exit 1. An absent DEFAULT history store is not an
// error: it is a dark source the report names as not assessed.

import { scanFixtures } from './fixtures.mjs';
import { groupOverlaps, loadCoverage } from './coverage.mjs';
import { DEFAULT_HISTORY, analyzeRuntime, readStore } from './runtime.mjs';

export { DEFAULT_HISTORY };

function readCoverage(file) {
  if (file === null) return null;
  const { tests, note } = loadCoverage(file);
  return { note, overlaps: groupOverlaps(tests) };
}

function readRuntime(file) {
  const store = readStore(file ?? DEFAULT_HISTORY, file !== null);
  if (store.dark) return { dark: store.dark, analysis: null };
  return { dark: null, analysis: analyzeRuntime(store.runs) };
}

/**
 * Read every input, or return the message naming the one that failed.
 *
 * @param {{coverage: string|null, history: string|null}} args
 * @param {string[]} paths
 */
export function gather(args, paths) {
  try {
    return {
      raw: {
        fixtures: scanFixtures(paths, process.cwd()),
        coverage: readCoverage(args.coverage),
        runtime: readRuntime(args.history),
      },
    };
  } catch (exc) {
    return { error: exc.message };
  }
}
