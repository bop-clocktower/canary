/**
 * The one way critical-areas reads a path the scanned tree controls (#1575).
 * A clone materializes tracked symlinks, so a source path or the existing map
 * can name `/dev/zero` (readFileSync never returns, and memory grows without
 * bound) or a FIFO (open blocks forever). Node built-ins only.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** Far past any hand-written source or map; a larger file reads as unread. */
export const MAX_TREE_READ_BYTES = 8 * 1024 * 1024;

// O_NOFOLLOW: a link is refused, not followed, even to a regular file in the
// tree, since that file is read under its own path. O_NONBLOCK: opening a FIFO
// returns at once, and fstat then refuses it. Windows has neither, so both are
// 0 there; its checkouts make tracked links regular files by default.
const OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

/**
 * The file's UTF-8 text, or null when it is missing, unreadable, not a regular
 * file, a symlink, or larger than `maxBytes`. Checked on the open descriptor,
 * so the file cannot be swapped between the check and the read.
 */
export function readRegularFile(
  path: string,
  maxBytes = MAX_TREE_READ_BYTES,
): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, OPEN_FLAGS);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    // One byte of room shows a file that grew after fstat; it reads as unread.
    const buf = Buffer.alloc(stat.size + 1);
    let filled = 0;
    let got = -1;
    while (filled < buf.length && got !== 0) {
      got = readSync(fd, buf, filled, buf.length - filled, null);
      filled += got;
    }
    return filled > stat.size ? null : buf.toString('utf-8', 0, filled);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
