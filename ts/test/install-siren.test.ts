/**
 * Contract tests for `scripts/install-siren.mjs` (#758).
 *
 * The defect: `hooks/canary-deep-siren.sh` declared its own launchd label in a
 * header comment, and nothing ever created the agent. Every network-level
 * canary check — marketplace-vs-upstream, CLI-vs-npm-latest, the `canary
 * doctor` skip probe from #505 — was dark from the day the script was written.
 *
 * That is the most extreme form of #508's zero-denominator green: not a gate
 * that verified zero items, but a gate that never ran at all. Both produce the
 * same user-visible signal (no complaint), and the second has even less behind
 * it.
 *
 * So the two properties under test here are the ones that keep the fix from
 * reproducing the bug:
 *
 *   1. **Registration is not execution.** `schedulerStatus` must distinguish
 *      `never-ran` from `stale` from `healthy`, and must never report a
 *      registered-but-silent agent as healthy. An absent log means zero runs —
 *      the deep siren's healthy path calls `note` unconditionally, so there is
 *      no "it ran and was clean" reading of silence.
 *   2. **A monitor that would emit false findings must not be installed.**
 *      launchd hands a job a minimal environment and `mise activate` lives in
 *      an interactive-only rc file, so an agent inheriting launchd's PATH
 *      reports "CLI missing" every week. That is noise from the very tool that
 *      exists to catch false greens, and it teaches the reader to ignore it.
 *
 * Offline: pure functions plus injected fakes. Nothing here touches launchctl,
 * writes a plist, or spawns a shell.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

interface Status {
  ok: boolean;
  state: string;
  detail: string;
}

/**
 * The gate scripts under `scripts/` are `.mjs` with no type declarations, by
 * design — they run under bare node in CI with no build step. Loading this one
 * through a computed specifier keeps tsc from demanding a `.d.ts` for a file
 * that will never have one, and matches how the rest of the suite treats these
 * scripts: by path, never as a package.
 */
interface SirenModule {
  LABEL: string;
  STALE_DAYS: number;
  divergentCopies: (
    home?: string,
    read?: (p: string, enc: string) => string,
  ) => string[];
  absentHooks: (
    home?: string,
    read?: (p: string, enc: string) => string,
  ) => string[];
  installHooks: (
    home?: string,
    now?: Date,
  ) => { name: string; action: string; backup?: string; source?: string }[];
  SIREN_HOOKS: readonly string[];
  interactivePath: (run?: unknown) => {
    path: string;
    degraded: boolean;
    reason?: string;
  };
  isRegistered: (run?: unknown) => boolean;
  renderPlist: (
    template: string,
    vals: { script: string; path: string; home: string },
  ) => string;
  resolveCanary: (path: string, run?: unknown) => string | undefined;
  schedulerStatus: (args: {
    registered: boolean;
    ageDays?: number | undefined;
    staleDays?: number | undefined;
  }) => Status;
}

const SCRIPT_URL = pathToFileURL(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'scripts',
    'install-siren.mjs',
  ),
).href;

const {
  LABEL,
  SIREN_HOOKS,
  STALE_DAYS,
  absentHooks,
  divergentCopies,
  installHooks,
  interactivePath,
  isRegistered,
  renderPlist,
  resolveCanary,
  schedulerStatus,
} = (await import(SCRIPT_URL)) as SirenModule;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const status = (args: {
  registered: boolean;
  // `| undefined` is load-bearing under exactOptionalPropertyTypes: the
  // never-ran case passes ageDays explicitly as undefined, and that state is
  // the one this suite most needs to be able to express.
  ageDays?: number | undefined;
  staleDays?: number | undefined;
}): Status => schedulerStatus(args) as Status;

