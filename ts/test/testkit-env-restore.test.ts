/**
 * The CLI testkits must restore EVERY env key they touch — including
 * caller-supplied overrides outside their fixed key lists.
 *
 * Found by canary-savant (SV003) once #495 fixed its precision: both testkits
 * snapshot only their fixed `*_ENV_KEYS` lists, but the `env` option applies
 * arbitrary caller keys — so an off-list override leaked into `process.env` for
 * every later test in the worker. A latent order-dependence bug in the tools
 * that exist to catch order-dependence bugs.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { invokeCanary } from './canary-cli-testkit.js';
import { invokeGuardian } from './guardian-cli-testkit.js';

const OFF_LIST_KEY = 'CANARY_TESTKIT_LEAK_PROBE';

// Each test seeds its own pre-state; this teardown guarantees the probe key
// never outlives a test regardless of assertion failures.
afterEach(() => {
  delete process.env[OFF_LIST_KEY];
});

describe('guardian testkit env hygiene', () => {
  it('restores an off-list override after the run', async () => {
    expect(process.env[OFF_LIST_KEY]).toBeUndefined();
    await invokeGuardian(['--help'], { env: { [OFF_LIST_KEY]: 'leaked?' } });
    expect(process.env[OFF_LIST_KEY]).toBeUndefined();
  });

  it('restores an off-list override to its PRIOR value, not just deletes', async () => {
    process.env[OFF_LIST_KEY] = 'original';
    await invokeGuardian(['--help'], { env: { [OFF_LIST_KEY]: 'override' } });
    expect(process.env[OFF_LIST_KEY]).toBe('original');
  });

  it('restores when the override is an explicit undefined (deletion)', async () => {
    process.env[OFF_LIST_KEY] = 'original';
    await invokeGuardian(['--help'], { env: { [OFF_LIST_KEY]: undefined } });
    expect(process.env[OFF_LIST_KEY]).toBe('original');
  });
});

describe('canary testkit env hygiene', () => {
  it('restores an off-list override after the run', async () => {
    expect(process.env[OFF_LIST_KEY]).toBeUndefined();
    await invokeCanary(['version'], { env: { [OFF_LIST_KEY]: 'leaked?' } });
    expect(process.env[OFF_LIST_KEY]).toBeUndefined();
  });

  it('restores an off-list override to its PRIOR value', async () => {
    process.env[OFF_LIST_KEY] = 'original';
    await invokeCanary(['version'], { env: { [OFF_LIST_KEY]: 'override' } });
    expect(process.env[OFF_LIST_KEY]).toBe('original');
  });
});
