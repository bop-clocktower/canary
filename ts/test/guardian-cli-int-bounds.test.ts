/**
 * `parsePositiveInt` closed the `abc`/`0`/`-1` holes in `precision --days` and
 * `watch --interval`, but it still admits integers the consumers cannot hold:
 *
 * - `precision --days 1000000000` moves the window start past the largest
 *   representable Date, so `toISOString()` throws `RangeError: Invalid time
 *   value` -- the exact crash the parser was added to prevent.
 * - `watch --interval 2147484` is 2,147,484,000 ms, past setTimeout's 32-bit
 *   ceiling (2,147,483,647 ms). Node then clamps the delay to 1 ms, so the
 *   "24-day" poll loop spins every millisecond -- the zero-delay loop the
 *   parser's own doc comment says it rules out.
 *
 * Both must be usage errors (exit 2) before any work starts.
 */

import { describe, expect, it } from 'vitest';

import { FakeAdjudicationSource } from '../src/guardian/adjudication-github.js';
import { WatchInterruptError } from '../src/guardian/cli.js';
import { invokeGuardian } from './guardian-cli-testkit.js';

describe('guardian integer options reject values their consumers overflow', () => {
  it('precision --days past the Date range is a usage error, not a RangeError crash', async () => {
    const source = new FakeAdjudicationSource({ merged: [] });
    const res = await invokeGuardian(['precision', '--days', '1000000000'], {
      env: { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'o/r' },
      deps: { buildAdjudicationSource: () => source },
    }).catch((err: unknown) => ({ code: -1, thrown: err }));
    expect(res.code).toBe(2);
  });

  it('watch --interval past the setTimeout ceiling is a usage error, never a 1 ms poll loop', async () => {
    const slept: number[] = [];
    const res = await invokeGuardian(['watch', '--interval', '2147484'], {
      deps: {
        sleep: async (secs: number) => {
          slept.push(secs);
          throw new WatchInterruptError();
        },
      },
    });
    expect({ code: res.code, slept }).toEqual({ code: 2, slept: [] });
  });

  it('the largest interval setTimeout can hold is still accepted', async () => {
    const slept: number[] = [];
    const res = await invokeGuardian(['watch', '--interval', '2147483'], {
      deps: {
        sleep: async (secs: number) => {
          slept.push(secs);
          throw new WatchInterruptError();
        },
      },
    });
    expect({ code: res.code, slept }).toEqual({ code: 0, slept: [2147483] });
  });
});
