/**
 * canary-harley -- write every planned file, or none.
 *
 * Each text is staged beside its target first, and only when all are staged
 * are they moved into place. If anything fails, staged files are removed,
 * files already placed are taken back and a replaced file gets its old
 * content again; the error is then thrown.
 */
import fs from 'node:fs';
import path from 'node:path';

// A fixed name beside the target: no clock and no randomness, and a file a
// crashed run left behind is overwritten by the next one.
const beside = (file, suffix) =>
  path.join(
    path.dirname(file.path),
    `.${path.basename(file.path)}.harley-${suffix}`,
  );

/**
 * Write the text under its staged name; nothing final is touched yet. A
 * backup an interrupted run left behind is dropped first: it holds content
 * older than the target, and `undo` must never put that back.
 */
function stage(file) {
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.rmSync(beside(file, 'bak'), { force: true, recursive: true });
  fs.rmSync(beside(file, 'tmp'), { force: true, recursive: true });
  fs.writeFileSync(beside(file, 'tmp'), file.text);
}

/** Move the staged file into place, keeping what it replaces until the end. */
function place(file) {
  if (fs.existsSync(file.path)) {
    fs.renameSync(file.path, beside(file, 'bak'));
  }
  fs.renameSync(beside(file, 'tmp'), file.path);
}

/** Cleanup must not hide the error that caused it. */
function quietly(action) {
  try {
    action();
  } catch {
    // The first failure is the one reported.
  }
}

/** Put one target back as it was before `writePlan` ran. */
function undo(file, wasPlaced) {
  quietly(() => fs.rmSync(beside(file, 'tmp'), { force: true }));
  const kept = beside(file, 'bak');
  if (fs.existsSync(kept)) {
    quietly(() => fs.renameSync(kept, file.path));
  } else if (wasPlaced) {
    quietly(() => fs.rmSync(file.path, { force: true }));
  }
}

/**
 * Write a plan that `planEmit` returned without an error.
 *
 * @param {{ path: string, text: string }[]} files
 */
export function writePlan(files) {
  const placed = [];
  try {
    for (const file of files) stage(file);
    for (const file of files) {
      place(file);
      placed.push(file);
    }
  } catch (exc) {
    for (const file of files) undo(file, placed.includes(file));
    throw exc;
  }
  for (const file of files) fs.rmSync(beside(file, 'bak'), { force: true });
}
