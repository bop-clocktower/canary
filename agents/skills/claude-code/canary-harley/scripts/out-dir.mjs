/**
 * canary-harley -- where generated tests may be written.
 *
 * Generated tests are executable code, so the output directory is held
 * inside `<root>/tests/generated/`, by path and again by real path, and an
 * existing file is never replaced without `--force`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { EXIT_USAGE, fail } from './failure.mjs';

const GENERATED = ['tests', 'generated'];
const DEFAULT_OUT_DIR = [...GENERATED, 'property'].join('/');

// C0 and C1 controls, DEL and the Unicode line and paragraph separators.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** The real path of `target`, resolved through its deepest existing ancestor. */
function realTarget(target) {
  const parent = path.dirname(target);
  if (fs.existsSync(target) || parent === target) {
    return fs.realpathSync(target);
  }
  return path.join(realTarget(parent), path.basename(target));
}

/**
 * @param {string} root the absolute project root
 * @param {string | null} outDir the `--out-dir` value, if any
 * @returns {{ dir?: string, error: object | null }} the absolute output
 *   directory, or why it is refused
 */
export function resolveOutDir(root, outDir) {
  const target = path.resolve(root, outDir ?? DEFAULT_OUT_DIR);
  const refusal = fail(
    EXIT_USAGE,
    `argument --out-dir: ${outDir} is outside ${GENERATED.join('/')}/ ` +
      'under the root; generated tests are written only there',
  );
  if (!isInside(path.join(root, ...GENERATED), target)) {
    return { error: refusal };
  }
  const realBase = path.join(fs.realpathSync(root), ...GENERATED);
  if (!isInside(realBase, realTarget(target))) return { error: refusal };
  return { dir: target, error: null };
}

/**
 * @param {{ file: string, outDir: string | null }} opts
 * @returns {object | null} a refusal when a path holds a control character
 */
export function pathError(opts) {
  const tainted = [opts.file, opts.outDir ?? ''].some((text) =>
    CONTROL.test(text),
  );
  if (!tainted) return null;
  return fail(
    EXIT_USAGE,
    'the source path or --out-dir holds a control character; ' +
      'nothing was written',
  );
}

/**
 * @param {{ path: string }[]} files the planned targets
 * @param {boolean} force
 * @returns {object | null} a refusal when a target exists and may not go
 */
export function existingError(files, force) {
  const taken = force ? [] : files.filter((file) => fs.existsSync(file.path));
  if (taken.length === 0) return null;
  return fail(
    EXIT_USAGE,
    `${taken.map((file) => file.path).join(', ')} already exists; ` +
      'pass --force to overwrite it',
  );
}
