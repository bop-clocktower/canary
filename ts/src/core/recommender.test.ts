import { afterEach, describe, expect, it } from 'vitest';

import { FrameworkRecommender, licenseAllowed } from './recommender.js';
import type { Framework } from './framework-registry.js';

const rec = new FrameworkRecommender();
const cls = (test_type: string, confidence = 0.9) => ({
  intent: 'generate_tests',
  test_type,
  confidence,
});

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CANARY_')) delete process.env[k];
  }
  Object.assign(process.env, SAVED);
});

describe('licenseAllowed', () => {
  const gated = (extra: Partial<Framework>): Framework => ({
    name: 'x',
    license_gate: 'CANARY_LICENSE_X',
    ...extra,
  });

  it('passes ungated frameworks', () => {
    expect(licenseAllowed({ name: 'oss' })).toBe(true);
  });
  it('blocks a gated framework when the env var is unset', () => {
    delete process.env['CANARY_LICENSE_X'];
    expect(licenseAllowed(gated({}))).toBe(false);
  });
  it('blocks on falsey gate values', () => {
    process.env['CANARY_LICENSE_X'] = 'off';
    expect(licenseAllowed(gated({}))).toBe(false);
  });
  it('unlocks on a truthy gate value', () => {
    process.env['CANARY_LICENSE_X'] = '1';
    expect(licenseAllowed(gated({}))).toBe(true);
  });
  it('enforces scope membership when license_scopes is set', () => {
    process.env['CANARY_LICENSE_X'] = 'team-a';
    expect(licenseAllowed(gated({ license_scopes: ['team-b'] }))).toBe(false);
    expect(licenseAllowed(gated({ license_scopes: ['team-a'] }))).toBe(true);
  });
});

describe('observability reporting-sink routing', () => {
  it('ranks the overlay dashboard first when CANARY_SCOPE is set', () => {
    process.env['CANARY_SCOPE'] = 'acme';
    const out = rec.recommend(cls('observability'));
    expect(out[0]!.framework).toBe('acme-dashboard');
    expect(out[0]!.kind).toBe('reporting-sink');
    expect(out.some((c) => c.framework === 'reportportal')).toBe(true);
  });
});
