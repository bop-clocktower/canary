#!/usr/bin/env node
// Provisions and verifies the weekly deep-siren LaunchAgent (#758).
//
// The defect: the siren declared its launchd label in a header comment and
// nothing ever created the agent, so every network check was dark from the day
// it was written — #508's zero-denominator green with zero *invocations*.
//
// Three refusals, all load-bearing:
//   1. No install when `canary` is unreachable under the PATH this bakes in.
//      launchd gives a minimal environment and `mise activate` lives in an
//      interactive-only rc file, so an inherited PATH yields a weekly false
//      "CLI missing" — noise from the tool meant to catch false greens.
//   2. `--verify` asserts the agent RAN, not that launchd accepted the file.
//   3. Reconcile by backup, never by overwrite: the machine copy has already
//      been AHEAD of the tree once during this change. Hooks install as COPIES
//      (a symlink into a branch-switching tree made `git checkout` a silent
//      hook outage), so drift is possible by construction and `--verify` fails
//      on it rather than letting it pass unremarked.
//
//   node scripts/install-siren.mjs --install
//   node scripts/install-siren.mjs --verify   [--json]
//   node scripts/install-siren.mjs --uninstall
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LABEL = 'io.github.bop-clocktower.canary-deep-siren';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(REPO_ROOT, 'hooks', `${LABEL}.plist`);
const SCRIPT = join(REPO_ROOT, 'hooks', 'canary-deep-siren.sh');

/** Weekly cadence plus a grace day — a wider gap means runs are being missed. */
export const STALE_DAYS = 8;

export function plistPath(home = homedir()) {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export function logPath(home = homedir()) {
  return join(home, '.claude', 'logs', 'canary-deep-siren.log');
}

/**
 * The PATH an interactive login shell gives. `-l` sources ~/.zprofile and `-i`
 * ~/.zshrc, where `mise activate` lives; login-only misses mise, which is the
 * false "CLI missing" this guards against.
 */
export function interactivePath(run = spawnSync) {
  const r = run('/bin/zsh', ['-lic', 'printf %s "$PATH"'], {
    encoding: 'utf-8',
    timeout: 20_000,
  });
  const out = (r.stdout ?? '').trim();
  return out.length > 0 ? out : (process.env['PATH'] ?? '');
}

/** Absolute path to `canary` under `path`, or undefined when unreachable. */
export function resolveCanary(path, run = spawnSync) {
  const r = run('/usr/bin/env', ['sh', '-c', 'command -v canary'], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: path },
    timeout: 20_000,
  });
  const out = (r.stdout ?? '').trim();
  return out.length > 0 ? out : undefined;
}

/** Fill the template's placeholders. Kept pure so the substitution is testable. */
export function renderPlist(template, { script, path, home }) {
  return template
    .replaceAll('__SCRIPT__', script)
    .replaceAll('__PATH__', path)
    .replaceAll('__HOME__', home);
}

