/**
 * The `on:`-block reader (spec Phase 2).
 *
 * Reporting the trigger type is not decoration. #749's workflow is dormant
 * *because* it is label-gated, and a reader told only "has not run" will
 * reasonably go hunting for a break that is not there. These tests pin the
 * clause each trigger shape produces, because the clause is the whole
 * difference between a fact and an explanation.
 */
import { describe, expect, it } from 'vitest';
import { describeTriggers } from '../src/analysis/batwoman/triggers.js';

describe('describeTriggers', () => {
  it("names the label gate for #749's real on: block", () => {
    // Verbatim from .github/workflows/refresh-arch-baseline.yml, the workflow
    // whose dormancy is batwoman's founding case.
    expect(describeTriggers({ pull_request: { types: ['labeled'] } })).toBe(
      'triggered only when a label is added to a pull request',
    );
  });

  it('names the branches a push trigger is limited to', () => {
    expect(describeTriggers({ push: { branches: ['main'] } })).toBe(
      'triggered on push to main',
    );
  });

  it('calls a manual-only workflow manual, because that reads as dormant', () => {
    expect(describeTriggers({ workflow_dispatch: null })).toBe(
      'triggered only manually',
    );
  });

  it('names a schedule without reciting the cron expression', () => {
    expect(describeTriggers({ schedule: [{ cron: '0 3 * * *' }] })).toBe(
      'triggered on a schedule',
    );
  });

  it('joins multiple triggers, and drops "only" once there is more than one', () => {
    const clause = describeTriggers({
      workflow_dispatch: null,
      push: { branches: ['main'] },
    });
    expect(clause).toBe('triggered on push to main, or manually');
    expect(clause).not.toContain('only');
  });

  it('handles the bare list form GitHub also accepts', () => {
    expect(describeTriggers(['push', 'workflow_dispatch'])).toBe(
      'triggered on push, or manually',
    );
  });

  it('reads a boolean `true` key, because YAML 1.1 resolves `on:` to a bool', () => {
    // js-yaml 5.4.1 keeps `on` a string key, verified in this repo -- so this
    // is defence, not a current bug. Under a YAML 1.1 resolver (and js-yaml's
    // own default schema historically) an unquoted `on:` becomes boolean true,
    // and the block silently disappears. A parser change must not turn every
    // workflow's explanation into silence, so the boolean key is accepted and
    // the case is pinned here rather than left to be rediscovered.
    const doc: Record<string, unknown> = { true: { push: null } };
    expect(describeTriggers(doc['true'])).toBe('triggered on push');
  });

  it('handles a bare `pull_request:` with no config block', () => {
    // `on:\n  pull_request:` parses the value as null. It is one of the most
    // common shapes in any repo, and it is NOT label-gated -- reading it as
    // dormant would tell a reader the opposite of the truth.
    const clause = describeTriggers({ pull_request: null });
    expect(clause).toBe('triggered on a pull request');
    expect(clause).not.toContain('only');
  });

  it('does not enumerate branches when a push is limited to several', () => {
    // One branch is worth naming; a list is noise in a one-line clause, and
    // truncating it would misreport which branches are covered.
    expect(describeTriggers({ push: { branches: ['main', 'develop'] } })).toBe(
      'triggered on push',
    );
  });

  it('returns null for a shape it cannot read, rather than inventing a clause', () => {
    // The probe degrades to a bare "has not run" sentence when this is null.
    // Guessing a trigger would put a fabricated cause in a human's report.
    expect(describeTriggers(undefined)).toBeNull();
    expect(describeTriggers(null)).toBeNull();
    expect(describeTriggers('nonsense')).toBeNull();
    expect(describeTriggers({})).toBeNull();
  });

  it('ignores trigger names it does not recognise rather than echoing them', () => {
    expect(describeTriggers({ some_future_event: null })).toBeNull();
  });
});
