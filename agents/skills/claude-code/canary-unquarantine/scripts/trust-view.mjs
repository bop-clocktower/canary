// trust-view -- the default branch's ledger and test source, read from a
// worktree of its tip, for trust.mjs to check a trial manifest against.

import * as ledgerIo from '../../canary-katana/scripts/ledger.mjs';
import { blockerRefs } from './audit.mjs';
import { at } from './git.mjs';
import { locate, readSource } from './markers.mjs';

/** The default branch as `targetFor` reads it. */
export function viewOf(work, trust, githubRepo) {
  const { ledger, jiraProjects, tags } = trust;
  const located = (row) => locate(readSource(work, row.file), row, tags);
  return {
    githubRepo,
    entries: ledgerIo.load(at(work, ledger)).entries,
    locate: located,
    named: (row) => blockerRefs(row, located(row), jiraProjects).refs,
  };
}
