/**
 * canary-cry's live gate (#608 P2, ADR 0046 decisions 2 and 5): which targets
 * may ever be driven, and the account env vars a run needs. Pure: these
 * functions never read the network, so "zero target requests" is proven by
 * construction here and by the import-closure test (canary-cry-tier).
 *
 * The prodHosts rule is deliberately conservative. A refusal that should not
 * have happened costs a config edit; a run that should have been refused
 * costs real data. So `*.example.com` also covers the apex `example.com`, and
 * a wildcard `hosts` entry is refused when it could reach any prod host.
 */
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_ENVIRONMENTS,
  accountEnvErrors,
  gateTarget,
} from '../claude-code/canary-cry/scripts/gate.mjs';

function targets(
  over: Record<string, unknown> = {},
  prodHosts = ['*.prod.example'],
): any {
  return {
    version: 1,
    prodHosts,
    targets: {
      staging: {
        baseURL: 'https://staging.example.test',
        environment: 'staging',
        hosts: ['staging.example.test'],
        accounts: { A: { env: 'CRY_A' }, B: { env: 'CRY_B' } },
        ...over,
      },
    },
  };
}

describe('gateTarget: who may be driven at all (SC7)', () => {
  it('passes a listed non-prod target and hands back its spec', () => {
    const g: any = gateTarget(targets(), 'staging');
    expect(g.refusal).toBeNull();
    expect(g.target.name).toBe('staging');
    expect(g.target.spec.baseURL).toBe('https://staging.example.test');
  });

  it('refuses an unlisted target and names the declared ones', () => {
    const g = gateTarget(targets(), 'prod');
    expect(g.target).toBeNull();
    expect(g.refusal).toBe(
      "no target named 'prod' in targets.json (declared: staging)",
    );
  });

  it.each(ALLOWED_ENVIRONMENTS)('allows environment %s', (environment) => {
    expect(gateTarget(targets({ environment }), 'staging').refusal).toBeNull();
  });

  it.each(['production', 'prod', 'Staging', 'qa'])(
    'refuses environment %j (the allowed set is exact)',
    (environment) => {
      const g = gateTarget(targets({ environment }), 'staging');
      expect(g.target).toBeNull();
      expect(g.refusal).toBe(
        `target 'staging' declares environment '${environment}'; ` +
          `allowed: ${ALLOWED_ENVIRONMENTS.join(', ')}`,
      );
    },
  );

  it('refuses a baseURL whose host matches prodHosts', () => {
    const g = gateTarget(
      targets({
        baseURL: 'https://shop.prod.example:8443/app',
        hosts: ['staging.example.test'],
      }),
      'staging',
    );
    expect(g.refusal).toBe(
      "target 'staging' baseURL host 'shop.prod.example' matches prodHosts '*.prod.example'",
    );
  });

  it('refuses a hosts entry that matches prodHosts, naming its index', () => {
    const g = gateTarget(
      targets({ hosts: ['staging.example.test', 'API.Prod.Example'] }),
      'staging',
    );
    expect(g.refusal).toBe(
      "target 'staging' hosts[1] 'API.Prod.Example' matches prodHosts '*.prod.example'",
    );
  });

  it.each<[string, string]>([
    ['prod.example', '*.prod.example'], // a wildcard covers its apex
    ['a.b.prod.example', '*.prod.example'], // and any depth below it
    ['prod.example.', '*.prod.example'], // a trailing dot is the same host
    ['localhost:3000', 'localhost'], // a port does not hide the host
    ['*.example', '*.prod.example'], // a wider wildcard reaches prod
    ['*.shop.prod.example', '*.prod.example'], // a narrower one sits inside it
    ['shop.prod.example', 'shop.prod.example'], // exact
  ])('hosts entry %j overlaps prodHosts %j', (host, prod) => {
    const g = gateTarget(targets({ hosts: [host] }, [prod]), 'staging');
    expect(g.refusal).toMatch(
      /^target 'staging' hosts\[0\] .* matches prodHosts/,
    );
  });

  it.each<[string, string]>([
    ['staging.example.test', '*.prod.example'],
    ['notprod.example', '*.prod.example'], // a label boundary, not a substring
    ['prod.example.test', '*.prod.example'],
    ['*.staging.example', '*.prod.example'],
  ])('hosts entry %j does not overlap prodHosts %j', (host, prod) => {
    const g = gateTarget(
      targets({ baseURL: 'http://localhost:3000', hosts: [host] }, [prod]),
      'staging',
    );
    expect(g.refusal).toBeNull();
  });

  it('checks environment before hosts, so the first refusal is stable', () => {
    const g = gateTarget(
      targets({ environment: 'production', hosts: ['x.prod.example'] }),
      'staging',
    );
    expect(g.refusal).toMatch(/declares environment 'production'/);
  });

  it('has no override: an empty prodHosts still refuses a prod environment', () => {
    const g = gateTarget(targets({ environment: 'production' }, []), 'staging');
    expect(g.refusal).not.toBeNull();
  });
});

describe('accountEnvErrors: credentials by name only (SC23)', () => {
  const spec = targets().targets.staging;
  const ok = JSON.stringify({ email: 'a@x.test', password: 'hunter2', id: 7 });

  it('passes when every declared account holds a JSON object', () => {
    expect(accountEnvErrors(spec, { CRY_A: ok, CRY_B: ok })).toEqual([]);
  });

  it('names an unset variable and the account it serves', () => {
    expect(accountEnvErrors(spec, { CRY_A: ok })).toEqual([
      'account B: environment variable CRY_B is not set',
    ]);
  });

  it.each(['not json', '[1,2]', '"text"', 'null', '42'])(
    'rejects %j as not a JSON object, without echoing it',
    (value) => {
      const errors = accountEnvErrors(spec, { CRY_A: value, CRY_B: ok });
      expect(errors).toEqual([
        'account A: environment variable CRY_A does not hold a JSON object',
      ]);
      expect(errors.join('\n')).not.toContain(value);
    },
  );

  it('never puts a value in an error, even a secret-shaped one', () => {
    const secret = '{"password": "s3cr3t-planted"';
    const errors = accountEnvErrors(spec, { CRY_A: secret, CRY_B: ok });
    expect(errors.join('\n')).not.toContain('s3cr3t-planted');
  });

  it('is empty for a target that declares no accounts', () => {
    const { accounts, ...bare } = spec;
    expect(accounts).toBeDefined();
    expect(accountEnvErrors(bare, {})).toEqual([]);
  });
});