describe('schedulerStatus — registration is not execution', () => {
  it('reports an unregistered agent as the dark state it is', () => {
    const s = status({ registered: false });
    expect(s.ok).toBe(false);
    expect(s.state).toBe('unregistered');
    expect(s.detail).toContain('dark');
  });

  it('separates never-ran from stale', () => {
    // The distinction is the point. "Registered" was the whole of #758's
    // proposed fix, and an agent that is registered but silent is the same
    // failure wearing a plist.
    expect(status({ registered: true, ageDays: undefined }).state).toBe(
      'never-ran',
    );
    expect(status({ registered: true, ageDays: 30 }).state).toBe('stale');
  });

  it('never calls a registered-but-silent agent healthy', () => {
    for (const ageDays of [undefined, STALE_DAYS + 0.1, 365]) {
      expect(status({ registered: true, ageDays }).ok).toBe(false);
    }
  });

  it('reads an absent log as zero runs, not as a clean run', () => {
    expect(status({ registered: true, ageDays: undefined }).detail).toContain(
      'zero executions, not zero findings',
    );
  });

  it('passes only a registered agent with a recent run', () => {
    const s = status({ registered: true, ageDays: 1 });
    expect(s.ok).toBe(true);
    expect(s.state).toBe('healthy');
  });

  it('allows a weekly cadence a grace day rather than firing on day 7', () => {
    // A weekly agent is legitimately ~7 days stale the moment before it fires.
    // A threshold of 7 would cry wolf every week, and an alarm that always
    // fires is an alarm nobody reads.
    expect(STALE_DAYS).toBeGreaterThan(7);
    expect(status({ registered: true, ageDays: 7 }).ok).toBe(true);
  });
});

describe('the plist template', () => {
  const template = readFileSync(
    join(REPO_ROOT, 'hooks', `${LABEL}.plist`),
    'utf-8',
  );

  it('is shipped as a repo artifact rather than a comment in the script', () => {
    // The literal #758 fix: the label lived only in a header comment, so
    // nothing could install it and nothing could notice it was missing.
    expect(template).toContain(LABEL);
    expect(template).toContain('StartCalendarInterval');
  });

  it('leaves no placeholder unsubstituted', () => {
    const rendered = renderPlist(template, {
      script: '/repo/hooks/canary-deep-siren.sh',
      path: '/opt/homebrew/bin:/usr/bin',
      home: '/Users/example',
    }) as string;
    expect(rendered).not.toMatch(/__[A-Z]+__/);
    expect(rendered).toContain('/repo/hooks/canary-deep-siren.sh');
    expect(rendered).toContain('/opt/homebrew/bin:/usr/bin');
  });

  it('pins an explicit PATH rather than inheriting launchd’s', () => {
    // Without this the weekly run reports "canary CLI missing" forever: mise
    // activates from an interactive rc file that launchd never sources.
    expect(template).toContain('EnvironmentVariables');
    expect(template).toContain('__PATH__');
  });

  it('routes stderr to a log so a crashing agent is not silent', () => {
    expect(template).toContain('StandardErrorPath');
  });
});

