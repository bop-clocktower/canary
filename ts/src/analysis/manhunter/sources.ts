/**
 * The dossier's only file reader (#611).
 *
 * Every read is tagged: `missing`, `unreadable` (with the reason), or `ok`
 * (with the bytes' sha256). A missing file is never returned as empty text --
 * an empty source and an absent one are different facts, and collapsing them
 * is how a dossier reads green over a source that was never there.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { errnoCode } from '../../core/gate-result.js';
import type { SourceRef } from './types.js';

export type SourceRead =
  | { kind: 'missing'; path: string }
  | { kind: 'unreadable'; path: string; reason: string }
  | { kind: 'ok'; path: string; text: string; sha256: string };

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function readSource(path: string): SourceRead {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { kind: 'missing', path };
    const reason = errnoCode(err) ?? (err as Error).message;
    return { kind: 'unreadable', path, reason };
  }
  return {
    kind: 'ok',
    path,
    text: bytes.toString('utf-8'),
    sha256: sha256Hex(bytes),
  };
}

/** The source as the dossier cites it: path plus the hash of what was read. */
export function sourceRef(read: SourceRead): SourceRef {
  return { path: read.path, sha256: read.kind === 'ok' ? read.sha256 : null };
}

export type JsonRead =
  { ok: true; value: unknown } | { ok: false; reason: string };

/** Parse a read as JSON; every failure carries a reason that names the path. */
export function parseJsonSource(read: SourceRead): JsonRead {
  if (read.kind === 'missing') {
    return { ok: false, reason: `no file at ${read.path}` };
  }
  if (read.kind === 'unreadable') {
    return {
      ok: false,
      reason: `${read.path} could not be read (${read.reason})`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(read.text) as unknown };
  } catch {
    return { ok: false, reason: `${read.path} is not valid JSON` };
  }
}
