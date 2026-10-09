/**
 * bug-fleet A1: `ticket-update` exits non-zero only when the transition reason
 * starts with the warning glyph. A transition the updater attempted and that
 * did not succeed ("transition API call failed") prints "Transition failed"
 * and still exits 0, so a CI step gating on `$?` reads a failed ticket update
 * as success.
 */

import { describe, expect, it } from 'vitest';

import { TransitionResult, UpdateResult } from '../src/core/ticket-updater.js';
import { invokeCanary } from './canary-cli-testkit.js';

function failedTransition(): UpdateResult {
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
      'transition API call failed',
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
    expect(res.code).not.toBe(0);
  });
});
