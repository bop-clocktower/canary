// otel_bootstrap/playwright-fixture.ts
//
// withTestSpan(base) wraps a Playwright `test` object with an `auto`
// fixture that opens one root span per test (test.id/test.title/test.file
// attributes), activates it as the OTel active context so the test's HTTP
// calls nest as child spans (the whole correlation trick this skill relies
// on), and closes it in teardown with test.outcome set from
// testInfo.status. Merge into your own fixtures.ts:
//
//   import { test as base } from '@playwright/test';
//   import { withTestSpan } from './otel_bootstrap/playwright-fixture';
//   export const test = withTestSpan(base);
//
// Root-span-via-fixture (not a custom reporter) is deliberate — reporters
// run in Playwright's main process and can't establish the OTel active
// context the HTTP auto-instrumentation needs to nest child spans. See
// docs/adr/0006-otel-test-side-tracing.md.

import type { TestType } from '@playwright/test';
import { trace, context } from '@opentelemetry/api';

const tracer = trace.getTracer('canary-instrument');

export function withTestSpan<T extends TestType<any, any>>(base: T): T {
  return base.extend({
    _rootSpan: [
      async ({}, use, testInfo) => {
        const span = tracer.startSpan(testInfo.title, {
          attributes: {
            'test.id': testInfo.titlePath.join(':'),
            'test.title': testInfo.title,
            'test.file': testInfo.file,
          },
        });
        await context.with(trace.setSpan(context.active(), span), async () => {
          await use();
        });
        span.setAttribute('test.outcome', testInfo.status ?? 'unknown');
        span.end();
      },
      { auto: true },
    ] as any,
  }) as T;
}
