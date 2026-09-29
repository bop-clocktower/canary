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
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { FrameStatus, RawFrame, ResolvedFrame } from './types.js';

const EXTERNAL = [/(^|[\\/])node_modules[\\/]/, /[\\/]site-packages[\\/]/];

function isExternal(file: string): boolean {
  if (file.startsWith('node:') || file.startsWith('<')) return true;
  return EXTERNAL.some((re) => re.test(file));
}

function inside(rootReal: string, candidate: string): string | null {
  try {
    const real = realpathSync(candidate);
    if (!real.startsWith(rootReal + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function candidates(file: string, root: string): string[] {
  const out = isAbsolute(file) ? [file] : [resolve(root, file)];
  const parts = file.split(/[\\/]/).filter((p) => p !== '');
  for (let i = 1; i < parts.length; i++) {
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
