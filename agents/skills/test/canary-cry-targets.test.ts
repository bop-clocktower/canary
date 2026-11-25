/**
 * canary-cry targets.json schema (#608 P1, SC5).
 *
 * Shape only. Which environments may run and which hosts are production are
 * the live gate's rules (#608 P2, exit 4 per ADR 0046): a schema check that
 * refused `environment: "production"` would report a safety stop as a typo
 * (exit 2), which is exactly the confusion ADR 0046 gave exit 4 to prevent.
 */
import { describe, expect, it } from 'vitest';

import { validateTargets } from '../claude-code/canary-cry/scripts/schema-targets.mjs';

// Split in two so neither factory nests past the arch nestingDepth threshold
// (4). Each call still returns a fresh copy for the test to mutate.
function stagingTarget(): any {
  return {
    baseURL: 'https://staging.example.test',
    environment: 'staging',
    hosts: ['staging.example.test'],
    accounts: {
      A: { env: 'CRY_ACCOUNT_A' },
      B: { env: 'CRY_ACCOUNT_B' },
    },
    auth: {
      signIn: 'login',
      signOut: 'logout',
      sessionKeys: ['cookie:session'],
    },
  };
}

function targetsDoc(): any {
  return {
    version: 1,
    prodHosts: ['*.example.com'],
    targets: { staging: stagingTarget() },
  };
}

function errorsAfter(
  mutate: (doc: any) => void,
  flowIds: Set<string> | null = null,
): string[] {
  const doc = targetsDoc();
  mutate(doc);
  return validateTargets(doc, flowIds);
}

const staging = '$.targets.staging';

describe('validateTargets', () => {
  it('accepts the spec-shaped document', () => {
    expect(validateTargets(targetsDoc())).toEqual([]);
  });

  it('leaves environment and prodHosts policy to the live gate', () => {
    expect(
      errorsAfter((d) => (d.targets.staging.environment = 'production')),
    ).toEqual([]);
    expect(
      errorsAfter((d) => (d.targets.staging.hosts = ['shop.example.com'])),
    ).toEqual([]);
  });

  it.each<[string, (d: any) => void, string]>([
    ['version', (d) => (d.version = 0), '$.version: must be 1'],
    [
      'prodHosts',
      (d) => delete d.prodHosts,
      '$.prodHosts: must be an array (it may be empty)',
    ],
    [
      'empty targets',
      (d) => (d.targets = {}),
      '$.targets: must declare at least one target',
    ],
    [
      'target name',
      (d) => (d.targets['my target'] = d.targets.staging),
      '$.targets["my target"]: name must match /^[a-z0-9][a-z0-9-]*$/',
    ],
    [
      'baseURL',
      (d) => (d.targets.staging.baseURL = 'ftp://staging.example.test'),
      `${staging}.baseURL: must be an http(s) URL`,
    ],
    [
      'unparseable baseURL',
      (d) => (d.targets.staging.baseURL = 'not a url'),
      `${staging}.baseURL: must be an http(s) URL`,
    ],
    [
      'hosts',
      (d) => (d.targets.staging.hosts = []),
      `${staging}.hosts: must be a non-empty array`,
    ],
    [
      'account env',
      (d) => (d.targets.staging.accounts.A.env = 'cry_a'),
      `${staging}.accounts.A.env: must name an environment variable`,
    ],
    [
      'secret in an account',
      (d) => (d.targets.staging.accounts.A.password = 'hunter2'),
      `${staging}.accounts.A.password: unknown key`,
    ],
    [
      'session key',
      (d) => (d.targets.staging.auth.sessionKeys = ['session']),
      `${staging}.auth.sessionKeys[0]: must be cookie:, localStorage: or sessionStorage:<key>`,
    ],
    [
      'auth flow',
      (d) => delete d.targets.staging.auth.signOut,
      `${staging}.auth.signOut: must be a non-empty string`,
    ],
  ])('names the JSON path of a bad %s', (_label, mutate, expected) => {
    expect(errorsAfter(mutate)).toContain(expected);
  });

  it('cross-checks auth flow names against flows.json when given its ids', () => {
    expect(errorsAfter(() => {}, new Set(['login', 'logout']))).toEqual([]);
    expect(errorsAfter(() => {}, new Set(['checkout']))).toEqual([
      `${staging}.auth.signIn: names no flow in flows.json ('login')`,
      `${staging}.auth.signOut: names no flow in flows.json ('logout')`,
    ]);
  });
});
