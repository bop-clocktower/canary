/**
 * Frame resolution for canary-judomaster (#614), decision D7.
 *
 * A trace is usually captured on another machine (`/app/src/...`,
 * `/home/ci/work/repo/src/...`), so a frame path is tried as given when it
 * already lies inside the root, then by its longest path suffix that exists
 * under the root. Every candidate is realpath-checked against the realpath of
 * the root, so a `..` suffix or a symlink can never resolve outside it.
 *
 * Dependency and runtime frames (`node_modules`, `site-packages`, `node:`
 * internals, `<anonymous>`) are named `external` rather than resolved; a line
 * past the end of the file resolves as `stale` -- source drift after a deploy
 * is common and should be visible, not silently dropped.
 *
 * `mockedSuspectWarnings` (#1138) resolves the module specifiers a generated
 * test mocks (`vi.mock`/`jest.mock`, Python `patch`/`monkeypatch`) against
 * the brief's suspect path, so `verify` can warn when a test mocks the very
 * code it should exercise.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

import type { FrameStatus, RawFrame, ResolvedFrame } from './types.js';

const EXTERNAL = [
  /(^|[\\/])node_modules[\\/]/,
  /[\\/](site|dist)-packages[\\/]/,
  /[\\/]lib[\\/]python\d[\d.]*[\\/]/,
];

function isExternal(file: string): boolean {
  if (file.startsWith('node:') || file.startsWith('<')) return true;
  return EXTERNAL.some((re) => re.test(file));
}

/**
 * True when `candidate` lies strictly inside `base`. Built on relative()
 * rather than a string prefix: `base + sep` is `//` for root `/` and
 * `/repo` is a prefix of `/repo-other`.
 */
export function isWithin(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function inside(rootReal: string, candidate: string): string | null {
  try {
    const real = realpathSync(candidate);
    if (!isWithin(rootReal, real)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function candidates(file: string, root: string): string[] {
  const out = isAbsolute(file) ? [file] : [resolve(root, file)];
  const parts = file.split(/[\\/]/).filter((p) => p !== '');
  // Suffixes keep at least two segments: a bare basename would resolve
  // another service's `index.ts` to whatever `index.ts` sits at the root.
  for (let i = 1; i < parts.length - 1; i++) {
    out.push(resolve(root, parts.slice(i).join('/')));
  }
  return out;
}

function findInRoot(file: string, rootReal: string): string | null {
  for (const candidate of candidates(file, rootReal)) {
    const hit = inside(rootReal, candidate);
    if (hit !== null) return hit;
  }
  return null;
}

/** The +/-2 line window around 1-based `line`. */
function excerpt(lines: string[], line: number): string[] {
  return lines.slice(Math.max(0, line - 3), Math.min(lines.length, line + 2));
}

function resolveOne(frame: RawFrame, rootReal: string): ResolvedFrame {
  if (isExternal(frame.file)) return { ...frame, status: 'external' };
  const hit = findInRoot(frame.file, rootReal);
  if (hit === null) return { ...frame, status: 'missing' };
  const text = readFileSync(hit, 'utf-8').replace(/\r?\n$/, '');
  const lines = text.split(/\r?\n/);
  const path = relative(rootReal, hit).split(sep).join('/');
  const status: FrameStatus = frame.line > lines.length ? 'stale' : 'resolved';
  if (status === 'stale') return { ...frame, status, path };
  return { ...frame, status, path, excerpt: excerpt(lines, frame.line) };
}

/** Resolve each frame against `root`, preserving order (innermost first). */
export function resolveFrames(
  frames: RawFrame[],
  root: string,
): ResolvedFrame[] {
  const rootReal = realpathSync(root);
  return frames.map((frame) => resolveOne(frame, rootReal));
}

const JS_EXT = /\.[cm]?[jt]sx?$/;
const JS_MOCK = /\b(?:vi|jest)\.(?:do)?[mM]ock\(\s*(['"`])([^'"`]+)\1/g;
const PY_PATCH =
  /\b(?:mock\.patch|mocker\.patch|patch|monkeypatch\.(?:setattr|delattr))\(\s*(['"])([\w.]+)\1/g;
const PY_OBJECT =
  /\b(?:patch\.object|monkeypatch\.setattr)\(\s*([A-Za-z_]\w*)\s*,/g;

/** A JS mock specifier as a root-relative path stem, or a bare suffix. */
function jsMocksSuspect(spec: string, dir: string, stem: string): boolean {
  if (spec.startsWith('.')) {
    return posix.normalize(posix.join(dir, spec)).replace(JS_EXT, '') === stem;
  }
  const bare = spec.replace(/^[@~]\//, '').replace(JS_EXT, '');
  return bare === stem || stem.endsWith(`/${bare}`);
}

function jsMocks(source: string, dir: string, suspect: string): string[] {
  const stem = suspect.replace(JS_EXT, '');
  return [...source.matchAll(JS_MOCK)]
    .filter((m) => jsMocksSuspect(m[2]!, dir, stem))
    .map((m) => `${m[0]})`);
}

/** The suspect's dotted module path and each dotted suffix of 2+ parts. */
function pyModules(suspect: string): string[] {
  const parts = suspect.replace(/\.py$/, '').split('/');
  return parts
    .map((_, i) => parts.slice(i).join('.'))
    .filter((mod, i) => i === 0 || mod.includes('.'));
}

function pyMocks(source: string, suspect: string): string[] {
  const mods = pyModules(suspect);
  const stem = posix.basename(suspect, '.py');
  const strings = [...source.matchAll(PY_PATCH)]
    .filter((m) =>
      mods.some((mod) => m[2] === mod || m[2]!.startsWith(`${mod}.`)),
    )
    .map((m) => `${m[0]})`);
  const objects = [...source.matchAll(PY_OBJECT)]
    .filter((m) => m[1] === stem)
    .map((m) => `${m[0]} ...)`);
  return [...strings, ...objects];
}

/**
 * C6/C7 (#1138): one warning per call in `testSource` that mocks the
 * suspect module. `testRelDir` and `suspectPath` are root-relative posix
 * paths. A warning only: a test that mocks the code it should exercise can
 * still go red for an unrelated reason, so `verify` says so.
 */
export function mockedSuspectWarnings(
  testSource: string,
  testRelDir: string,
  suspectPath: string,
): string[] {
  const calls = suspectPath.endsWith('.py')
    ? pyMocks(testSource, suspectPath)
    : jsMocks(testSource, testRelDir, suspectPath);
  return calls.map(
    (call) =>
      `the test mocks the suspect module ${suspectPath} (${call}); a regression test that mocks the code it should exercise cannot reproduce the defect`,
  );
}