describe('environment resolution', () => {
  const fakeRun = (stdout: string) => () => ({ stdout }) as never;

  it('asks an interactive login shell for PATH, not the current process', () => {
    // `-l` sources the profile and `-i` sources the rc file where mise lives.
    // A login-only shell misses mise, which is the false "CLI missing" case.
    let argv: string[] = [];
    interactivePath(((_cmd: string, args: string[]) => {
      argv = args;
      return { stdout: '/from/shell' };
    }) as never);
    expect(argv[0]).toContain('l');
    expect(argv[0]).toContain('i');
  });

  it('reports a degraded PATH read instead of falling back silently', () => {
    // The install REFUSES on degraded. Silently returning the inherited PATH
    // bakes in an environment with no mise activation, which is exactly the
    // weekly false "canary CLI missing" the plist comment exists to prevent.
    const r = interactivePath(fakeRun('  ') as never);
    expect(r.degraded).toBe(true);
    expect(r.reason).toBeTruthy();
  });

  it('reports a clean read as not degraded', () => {
    const r = interactivePath((() => ({
      stdout: '/opt/homebrew/bin:/usr/bin',
      status: 0,
    })) as never);
    expect(r).toMatchObject({
      path: '/opt/homebrew/bin:/usr/bin',
      degraded: false,
    });
  });

  it('escapes XML entities so a & in PATH cannot break the plist', () => {
    const out = renderPlist('<string>__PATH__</string>', {
      script: 's',
      path: '/opt/a&b/bin',
      home: '/h',
    });
    expect(out).toContain('/opt/a&amp;b/bin');
    expect(out).not.toContain('a&b');
  });

  it('reports canary as unreachable rather than guessing a path', () => {
    // The install refuses on undefined. Returning a plausible-looking default
    // here would install an agent that reports a false finding every week.
    expect(resolveCanary('/nowhere', fakeRun('') as never)).toBeUndefined();
    expect(
      resolveCanary('/x', fakeRun('/opt/homebrew/bin/canary') as never),
    ).toBe('/opt/homebrew/bin/canary');
  });

  it('detects registration by label from launchctl output', () => {
    expect(isRegistered(fakeRun(`-\t0\t${LABEL}\n`) as never)).toBe(true);
    expect(isRegistered(fakeRun('-\t0\tcom.other.agent\n') as never)).toBe(
      false,
    );
  });
});

describe('hook state — absent, installed, divergent, unreadable', () => {
  // These four tests were previously vacuous and mutation-proved so: gutting
  // `divergentCopies` to `return []` left the whole file green. They passed
  // `homedir()` — the REAL home — and looped `for (const p of out)`, so on CI
  // (no ~/.claude/hooks) `out` was `[]`, the loop ran zero times, and nothing
  // was asserted. A test whose denominator is whatever happens to be in the
  // runner's home directory has a denominator of zero in CI. Now: a temp home,
  // real fixture files, and exact-array assertions.
  let home: string;
  const hookDir = () => join(home, '.claude', 'hooks');
  const machinePath = (n: string) => join(hookDir(), n);
  const repoText = (n: string) =>
    readFileSync(join(REPO_ROOT, 'hooks', n), 'utf-8');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'siren-state-'));
    mkdirSync(hookDir(), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('reports a hook that is not on the machine as absent', () => {
    // The zero-denominator green this split exists to close: `--verify` used
    // to report healthy on a machine with no session siren at all.
    expect(absentHooks(home)).toEqual(SIREN_HOOKS.map(machinePath));
    expect(divergentCopies(home)).toEqual([]);
  });

  it('flags a machine copy whose content differs', () => {
    for (const n of SIREN_HOOKS)
      writeFileSync(machinePath(n), 'stale', 'utf-8');
    expect(divergentCopies(home)).toEqual(SIREN_HOOKS.map(machinePath));
    expect(absentHooks(home)).toEqual([]);
  });

  it('stays quiet when the content matches exactly', () => {
    for (const n of SIREN_HOOKS)
      writeFileSync(machinePath(n), repoText(n), 'utf-8');
    expect(divergentCopies(home)).toEqual([]);
    expect(absentHooks(home)).toEqual([]);
  });

  it('separates absent from divergent rather than conflating them', () => {
    // Exactly one installed, one missing. The old code returned [] for both
    // and could not tell them apart.
    const [first, second] = SIREN_HOOKS as unknown as [string, string];
    writeFileSync(machinePath(first), 'stale', 'utf-8');
    expect(divergentCopies(home)).toEqual([machinePath(first)]);
    expect(absentHooks(home)).toEqual([machinePath(second)]);
  });

  it('treats an unreadable machine copy as a finding, not as identical', () => {
    // "Cannot verify" is a finding, not a skip.
    const n = SIREN_HOOKS[0] as string;
    writeFileSync(machinePath(n), 'x', 'utf-8');
    const exploding = (p: string): string => {
      if (p.startsWith(home)) throw new Error('EACCES');
      return 'repo';
    };
    expect(divergentCopies(home, exploding)).toEqual([machinePath(n)]);
  });

  it('reports rather than rewrites — ~/.claude belongs to the operator', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'scripts', 'install-siren.mjs'),
      'utf-8',
    );
    const fn = src.slice(
      src.indexOf('export function hookStates'),
      src.indexOf('export function installHooks'),
    );
    expect(fn).not.toContain('writeFileSync');
    expect(fn).not.toContain('rmSync');
    expect(fn).not.toContain('copyFileSync');
  });
});

