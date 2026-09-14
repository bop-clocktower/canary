/**
 * Tests for `branchTicket` -- the branch-name -> ticket-key reader.
 *
 * These exist because the function was named by the suite but never executed
 * by it: `test/ticket-updater.test.ts` reaches it only through
 * `vi.spyOn(updater, 'branchTicket').mockReturnValue(...)`, which replaces the
 * implementation wholesale. Coverage therefore reported the whole body
 * uncovered while a reader scanning the suite would conclude it was tested.
 * Nothing proved that the regex accepts the branch names the convention
 * promises, rejects the ones it does not, or that a missing/hanging `git`
 * degrades to "no ticket" instead of propagating.
 *
 * Every case below drives the real body through an injected `SubprocessRun`,
 * so the assertions are about this function's behavior rather than about a
 * stub's return value.
 */

import { describe, expect, it } from 'vitest';

import { branchTicket } from '../src/core/ticket-updater.js';
import {
  CommandNotFoundError,
  SubprocessTimeoutError,
  type SubprocessRun,
} from '../src/core/workflow-discovery.js';

/** A `SubprocessRun` that reports `branch` as git's stdout. */
function onBranch(branch: string, returncode = 0): SubprocessRun {
  return () => ({ returncode, stdout: branch, stderr: '' });
}

/** A `SubprocessRun` that throws `err` instead of running. */
function failingWith(err: Error): SubprocessRun {
  return () => {
    throw err;
  };
}

describe('branchTicket', () => {
  describe('the git invocation it makes', () => {
    it('asks git for the current branch, with a timeout', () => {
      const calls: Array<{ cmd: string[]; opts?: { timeout?: number } }> = [];
      const spy: SubprocessRun = (cmd, opts) => {
        calls.push({ cmd, ...(opts ? { opts } : {}) });
        return { returncode: 0, stdout: 'feature/PROJ-1', stderr: '' };
      };

      branchTicket(spy);

      // The command is part of the contract: `--show-current` is what makes
      // this safe on a detached HEAD (it prints nothing rather than failing).
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cmd).toEqual(['git', 'branch', '--show-current']);
      // Unbounded, this would hang the whole run on a wedged git.
      expect(calls[0]!.opts?.timeout).toBe(5);
    });

    it('trims the trailing newline git writes after the branch name', () => {
      // Real `git branch --show-current` output ends in "\n"; untrimmed, the
      // regex would still match but the captured key could carry whitespace.
      expect(branchTicket(onBranch('feature/PROJ-77\n'))).toEqual([
        'PROJ-77',
        'PROJ',
        'branch',
      ]);
    });
  });

  describe('branch names that carry a ticket', () => {
    it('reads the ticket and its project from a feature branch', () => {
      expect(branchTicket(onBranch('feature/PROJ-123'))).toEqual([
        'PROJ-123',
        'PROJ',
        'branch',
      ]);
    });

    it('accepts the fix/ and chore/ prefixes too', () => {
      expect(branchTicket(onBranch('fix/AB-1'))).toEqual([
        'AB-1',
        'AB',
        'branch',
      ]);
      expect(branchTicket(onBranch('chore/X9-42'))).toEqual([
        'X9-42',
        'X9',
        'branch',
      ]);
    });

    it('keeps the ticket when a slug follows it', () => {
      // The everyday shape: `feature/PROJ-5-add-the-thing`.
      expect(branchTicket(onBranch('feature/PROJ-5-add-the-thing'))).toEqual([
        'PROJ-5',
        'PROJ',
        'branch',
      ]);
    });

    it('reports the source as "branch" whenever a ticket was found', () => {
      // The third element is how callers tell an inferred ticket from an
      // explicitly supplied one, so it is behavior, not decoration.
      expect(branchTicket(onBranch('feature/PROJ-1'))[2]).toBe('branch');
    });
  });

  describe('branch names that carry no ticket', () => {
    it('returns no ticket for a branch off the convention', () => {
      expect(branchTicket(onBranch('main'))).toEqual([null, null, 'none']);
    });

    it('ignores a prefix outside feature/fix/chore', () => {
      // `docs/` is a real prefix in this repo's convention but is deliberately
      // not one this reader treats as ticket-bearing.
      expect(branchTicket(onBranch('docs/PROJ-1'))).toEqual([
        null,
        null,
        'none',
      ]);
    });

    it('requires the project key to be upper-case', () => {
      expect(branchTicket(onBranch('feature/proj-1'))).toEqual([
        null,
        null,
        'none',
      ]);
    });

    it('requires a numeric ticket suffix', () => {
      expect(branchTicket(onBranch('feature/PROJ-abc'))).toEqual([
        null,
        null,
        'none',
      ]);
    });

    it('returns no ticket on an empty branch name (detached HEAD)', () => {
      expect(branchTicket(onBranch(''))).toEqual([null, null, 'none']);
    });
  });

  describe('when git does not cooperate', () => {
    it('returns no ticket when git exits non-zero', () => {
      // Outside a repository git fails; the branch name is then unknowable,
      // and an unknown branch must not be read as a ticket.
      expect(branchTicket(onBranch('feature/PROJ-1', 128))).toEqual([
        null,
        null,
        'none',
      ]);
    });

    it('degrades to no ticket when the git binary is missing', () => {
      expect(
        branchTicket(failingWith(new CommandNotFoundError('no git'))),
      ).toEqual([null, null, 'none']);
    });

    it('degrades to no ticket when git times out', () => {
      expect(
        branchTicket(failingWith(new SubprocessTimeoutError('too slow'))),
      ).toEqual([null, null, 'none']);
    });

    it('propagates an error it does not model', () => {
      // The degradation is deliberately narrow: only "git is absent" and "git
      // hung" are survivable. Swallowing everything here would turn an
      // unexpected fault into a silent "no ticket".
      const boom = new Error('EACCES');
      expect(() => branchTicket(failingWith(boom))).toThrow(boom);
    });
  });
});
