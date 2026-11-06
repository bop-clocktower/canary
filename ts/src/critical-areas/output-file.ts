/**
 * Where `canary critical-areas` writes, and how. A scanned checkout is
 * untrusted, and a clone materializes its tracked symlinks, so neither the path
 * nor the temp file may be something the tree can aim. Node built-ins only: the
 * critical-areas layer may not reach the CLI, so the caller owns messages and
 * exit codes.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const removeQuietly = (path: string): void => {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // The outcome is already decided: a stray directory is not worth failing on.
  }
};

/**
 * Through a new private directory beside the target, so a failed write can
 * never leave it half-written. A tree can plant a symlink at any name it can
 * predict, and mkdtemp picks a random name and never follows a link.
 *
 * @returns null once the file is in place, else the errno code that stopped it.
 */
export function writeAtomically(out: string, text: string): string | null {
  let tempDir: string | null = null;
  try {
    mkdirSync(dirname(out), { recursive: true });
    tempDir = mkdtempSync(`${out}.tmp-`);
    const temp = join(tempDir, 'map.json');
    writeFileSync(temp, text, 'utf-8');
    renameSync(temp, out);
    return null;
  } catch (err) {
    return String((err as NodeJS.ErrnoException).code);
  } finally {
    if (tempDir !== null) removeQuietly(tempDir);
  }
}

/** Missing is fine (it gets created); a link that cannot be resolved is not. */
function resolvesInside(top: string, dir: string): boolean {
  try {
    if (lstatSync(dir, { throwIfNoEntry: false }) === undefined) return true;
    const rel = relative(realpathSync(top), realpathSync(dir));
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * The default output, or null when `.canary` does not resolve inside the top
 * level. Nobody chose the default path, so a tracked `.canary -> /elsewhere`
 * must not turn a scan into a write elsewhere.
 */
export function defaultOut(top: string): string | null {
  return resolvesInside(top, join(top, '.canary'))
    ? join(top, '.canary', 'critical-areas.json')
    : null;
}