describe('installHooks — one version of each siren on the machine', () => {
  // #758 follow-up, revised. The symlink this replaced pointed a machine-global
  // hook into a working tree that changes branches, so `git checkout` silently
  // uninstalled it: on 2026-09-08 the checkout sat on a branch without the #758
  // commits, both links dangled, and canary-session-siren.sh — a configured
  // SessionStart hook — failed on every session start.
  //
  // The original objection still stands and is tested below: copies drift in
  // BOTH directions and the machine copy HAS been ahead, so the displaced file
  // is always preserved and divergentCopies/--verify report drift rather than
  // letting it pass.
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'siren-home-'));
    mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('replaces a divergent regular file with a real copy of the tracked one', () => {
    const name = SIREN_HOOKS[0] as string;
    const target = join(home, '.claude', 'hooks', name);
    writeFileSync(target, 'stale contents\n', 'utf-8');

    installHooks(home);

    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf-8')).toBe(
      readFileSync(join(REPO_ROOT, 'hooks', name), 'utf-8'),
    );
  });

  it('installs a file that survives the repo moving to another branch', () => {
    // The regression this change exists for. A symlink into the working tree
    // dies the moment `git checkout` lands on a commit without these files;
    // a copy does not care what the repo is doing.
    const name = SIREN_HOOKS[0] as string;
    const target = join(home, '.claude', 'hooks', name);

    installHooks(home);

    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf-8').length).toBeGreaterThan(0);
  });

  it('clears a DANGLING symlink left by the previous install strategy', () => {
    // existsSync() follows links, so a broken link reports false: without an
    // explicit lstat it is neither backed up nor replaced, and the copy fails
    // on the leftover. This is the exact wreckage on a machine that ran the
    // old installer and then switched branches.
    const name = SIREN_HOOKS[0] as string;
    const target = join(home, '.claude', 'hooks', name);
    symlinkSync(join(home, 'nonexistent-target.sh'), target);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);

    const acted = installHooks(home);

    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf-8')).toBe(
      readFileSync(join(REPO_ROOT, 'hooks', name), 'utf-8'),
    );
    expect(acted.some((a) => a.action === 'backed-up')).toBe(true);
  });

  it('preserves the displaced file rather than deleting it', () => {
    // The machine copy was ahead once already. Never destroy the operator's
    // file to win a reconcile.
    const name = SIREN_HOOKS[0] as string;
    const target = join(home, '.claude', 'hooks', name);
    writeFileSync(target, 'irreplaceable\n', 'utf-8');

    const acted = installHooks(home).find((a) => a.action === 'backed-up');
    expect(acted?.backup).toBeDefined();
    expect(readFileSync(acted?.backup as string, 'utf-8')).toBe(
      'irreplaceable\n',
    );
  });

  it('is idempotent — a second run re-links nothing', () => {
    writeFileSync(
      join(home, '.claude', 'hooks', SIREN_HOOKS[0] as string),
      'x',
      'utf-8',
    );
    installHooks(home);
    const second = installHooks(home);
    expect(second.every((a) => a.action === 'already-installed')).toBe(true);
    expect(second.some((a) => a.action === 'backed-up')).toBe(false);
  });

  it('leaves divergentCopies clean afterwards', () => {
    // The two functions have to agree, or --verify fails forever on a machine
    // that install just reconciled.
    writeFileSync(
      join(home, '.claude', 'hooks', SIREN_HOOKS[0] as string),
      'stale',
      'utf-8',
    );
    installHooks(home);
    expect(divergentCopies(home)).toEqual([]);
  });

  it('does nothing when there is no hooks directory to reconcile', () => {
    const bare = mkdtempSync(join(tmpdir(), 'siren-bare-'));
    expect(installHooks(bare)).toEqual([]);
    rmSync(bare, { recursive: true, force: true });
  });
});