/** True when launchd knows the label. Registration only — never execution. */
export function isRegistered(run = spawnSync) {
  const r = run('/bin/launchctl', ['list'], {
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return (r.stdout ?? '').includes(LABEL);
}

/** Age of the deep siren's log in whole days, or undefined when it has none. */
export function logAgeDays(home = homedir(), now = Date.now()) {
  const p = logPath(home);
  if (!existsSync(p)) return undefined;
  return (now - statSync(p).mtimeMs) / 86_400_000;
}

/**
 * Scheduler health as a report, not a boolean. `never-ran` is deliberately
 * distinct from `stale`: the siren's healthy path logs unconditionally, so an
 * absent log means zero executions — there is no "ran and was clean" reading.
 */
export function schedulerStatus({
  registered,
  ageDays,
  staleDays = STALE_DAYS,
}) {
  if (!registered) {
    return {
      ok: false,
      state: 'unregistered',
      detail: `launchd does not know ${LABEL} — every network-level canary check is dark`,
    };
  }
  if (ageDays === undefined) {
    return {
      ok: false,
      state: 'never-ran',
      detail:
        'registered, but the deep siren has never logged a run — an absent log means zero executions, not zero findings',
    };
  }
  if (ageDays > staleDays) {
    return {
      ok: false,
      state: 'stale',
      detail: `registered, but the last logged run was ${ageDays.toFixed(1)}d ago (>${staleDays}d) — it is not firing`,
    };
  }
  return {
    ok: true,
    state: 'healthy',
    detail: `registered and last ran ${ageDays.toFixed(1)}d ago`,
  };
}

/** The sirens that live in this repo and are also wired from `~/.claude`. */
export const SIREN_HOOKS = Object.freeze([
  'canary-deep-siren.sh',
  'canary-session-siren.sh',
]);

/**
 * Machine copies of the sirens that differ from the tracked ones. Two copies
 * of a rot detector is the rot it detects (fast-siren check 2): a SessionStart
 * hook wired to `~/.claude/hooks/` can run a siren missing check 5 while the
 * tree has it. Reported here; `installHooks` is what resolves it.
 */
export function divergentCopies(home = homedir(), read = readFileSync) {
  const out = [];
  for (const name of SIREN_HOOKS) {
    const machine = join(home, '.claude', 'hooks', name);
    if (!existsSync(machine)) continue;
    try {
      if (
        read(machine, 'utf-8') !== read(join(REPO_ROOT, 'hooks', name), 'utf-8')
      ) {
        out.push(machine);
      }
    } catch {
      // Unreadable is not "identical" — surface it as divergent.
      out.push(machine);
    }
  }
  return out;
}

/**
 * Install `~/.claude/hooks/canary-*.sh` as regular files copied from the
 * tracked ones, so exactly one *version* of each siren is in force.
 *
 * A COPY, not a symlink. The symlink this replaced pointed a machine-global
 * hook into a working tree that changes branches, so `git checkout` silently
 * uninstalled it: on 2026-09-08 this checkout sat on a branch where the #758
 * commits are not ancestors of HEAD, both links dangled, and
 * `canary-session-siren.sh` — a configured SessionStart hook — failed on every
 * session start until someone looked. A hook whose liveness depends on which
 * branch an unrelated repo happens to be on is not installed, it is borrowed.
 *
 * The objection this reverses is real and is preserved, not discarded: copies
 * drift in BOTH directions, and the machine copy HAS been ahead of the tree.
 * Two things keep that from losing work:
 *   1. Any displaced regular file is still kept as a timestamped `.bak-`
 *      sibling, never deleted — a machine copy that was ahead survives.
 *   2. Drift is not silent. {@link divergentCopies} compares content, `--verify`
 *      reports every divergent path and FAILS on it, so a machine copy that is
 *      ahead of (or behind) the tree is a finding rather than a quiet mismatch.
 * Trading an always-current link for a copy is only honest while (2) holds; if
 * that check is ever weakened, this decision has to be revisited with it.
 */
export function installHooks(home = homedir(), now = new Date()) {
  const actions = [];
  const dir = join(home, '.claude', 'hooks');
  if (!existsSync(dir)) return actions;

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  for (const name of SIREN_HOOKS) {
    const machine = join(dir, name);
    const repo = join(REPO_ROOT, 'hooks', name);
    if (!existsSync(repo)) continue;

    // Already correct: a regular file whose CONTENT matches the tracked one.
    // Content equality, not mtime or inode: those answer "is it the same
    // file", and the question here is "is it the same version".
    if (isCopyOf(machine, repo)) {
      actions.push({ name, action: 'already-installed' });
      continue;
    }
    if (existsSync(machine) || isBrokenLink(machine)) {
      // `existsSync` follows links, so a DANGLING symlink — the exact wreckage
      // this change exists to clear — reports false and would otherwise be left
      // in place for `copyFileSync` to fail on.
      const backup = `${machine}.bak-${stamp}`;
      renameSync(machine, backup);
      actions.push({ name, action: 'backed-up', backup });
    }
    copyFileSync(repo, machine);
    chmodSync(machine, 0o755);
    actions.push({ name, action: 'installed', source: repo });
  }
  return actions;
}

/** True when `p` is a regular file whose content matches `target`'s. */
function isCopyOf(p, target) {
  try {
    if (lstatSync(p).isSymbolicLink()) return false;
    return readFileSync(p, 'utf-8') === readFileSync(target, 'utf-8');
  } catch {
    return false;
  }
}

/** True when `p` is a symlink whose target does not resolve. */
function isBrokenLink(p) {
  try {
    return lstatSync(p).isSymbolicLink() && !existsSync(realpathSync(p));
  } catch {
    // lstat succeeded as a link but realpath threw: unresolvable, so broken.
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

/**
 * Register terminal-notifier's app bundle with LaunchServices.
 *
 * Without this the click action cannot work AND cannot be enabled: macOS has
 * no record of the app, so it refuses the permission request and the app never
 * appears in System Settings for a human to allow. The banner degrades to the
 * unclickable path forever, and the setting the log names does not exist to be
 * changed. Best-effort — a missing terminal-notifier is supported.
 */
export function registerNotifier(run = spawnSync) {
  const which = run(
    '/usr/bin/env',
    ['sh', '-c', 'command -v terminal-notifier'],
    {
      encoding: 'utf-8',
    },
  );
  const bin = (which.stdout ?? '').trim();
  if (!bin) return undefined;

  // The Homebrew CLI is a shim that execs the bundled binary; the bundle is
  // two levels up from it. Resolve via the shim rather than a version-pinned
  // Cellar path, which would rot on the next upgrade.
  const app = run(
    '/usr/bin/env',
    [
      'sh',
      '-c',
      `sed -n 's|.*exec "\\(.*\\)/Contents/MacOS/.*|\\1|p' "$(readlink -f ${bin} 2>/dev/null || echo ${bin})"`,
    ],
    { encoding: 'utf-8' },
  );
  const bundle = (app.stdout ?? '').trim();
  if (!bundle || !existsSync(bundle)) return undefined;

  run(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', bundle],
    { stdio: 'ignore' },
  );
  return bundle;
}

function fail(message) {
  console.error(`install-siren: ${message}`);
  process.exit(1);
}

/** Preconditions for writing a plist; exits rather than answering partially. */
function preflight() {
  if (process.platform !== 'darwin') {
    fail(
      `launchd is macOS-only and this is ${process.platform}. The deep siren itself is portable — schedule hooks/canary-deep-siren.sh with cron or a systemd timer instead.`,
    );
  }
  if (!existsSync(TEMPLATE)) fail(`missing plist template at ${TEMPLATE}`);
  if (!existsSync(SCRIPT)) fail(`missing deep siren at ${SCRIPT}`);

  const path = interactivePath();
  const canary = resolveCanary(path);
  if (canary === undefined) {
    fail(
      `\`canary\` is not reachable under the PATH this agent would use, so the\n` +
        `  scheduled run would report "canary CLI missing" every week — a false\n` +
        `  finding from the monitor that exists to catch false greens.\n\n` +
        `  Refusing to install. Install the CLI first:\n` +
        `      npm install -g canary-test-cli\n\n` +
        `  PATH tried: ${path}`,
    );
  }
  return { path, canary };
}

/** Replace any loaded copy of the agent with the one at `target`. */
function loadAgent(target) {
  // `bootout` first so a re-install replaces rather than stacks. It fails when
  // nothing is loaded, which is the ordinary first-install case.
  const domain = `gui/${process.getuid?.() ?? ''}`;
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${LABEL}`], {
    stdio: 'ignore',
  });
  const boot = spawnSync('/bin/launchctl', ['bootstrap', domain, target], {
    encoding: 'utf-8',
  });
  if (boot.status !== 0) {
    fail(
      `launchctl bootstrap exited ${boot.status}: ${(boot.stderr ?? '').trim()}`,
    );
  }
}

/** Make the machine run the tracked sirens, and the banner clickable. */
function reconcileMachine(home) {
  for (const a of installHooks(home)) {
    if (a.action === 'backed-up') console.log(`  backed up -> ${a.backup}`);
    else if (a.action === 'installed')
      console.log(`  installed ${a.name} from hooks/`);
  }
  const stragglers = divergentCopies(home);
  if (stragglers.length > 0) {
    console.log(`  WARNING: still divergent: ${stragglers.join(', ')}`);
  }

  const bundle = registerNotifier();
  if (bundle === undefined) {
    console.log(`  note: terminal-notifier absent — the banner cannot carry a`);
    console.log(`    click action. brew install terminal-notifier`);
    return;
  }
  console.log(`  registered ${bundle} with LaunchServices`);
  console.log(
    `    if the banner is still unclickable, allow it in System Settings ▸ Notifications`,
  );
}

function install(home) {
  const { path, canary } = preflight();

  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(join(home, '.claude', 'logs'), { recursive: true });

  const target = plistPath(home);
  writeFileSync(
    target,
    renderPlist(readFileSync(TEMPLATE, 'utf-8'), {
      script: SCRIPT,
      path,
      home,
    }),
    'utf-8',
  );
  loadAgent(target);

  console.log(`installed ${target}`);
  console.log(`  canary resolved to ${canary}`);
  reconcileMachine(home);
  console.log(
    `  RunAtLoad fired the first run; confirm it with --verify (the log may take a moment).`,
  );
}

function uninstall(home) {
  const domain = `gui/${process.getuid?.() ?? ''}`;
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${LABEL}`], {
    stdio: 'ignore',
  });
  const target = plistPath(home);
  if (existsSync(target)) rmSync(target);
  console.log(`removed ${target}`);
}

function verify(home, asJson) {
  const status = schedulerStatus({
    registered: isRegistered(),
    ageDays: logAgeDays(home),
  });
  const diverged = divergentCopies(home);
  const report = { ...status, divergentCopies: diverged };
  if (asJson) console.log(JSON.stringify(report));
  else {
    console.log(`deep siren — ${status.state}: ${status.detail}`);
    for (const p of diverged) console.log(`  DIVERGED: ${p}`);
  }
  // A divergent machine copy fails the verify. The scheduler can be perfectly
  // healthy while a SessionStart hook still runs a stale siren, and that gap
  // is invisible from either side on its own.
  process.exit(status.ok && diverged.length === 0 ? 0 : 1);
}

function main(argv) {
  const home = homedir();
  if (argv.includes('--install')) return install(home);
  if (argv.includes('--uninstall')) return uninstall(home);
  if (argv.includes('--verify')) return verify(home, argv.includes('--json'));
  console.error(
    'usage: install-siren.mjs --install | --verify [--json] | --uninstall',
  );
  process.exit(2);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2));
}
