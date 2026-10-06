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
/** A factory or option that keeps the real implementation. */
const JS_PARTIAL = /importOriginal|importActual|requireActual|spy:\s*true/;
const PY_PATCH =
  /\b(?:mock\.patch|mocker\.patch|patch|monkeypatch\.(?:setattr|delattr))\(\s*(['"])([\w.]+)\1/g;
const PY_OBJECT =
  /\b(patch\.object|monkeypatch\.setattr)\(\s*([A-Za-z_]\w*)\s*,\s*(?:(['"])(\w+)\3)?/g;

/** One mock call: `soft` when it may stub a dependency, not the suspect. */
interface MockHit {
  call: string;
  target: string;
  soft: boolean;
}

/** Blank out whole-line comments so a commented-out mock is not a hit. */
const uncomment = (source: string, marker: RegExp) =>
  source
    .split('\n')
    .map((line) => (marker.test(line) ? '' : line))
    .join('\n');

/**
 * A JS mock specifier as a root-relative path stem, or a bare suffix. A
 * bare specifier needs a `/` (or an `@/` / `~/` alias): `vi.mock('fs')` is
 * the package, not `src/utils/fs.ts`.
 */
function jsMocksSuspect(spec: string, dir: string, stem: string): boolean {
  if (spec.startsWith('.')) {
    return posix.normalize(posix.join(dir, spec)).replace(JS_EXT, '') === stem;
  }
  const aliased = /^[@~]\//.test(spec);
  const bare = spec.replace(/^[@~]\//, '').replace(JS_EXT, '');
  if (!aliased && !bare.includes('/')) return false;
  return bare === stem || stem.endsWith(`/${bare}`);
}

function jsMocks(source: string, dir: string, suspect: string): MockHit[] {
  const stem = suspect.replace(JS_EXT, '');
  const text = uncomment(source, /^\s*\/\//);
  return [...text.matchAll(JS_MOCK)]
    .filter((m) => jsMocksSuspect(m[2]!, dir, stem))
    .map((m) => {
      const rest = text.slice(m.index! + m[0].length);
      const next = rest.search(/\b(?:vi|jest)\.(?:do)?[mM]ock\(/);
      const body = next === -1 ? rest.slice(0, 400) : rest.slice(0, next);
      return { call: `${m[0]})`, target: m[2]!, soft: JS_PARTIAL.test(body) };
    });
}

/** The suspect's dotted module path and each dotted suffix of 2+ parts. */
function pyModules(suspect: string): string[] {
  const parts = suspect.replace(/\.py$/, '').split('/');
  return parts
    .map((_, i) => parts.slice(i).join('.'))
    .filter((mod, i) => i === 0 || mod.includes('.'));
}

/**
 * Python patches a name where it is looked up, so `cart.total.requests.get`
 * stubs a dependency of the suspect module. Only the module itself or its
 * suspect function is a hard hit; any other name inside it is soft.
 */
function pyMocks(source: string, suspect: string, fn?: string): MockHit[] {
  const mods = pyModules(suspect);
  const stem = posix.basename(suspect, '.py');
  const text = uncomment(source, /^\s*#/);
  const strings = [...text.matchAll(PY_PATCH)].flatMap((m) => {
    const target = m[2]!;
    const mod = mods.find((d) => target === d || target.startsWith(`${d}.`));
    if (mod === undefined) return [];
    const hard =
      target === mod || (fn !== undefined && target === `${mod}.${fn}`);
    return [{ call: `${m[0]})`, target, soft: !hard }];
  });
  const objects = [...text.matchAll(PY_OBJECT)]
    .filter((m) => m[2] === stem)
    .map((m) => ({
      call: `${m[1]}(${m[2]}, ...)`,
      target: m[4] === undefined ? stem : `${stem}.${m[4]}`,
      soft: m[4] === undefined || m[4] !== fn,
    }));
  return [...strings, ...objects];
}

function warningFor(hit: MockHit, suspectPath: string): string {
  if (hit.soft) {
    return `the test patches ${hit.target} inside the suspect module ${suspectPath} (${hit.call}); check it is a dependency, not the code under test`;
  }
  return `the test mocks the suspect module ${suspectPath} (${hit.call}); a regression test that mocks the code it should exercise cannot reproduce the defect`;
}

/**
 * C6/C7 (#1138): one warning per call in `testSource` that mocks the
 * suspect module. `testRelDir` and `suspectPath` are root-relative posix
 * paths; `suspectFn` is the brief's suspect function, when known. A
 * warning only: a test that mocks the code it should exercise can still go
 * red for an unrelated reason, so `verify` says so. A partial mock (one
 * that keeps the real implementation) or a patch of another name inside
 * the module gets a softer "check it is a dependency" warning.
 */
export function mockedSuspectWarnings(
  testSource: string,
  testRelDir: string,
  suspectPath: string,
  suspectFn?: string,
): string[] {
  const hits = suspectPath.endsWith('.py')
    ? pyMocks(testSource, suspectPath, suspectFn)
    : jsMocks(testSource, testRelDir, suspectPath);
  return hits.map((hit) => warningFor(hit, suspectPath));
}
