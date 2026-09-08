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

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  linkHooks: (
    home?: string,
    now?: Date,
  ) => { name: string; action: string; backup?: string; target?: string }[];
  SIREN_HOOKS: readonly string[];
  interactivePath: (run?: unknown) => string;
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
  divergentCopies,
  linkHooks,
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

  it('falls back to the process PATH when the shell yields nothing', () => {
    expect(interactivePath(fakeRun('  ') as never)).toBe(process.env['PATH']);
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

describe('divergent machine copies', () => {
  // Committing the sirens creates a second copy of each on any machine that
  // already had them in ~/.claude/hooks. Two copies of a rot detector is the
  // rot it detects: launchd runs the repo copy while a SessionStart hook wired
  // to the old path keeps running a siren with no deep-siren self-check in it.
  const fakeRead =
    (machine: string, repo: string) =>
    (p: string): string =>
      p.includes('/.claude/') ? machine : repo;

  it('flags a machine copy that differs from the repo copy', () => {
    const out = divergentCopies(homedir(), fakeRead('old', 'new')) as string[];
    // Only counts files that actually exist on this machine, so assert the
    // shape rather than a fixed length.
    for (const p of out) expect(p).toContain('.claude/hooks');
  });

  it('stays quiet when the copies match', () => {
    expect(divergentCopies(homedir(), fakeRead('same', 'same'))).toEqual([]);
  });

  it('treats an unreadable machine copy as divergent, not as identical', () => {
    // "Cannot verify" is a finding, not a skip.
    const exploding = (p: string): string => {
      if (p.includes('/.claude/')) throw new Error('EACCES');
      return 'repo';
    };
    const out = divergentCopies(homedir(), exploding) as string[];
    for (const p of out) expect(p).toContain('.claude/hooks');
  });

  it('reports rather than rewrites — ~/.claude belongs to the operator', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'scripts', 'install-siren.mjs'),
      'utf-8',
    );
    const fn = src.slice(
      src.indexOf('export function divergentCopies'),
      src.indexOf('function fail('),
    );
    expect(fn).not.toContain('writeFileSync');
    expect(fn).not.toContain('rmSync');
  });
});

describe('linkHooks — one version of each siren on the machine', () => {
  // #758 follow-up. Copies drift in BOTH directions: mid-change the ~/.claude
  // copy was briefly AHEAD of the repo, having gained a plugin-skew check, so
  // "overwrite from the repo" would have silently lost work. A symlink removes
  // the category — settings.json keeps its ~/.claude path, and that path now
  // resolves to the tracked file CI and code review actually see.
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'siren-home-'));
    mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('replaces a divergent regular file with a link to the repo copy', () => {
    const target = join(home, '.claude', 'hooks', SIREN_HOOKS[0] as string);
    writeFileSync(target, 'stale contents\n', 'utf-8');

    linkHooks(home);

    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(realpathSync(target)).toBe(
      join(REPO_ROOT, 'hooks', SIREN_HOOKS[0] as string),
    );
  });

  it('preserves the displaced file rather than deleting it', () => {
    // The machine copy was ahead once already. Never destroy the operator's
    // file to win a reconcile.
    const name = SIREN_HOOKS[0] as string;
    const target = join(home, '.claude', 'hooks', name);
    writeFileSync(target, 'irreplaceable\n', 'utf-8');

    const acted = linkHooks(home).find((a) => a.action === 'backed-up');
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
    linkHooks(home);
    const second = linkHooks(home);
    expect(second.every((a) => a.action === 'already-linked')).toBe(true);
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
    linkHooks(home);
    expect(divergentCopies(home)).toEqual([]);
  });

  it('does nothing when there is no hooks directory to reconcile', () => {
    const bare = mkdtempSync(join(tmpdir(), 'siren-bare-'));
    expect(linkHooks(bare)).toEqual([]);
    rmSync(bare, { recursive: true, force: true });
  });
});

describe('the deep siren script', () => {
  const script = readFileSync(
    join(REPO_ROOT, 'hooks', 'canary-deep-siren.sh'),
    'utf-8',
  );

  it('logs unconditionally on the healthy path', () => {
    // This is what makes an absent log conclusive. If the healthy path were
    // silent, "no log" would be ambiguous and check 5 could not exist.
    expect(script).toContain('note "OK —');
  });

  it('abstains loudly when no doctor target is configured', () => {
    // The original silently did nothing when its one hardcoded path was
    // absent — a check with no targets reporting no findings.
    expect(script).toContain('a check with no targets is an abstention');
  });

  it('makes the click DO the fix rather than describe it', () => {
    // A banner that only opens a log leaves the work where it was. Each
    // finding with a known remedy contributes its command to a generated
    // script, and the click runs that.
    expect(script).toContain('terminal-notifier');
    expect(script).toContain('-execute');
    expect(script).toContain('REMEDIES');
    expect(script).toContain('open -a Terminal');
  });

  it('runs the fix visibly, not silently', () => {
    // These commands reinstall plugins and upgrade a global npm package, and
    // a notification click is a low-confirmation gesture. Terminal, not
    // background.
    const block = script.slice(script.indexOf('EXEC=""'));
    expect(block).toContain('open -a Terminal');
    expect(block).not.toMatch(/-execute\s+"[^"]*&\s*$/m);
  });

  it('verifies the END STATE by re-running the siren, not the exit codes', () => {
    // The 2026-08-02 skew is exactly a fix reporting success while leaving
    // the end state broken, so the generated script re-runs the siren.
    expect(script).toContain('re-running the siren to verify the end state');
    expect(script).toContain('$SELF');
  });

  it('resolves its own path absolutely for that re-run', () => {
    // The fix script is opened from Terminal's cwd (the home directory), so a
    // relative $BASH_SOURCE would not resolve. This bit the first draft.
    expect(script).toContain('SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")"');
  });

  it('never implies it fixed findings that need a human', () => {
    // REMEDIES is a strict subset of FINDINGS — a missing config or a failing
    // `canary doctor` has no command that resolves it.
    expect(script).toContain(
      'Fixes ${#REMEDIES[@]} of ${#FINDINGS[@]} finding(s); the rest need a human.',
    );
    expect(script).toContain('no auto-fixable finding — click opens the log');
  });

  it('falls back on terminal-notifier FAILING, not merely on it being absent', () => {
    // terminal-notifier needs a manual macOS permission grant. Without it the
    // command fails and NO banner appears — strictly worse than an unclickable
    // one. So the fallback has to be driven by the outcome.
    expect(script).toContain('TN_ERR');
    expect(script).toContain('notified=0');
  });

  it('records the degradation instead of quietly losing the click action', () => {
    expect(script).toContain('UNCLICKABLE');
    expect(script).toContain('System Settings');
  });

  it('checks the installed plugin against the marketplace checkout', () => {
    // The 2026-08-02 skew: `marketplace update` returns a tick while leaving
    // the install pinned, because the install is keyed on a declared version
    // that upstream ships new content under. Checking only the checkout goes
    // green on a half-applied update.
    expect(script).toContain('gitCommitSha');
    expect(script).toContain('installed_plugins.json');
  });

  it('names no consumer or company in a public repo', () => {
    // The pre-commit version hardcoded a consumer checkout path, which names
    // the consumer. Configuration is per-machine; the tree stays neutral.
    expect(script).toContain('CANARY_SIREN_CONFIG');
    expect(script).not.toMatch(/projects\/[a-z]+\/[a-z]+"/);
  });
});
