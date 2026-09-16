/**
 * Throwaway spike harness for #765 D2 -- question 5. NOT engine code.
 *
 * Question: if `typescript` becomes an OPTIONAL peer dependency of canary, does
 * a consumer install actually leave it out, does the CLI still work without it,
 * and can the code detect absence cleanly?
 *
 * Measured by experiment, in throwaway npm projects under a temp dir:
 *
 *   A. optional peer dep is NOT auto-installed (npm 7+ auto-installs
 *      non-optional peers, which would silently make it a hard dep).
 *   B. a guarded dynamic import() reports absence as a catchable error with a
 *      stable code, so the abstain path is detectable rather than a crash.
 *   C. the same guarded import succeeds when the consumer does have typescript,
 *      including a version the host never installed.
 *
 *   node peer-dep-probe.mjs [--keep]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const keep = process.argv.includes('--keep');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spike765-peer-'));
const out = { npmVersion: '', node: process.version, experiments: [] };

const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

out.npmVersion = sh('npm', ['--version'], root).trim();

/** The guarded-import shape a real implementation would use. */
const GUARD = `
// The abstain path: a guarded dynamic import, no top-level dependency.
let ts = null;
let failure = null;
try {
  ts = (await import('typescript')).default;
} catch (e) {
  failure = { name: e.name, code: e.code, message: String(e.message).split('\\n')[0] };
}
process.stdout.write(JSON.stringify({
  resolved: Boolean(ts),
  tsVersion: ts ? ts.version : null,
  failure,
}) + '\\n');
`;

/** A package that declares typescript as an OPTIONAL peer dependency. */
function makeLib(dir, optional) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'spike765-lib',
        version: '1.0.0',
        type: 'module',
        main: 'index.mjs',
        peerDependencies: { typescript: '>=5.0.0' },
        ...(optional
          ? { peerDependenciesMeta: { typescript: { optional: true } } }
          : {}),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(dir, 'index.mjs'), GUARD);
  return sh('npm', ['pack', '--json', '--pack-destination', dir], dir);
}

function consumer(name, tarball, extraDeps) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', private: true }, null, 2),
  );
  const args = ['install', tarball, ...extraDeps, '--no-audit', '--no-fund'];
  let installLog = '';
  try {
    installLog = sh('npm', args, dir);
  } catch (e) {
    installLog = `INSTALL FAILED: ${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const tsInstalled = fs.existsSync(
    path.join(dir, 'node_modules', 'typescript', 'package.json'),
  );
  let guard = null;
  try {
    guard = JSON.parse(
      sh(
        process.execPath,
        ['-e', "import('spike765-lib').then(()=>{})"],
        dir,
      ) || '{}',
    );
  } catch (e) {
    guard = { error: String(e.stderr ?? e.message).split('\n')[0] };
  }
  return {
    consumer: name,
    tsInstalled,
    guard,
    installTail: installLog.trim().split('\n').slice(-3),
  };
}

// --- A/B: optional peer, consumer installs nothing extra ------------------
const optLib = path.join(root, 'lib-optional');
const packedOpt = JSON.parse(makeLib(optLib, true))[0].filename;
out.experiments.push({
  name: 'A+B optional peer, consumer without typescript',
  ...consumer('consumer-bare', path.join(optLib, packedOpt), []),
});

// --- C: optional peer, consumer brings its own typescript -----------------
out.experiments.push({
  name: 'C optional peer, consumer with typescript@5.4.5',
  ...consumer('consumer-ts', path.join(optLib, packedOpt), [
    'typescript@5.4.5',
  ]),
});

// --- Control: NON-optional peer, to show npm auto-installs it -------------
const hardLib = path.join(root, 'lib-required');
const packedHard = JSON.parse(makeLib(hardLib, false))[0].filename;
out.experiments.push({
  name: 'Control: non-optional peer, consumer installs nothing extra',
  ...consumer('consumer-hardpeer', path.join(hardLib, packedHard), []),
});

out.tempRoot = keep ? root : '(removed)';
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
if (!keep) fs.rmSync(root, { recursive: true, force: true });
