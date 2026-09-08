#!/usr/bin/env node
// Provisions and verifies the weekly deep-siren LaunchAgent (#758).
//
// The defect this closes: `hooks/canary-deep-siren.sh` documented its own
// launchd label in a header comment, and nothing ever created the agent. Every
// network-level canary check was dark from the day the script was written —
// marketplace-vs-upstream, CLI-vs-npm-latest, and the `canary doctor` skip
// probe from #505. A never-scheduled monitor produces the same user-visible
// signal as a healthy one (no complaint) with even less behind it. That is
// #508's zero-denominator green with a denominator of zero *invocations*.
//
// So the scheduler is provisioned by a tool rather than by a comment, and the
// install is not reported as successful until the agent has actually run.
//
// Two properties this script refuses to compromise on:
//
//   1. It REFUSES to install when `canary` is unreachable under the PATH it
//      would bake in. launchd hands a job a minimal environment, and `mise
//      activate` lives in ~/.zshrc (interactive-only), so an agent inheriting
//      launchd's PATH finds no `canary` and reports "CLI missing" — a false
//      finding from the monitor that exists to catch false greens. Installing
//      anyway would be worse than not installing: it manufactures noise and
//      teaches the reader to ignore the siren.
//
//   2. `--verify` asserts the agent RAN, not that launchd accepted the file.
//      Registration is not execution, which is the whole lesson of #758.
//
//   node scripts/install-siren.mjs --install
//   node scripts/install-siren.mjs --verify   [--json]
//   node scripts/install-siren.mjs --uninstall
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
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
 * The PATH an interactive login shell would give us.
 *
 * `-l` sources ~/.zprofile and `-i` sources ~/.zshrc, which is where `mise
 * activate` lives. Both are needed: a login-only shell misses mise entirely,
 * which is exactly the false "CLI missing" this guards against.
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
 * The health of the scheduler, as a report rather than a boolean.
 *
 * `never-ran` is deliberately distinct from `stale`: an absent log means zero
 * executions, and the deep siren's healthy path writes a line unconditionally,
 * so there is no "it ran and was clean" reading of an absent log.
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

/**
 * Legacy per-machine copies of the sirens that now also live in this repo.
 *
 * Two copies of a rot detector is the rot it detects — check 2 of the fast
 * siren exists to catch exactly this shape ("flat-file overlay shadows the
 * plugin and drifts silently"). The LaunchAgent points at the repo copy, but
 * a SessionStart hook wired to `~/.claude/hooks/` keeps running the old one,
 * so the deep-siren self-check can be absent from the running siren while
 * present in the tree.
 *
 * Reported, never rewritten: `~/.claude` is the operator's, not this script's.
 */
export function divergentCopies(home = homedir(), read = readFileSync) {
  const out = [];
  for (const name of ['canary-deep-siren.sh', 'canary-session-siren.sh']) {
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

function fail(message) {
  console.error(`install-siren: ${message}`);
  process.exit(1);
}

function install(home) {
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

  console.log(`installed ${target}`);
  console.log(`  canary resolved to ${canary}`);
  for (const p of divergentCopies(home)) {
    console.log(
      `  WARNING: ${p} differs from the repo copy. launchd now runs the repo\n` +
        `    copy, but anything wired to that path (a SessionStart hook) still runs\n` +
        `    the stale one. Point it at hooks/ or replace the file.`,
    );
  }
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
