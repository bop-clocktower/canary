/**
 * #1283 (bug-fleet A1): `ticket-update` used to exit non-zero only when the
 * transition reason started with the warning glyph. A transition the updater
 * attempted and that did not succeed ("transition API call failed", or a
 * target status the workflow cannot reach) printed "Transition failed" and
 * still exited 0, so a CI step gating on `$?` read a failed ticket update as
 * success.
 */

import { describe, expect, it } from 'vitest';

import { TransitionResult, UpdateResult } from '../src/core/ticket-updater.js';
import { invokeCanary } from './canary-cli-testkit.js';

function failedTransition(reason = 'transition API call failed'): UpdateResult {
  return new UpdateResult({
    ticket_key: 'PROJ-1',
    project_key: 'PROJ',
    linkage_source: 'branch',
    comment_posted: true,
    transition: new TransitionResult(
      true,
      false,
      'In Progress',
      'Done',
      reason,
    ),
    dry_run: false,
    messages: [],
  });
}

describe('ticket-update: a failed transition is not a success', () => {
  it('exits non-zero when an attempted transition did not succeed', async () => {
    const res = await invokeCanary(['ticket-update'], {
      deps: {
        makeTicketUpdater: () =>
          ({ update: async () => failedTransition() }) as never,
      },
    });
    // Exit 1, like the command's other failed-action exits (exit 2 is reserved
    // for "the invocation has to change").
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('Transition failed');
  });

  it('exits non-zero when the target status is not reachable', async () => {
    // transitionJira reports an unreachable target as attempted=true,
    // succeeded=false with no warning glyph; the CHANGELOG entry names it.
    const res = await invokeCanary(['ticket-update'], {
      deps: {
        makeTicketUpdater: () =>
          ({
            update: async () =>
              failedTransition(
                'Transition to "Done" is not reachable from "In Progress" ' +
                  'for PROJ-1. No transition attempted.',
              ),
          }) as never,
      },
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('Transition failed');
  });

  it('still exits 0 on --dry-run, where an attempted transition is never executed', async () => {
    // transitionJira reports a dry run as attempted=true, succeeded=false.
    const dryRun = new UpdateResult({
      ticket_key: 'PROJ-1',
      project_key: 'PROJ',
      linkage_source: 'branch',
      comment_posted: true,
      transition: new TransitionResult(
        true,
        false,
        'In Progress',
        'Done',
        'dry-run',
      ),
      dry_run: true,
      messages: [],
    });
    const res = await invokeCanary(['ticket-update', '--dry-run'], {
      deps: {
        makeTicketUpdater: () => ({ update: async () => dryRun }) as never,
      },
    });
    expect(res.code).toBe(0);
  });
});
