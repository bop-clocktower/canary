// route_fixture/playwright-fixture.mjs
//
// withMisfit(base, options) wraps a Playwright `test` object with an `auto`
// fixture that installs one `page.route('**/*')` handler per test. Every
// request is offered to the seeded decision engine in `../profiles.mjs`; a
// fault that fires is applied (delay, 5xx fulfil, abort) and appended to a
// JSONL ledger, and everything else continues untouched.
//
//   import { test as base } from '@playwright/test';
//   import { withMisfit } from './route_fixture/playwright-fixture.mjs';
//   export const test = withMisfit(base, {
//     profilePath: 'misfit/flaky-upstream.json',
//     ledgerPath: 'test-results/misfit-ledger.jsonl',
//   });
//
// Composition with `canary-instrument` is OPTIONAL and works by chaining the
// two wrappers -- `withMisfit(withTestSpan(base), ...)`. Neither reads the
// other's artifact and neither requires the other (proposal D2).
//
// Shipped, not executed by canary's own CI: Playwright is not a dependency of
// this repo, so this file is excluded from the coverage gate exactly as
// canary-instrument's OTel bootstrap is. Its decision-making lives in
// ../profiles.mjs, which IS covered.

import fs from 'node:fs';
import path from 'node:path';

import { validateProfile, decide } from '../profiles.mjs';

/** Load + validate a profile file, throwing with every error at once. */
export function loadProfileFile(profilePath) {
  const { profile, errors } = validateProfile(
    JSON.parse(fs.readFileSync(profilePath, 'utf8')),
  );
  if (errors.length) {
    throw new Error(
      `canary-misfit: invalid profile ${profilePath}:\n  ${errors.join('\n  ')}`,
    );
  }
  return profile;
}

/** Append one ledger row; a ledger write must never fail the test run. */
export function appendLedger(ledgerPath, row) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(ledgerPath)), { recursive: true });
    fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    // Losing a ledger row costs a verdict, not a run. The CLI reports the
    // resulting flow as `unexercised`, which is an abstention, not a pass.
  }
}

/**
 * The route handler, built as a pure-ish factory so it can be exercised with a
 * fake `route` object. `ordinals` counts repeats of the same method+url within
 * one flow, which is what makes the seeded decision reproducible without
 * depending on arrival order (proposal D5).
 */
export function createRouteHandler({
  profile,
  ledgerPath,
  flow,
  ordinals = new Map(),
}) {
  return async function handle(route, request) {
    const method = request.method();
    const url = request.url();
    const key = `${method} ${url}`;
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);

    const fired = decide(profile, { method, url, ordinal });
    if (!fired) return route.continue();

    const { fault, action } = fired;
    appendLedger(ledgerPath, {
      test_id: flow.id,
      test_title: flow.title,
      test_file: flow.file,
      fault_id: fault.id,
      kind: fault.kind,
      method,
      url,
      ordinal,
      action: action.type,
      delay_ms: action.type === 'delay' ? action.delay_ms : 0,
      status: action.status ?? null,
    });

    if (action.type === 'abort') return route.abort(action.reason);
    if (action.type === 'fulfill') {
      return route.fulfill({
        status: action.status,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'canary-misfit injected fault',
          fault: fault.id,
        }),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, action.delay_ms));
    return route.continue();
  };
}

/** Wrap a Playwright `test` with the route-layer injector. */
export function withMisfit(
  base,
  { profilePath, ledgerPath = 'test-results/misfit-ledger.jsonl' },
) {
  const profile = loadProfileFile(profilePath);
  return base.extend({
    _misfit: [
      async ({ page }, use, testInfo) => {
        const flow = {
          id: testInfo.titlePath.join(':'),
          title: testInfo.title,
          file: testInfo.file,
        };
        await page.route(
          '**/*',
          createRouteHandler({ profile, ledgerPath, flow }),
        );
        await use();
      },
      { auto: true },
    ],
  });
}
