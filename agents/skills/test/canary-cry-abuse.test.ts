/**
 * canary-cry's abuse patterns at every intensity (#608 P4), as the sequence
 * of session actions each one performs. The session API (runtime/session.mjs)
 * is what a pattern is written against, so recording its calls pins WHAT a
 * pattern does to a flow at i1, i2 and i3 -- the catalog's words, made
 * checkable. The real browser half is the cry-e2e suite.
 */
import { describe, expect, it } from 'vitest';

import { PATTERNS as CATALOG } from '../claude-code/canary-cry/scripts/patterns.mjs';
import { inject } from '../claude-code/canary-cry/scripts/runtime/abuse.mjs';

const ANCHOR = 2;

/** A session whose every action records `name(args)` and resolves. */
function recorder() {
  const calls: string[] = [];
  let pages = 0;
  const log =
    (name: string, value: unknown = undefined) =>
    async (...args: unknown[]) => {
      const shown = args.map((a) =>
        a === undefined ? 'undefined' : JSON.stringify(a),
      );
      calls.push(`${name}(${shown.join(', ')})`);
      return value;
    };
  const newPage = async () => {
    pages += 1;
    calls.push(`page -> p${pages}`);
    return `p${pages}`;
  };
  const act = {
    page: newPage,
    tab: async (from: string) => {
      pages += 1;
      calls.push(`tab(${from}) -> p${pages}`);
      return `p${pages}`;
    },
    pre: log('pre'),
    fire: log('fire'),
    expire: log('expire'),
    pause: log('pause'),
    slow: log('slow'),
    leave: log('leave'),
    close: log('close'),
    peek: log('peek'),
    signOut: log('signOut'),
    switchTo: log('switchTo', true),
    hold: async (page: string, mode: string) => {
      calls.push(`hold("${page}", "${mode}")`);
      return {
        reached: Promise.resolve(),
        release: () => calls.push('release'),
      };
    },
    post: async (page: string, from: number, opts?: any) => {
      calls.push(`post("${page}", ${from}${opts ? ', each' : ''})`);
      // Invoke the per-step hook twice: enough to prove it repeats.
      if (opts?.before) for (let i = 0; i < 2; i += 1) await opts.before();
    },
  };
  return { calls, act };
}

async function runAt(pattern: string, intensity: number) {
  const { calls, act } = recorder();
  await inject({ scenario: { pattern, intensity }, act, anchor: ANCHOR });
  return calls;
}

describe('multi-submit: 2x @ no throttle / 3x @ 400 ms / 5x @ 3 s', () => {
  it.each<[number, string[]]>([
    [1, []],
    [2, ['slow("p1", 400)']],
    [3, ['slow("p1", 3000)']],
  ])('i%s fires the write as one burst under its latency', async (n, slow) => {
    const times = { 1: 2, 2: 3, 3: 5 }[n];
    expect(await runAt('multi-submit', n)).toEqual([
      'page -> p1',
      'pre("p1", 0, 2)',
      ...slow,
      `fire("p1", {"times":${times}})`,
      'post("p1", 3)',
    ]);
  });
});

describe('abandon-midflow: back / reload / context.close()', () => {
  it.each(['back', 'reload'])(
    'i1, i2 abandon after the write by %s, re-enter and complete',
    async (how) => {
      const n = how === 'back' ? 1 : 2;
      expect(await runAt('abandon-midflow', n)).toEqual([
        'page -> p1',
        'pre("p1", 0, 3)',
        `leave("p1", "${how}")`,
        'post("p1", 0)',
      ]);
    },
  );

  it('i3 closes the context and never re-enters: the flow cannot complete', async () => {
    expect(await runAt('abandon-midflow', 3)).toEqual([
      'page -> p1',
      'pre("p1", 0, 3)',
      'close("p1")',
    ]);
    // ...which is why the catalog lets i3, and only i3, pass on a refusal.
    const flags = CATALOG.find((p: any) => p.id === 'abandon-midflow')!;
    expect(flags.mayRefuse).toEqual([false, false, true]);
  });
});

describe('stale-optimistic: delay past UI timeout / fake 500 / drop', () => {
  it.each<[number, string]>([
    [1, 'hold'],
    [2, 'fail'],
    [3, 'drop'],
  ])(
    'i%s lets the write reach the server, answers it as %s, and the user retries',
    async (n, mode) => {
      expect(await runAt('stale-optimistic', n)).toEqual([
        'page -> p1',
        'pre("p1", 0, 2)',
        `hold("p1", "${mode}")`,
        'fire("p1", {"wait":false})',
        'pause(1500)',
        'fire("p1", {"wait":false,"quiet":true})',
        'release',
        'post("p1", 3)',
      ]);
    },
  );
});

describe('duplicate-tab: 2 / 3 / 3 tabs racing', () => {
  it.each<[number, number]>([
    [1, 2],
    [2, 3],
    [3, 3],
  ])('i%s races %s tabs and completes in the first only', async (n, tabs) => {
    const calls = await runAt('duplicate-tab', n);
    const opened = Array.from({ length: tabs - 1 }, (_, i) => `p${i + 2}`);
    const all = ['p1', ...opened];
    expect(calls).toEqual([
      'page -> p1',
      ...opened.map((p) => `tab(p1) -> ${p}`),
      ...all.map((p) => `pre("${p}", 0, 2)`),
      ...all.map((p) => `fire("${p}")`),
      'post("p1", 3)',
    ]);
  });
});

describe('token-expiry: before the write / between writes / before every step', () => {
  it('i1 clears the session before the write and continues', async () => {
    expect(await runAt('token-expiry', 1)).toEqual([
      'page -> p1',
      'pre("p1", 0, 2)',
      'expire("p1")',
      'post("p1", 2)',
    ]);
  });

  it('i2 lets the first write through, then clears the session', async () => {
    expect(await runAt('token-expiry', 2)).toEqual([
      'page -> p1',
      'pre("p1", 0, 2)',
      'fire("p1")',
      'expire("p1")',
      'post("p1", 3)',
    ]);
  });

  it('i3 clears the session before every step from the write on', async () => {
    expect(await runAt('token-expiry', 3)).toEqual([
      'page -> p1',
      'pre("p1", 0, 2)',
      'post("p1", 2, each)',
      'expire("p1")',
      'expire("p1")',
    ]);
  });
});

describe('shared-machine: sign-out / sign-out + back / no sign-out', () => {
  const tail = ['switchTo("B", "p1")', 'post("p1", 0)'];

  it('i1 signs A out, then B signs in on the same context', async () => {
    expect(await runAt('shared-machine', 1)).toEqual([
      'page -> p1',
      'pre("p1", 0, undefined)',
      'signOut("p1")',
      ...tail,
    ]);
  });

  it("i2 also presses back after sign-out, and B's view of it is scanned", async () => {
    expect(await runAt('shared-machine', 2)).toEqual([
      'page -> p1',
      'pre("p1", 0, undefined)',
      'signOut("p1")',
      'peek("p1")',
      ...tail,
    ]);
  });

  it('i3 never signs A out', async () => {
    expect(await runAt('shared-machine', 3)).toEqual([
      'page -> p1',
      'pre("p1", 0, undefined)',
      ...tail,
    ]);
  });
});