/**
 * Execution tests for `hooks/canary-deep-siren.sh` (#758).
 *
 * Before these, ZERO of the ~340 lines of shell in this feature were executed
 * by any test — not even `bash -n`. The suite asserted on the script's source
 * text, which passes whether the code works or is commented out, while the PR
 * reported "+21 new tests · test ✓" on top of a behavioural denominator of
 * zero. That is the shape this whole feature was written to refuse.
 *
 * The env hooks these drive (`CANARY_SIREN_LOG`, `CANARY_SIREN_CONFIG`,
 * `CANARY_MARKETPLACE_DIR`, `CANARY_SIREN_FIX`) already existed and were
 * simply unused.
 *
 * Offline: no network, no launchd. `canary` and `npm` are absent from the
 * stubbed PATH so the CLI checks report cannot-verify rather than reaching out.
 */
describe('canary-deep-siren.sh — executed, not read', () => {
  const SIREN = join(REPO_ROOT, 'hooks', 'canary-deep-siren.sh');
  let dir: string;

  const runSiren = (env: Record<string, string> = {}) => {
    const log = join(dir, 'deep.log');
    const r = runCapture('bash', [SIREN], {
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: dir,
        CANARY_SIREN_LOG: log,
        CANARY_SIREN_FIX: join(dir, 'fix.sh'),
        CANARY_SIREN_CONFIG: join(dir, 'siren.json'),
        CANARY_MARKETPLACE_DIR: join(dir, 'marketplace'),
        ...env,
      },
    });
    return { ...r, log: existsSync(log) ? readFileSync(log, 'utf-8') : '' };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'siren-run-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('always writes a dated line, so an absent log means zero runs', () => {
    // The property every other check in this feature rests on.
    const r = runSiren();
    expect(r.status).toBe(0);
    expect(r.log).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] (OK|SIREN)/m,
    );
  });

  it('abstains loudly when no doctorRepos are configured', () => {
    // A check with no targets reporting no findings is a zero-denominator
    // green. The original silently did nothing when its one hardcoded path
    // was absent.
    expect(runSiren().log).toContain(
      'a check with no targets is an abstention',
    );
  });

  it('reports a missing marketplace rather than passing over it', () => {
    expect(runSiren().log).toContain('marketplace checkout missing');
  });

  it('treats an unresolvable origin/HEAD as cannot-verify, not as "? behind"', () => {
    // A remedy that can never clear the finding fires the same alarm every
    // week forever, which is how an alarm stops being read.
    const mkt = join(dir, 'marketplace');
    mkdirSync(mkt, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: mkt });
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'x'], {
      cwd: mkt,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@e',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@e',
      },
    });
    execFileSync('git', ['remote', 'add', 'origin', mkt], { cwd: mkt });
    const log = runSiren().log;
    expect(log).not.toMatch(/is \? commit\(s\) behind/);
  });

  it('generates no fix script when nothing is auto-fixable', () => {
    // REMEDIES is a strict subset of FINDINGS; the click must not imply a fix
    // exists for a finding that needs a human.
    runSiren();
    expect(existsSync(join(dir, 'fix.sh'))).toBe(false);
  });

  it('survives an apostrophe in the operator-settable log path', () => {
    // $LOG and $FIX are settable by env, and a single quote would otherwise
    // close the quoting in the generated script and execute the remainder.
    const odd = join(dir, "bri's dir");
    mkdirSync(odd, { recursive: true });
    const r = runSiren({ CANARY_SIREN_LOG: join(odd, 'deep.log') });
    expect(r.status).toBe(0);
    expect(readFileSync(join(odd, 'deep.log'), 'utf-8')).toContain('SIREN');
  });
});
