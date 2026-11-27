/**
 * canary-harley -- from confirmed candidate ids to the files to write.
 *
 * The plan is all-or-nothing: every id is resolved against the proposal
 * derived from the file as it is now, and every path is checked, before the
 * first byte is written. One bad id means zero files. An id whose signature
 * has changed since it was issued is not in that proposal, so the old
 * confirmation matches nothing.
 *
 * Generated tests are executable code, so the output directory is held
 * inside `<root>/tests/generated/`, by path and again by real path.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { renderFastCheck } from './emit-fast-check.mjs';
import { renderHypothesis } from './emit-hypothesis.mjs';
import { safe } from './safe.mjs';
import { langOf } from './signatures.mjs';

const EXIT_USAGE = 2;
const EXIT_ABSTAINED = 3;

const GENERATED = ['tests', 'generated'];
const DEFAULT_OUT_DIR = [...GENERATED, 'property'].join('/');

// C0 and C1 controls, DEL and the Unicode line and paragraph separators.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const IDENTIFIER = {
  typescript: /^[A-Za-z_$][\w$]*$/,
  python: /^[A-Za-z_]\w*$/,
};

// Messages carry type text, paths and ids. Each is made one inert line here,
// where it is built, so every reader of `error.message` is covered.
const MESSAGE_MAX = 2000;

const fail = (exit, message) => ({
  exit,
  message: safe(message, MESSAGE_MAX),
});

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

/** The absolute output directory, or why it is refused. */
function resolveOutDir(root, outDir) {
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

function pathError(opts) {
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

function candidateError(proposal, lang, id, candidate) {
  if (candidate === undefined) {
    return fail(
      EXIT_ABSTAINED,
      `candidate ${id} is not derivable from ${proposal.source.path} as ` +
        'it is now. A signature may have changed since the id was issued; ' +
        'run propose again and confirm the new id.',
    );
  }
  if (!candidate.emittable) {
    return fail(
      EXIT_ABSTAINED,
      `candidate ${id} cannot be emitted: ${candidate.blocked.join('; ')}`,
    );
  }
  const pattern = IDENTIFIER[lang];
  const odd = candidate.functions.find((name) => !pattern?.test(name));
  if (odd === undefined) return null;
  return fail(
    EXIT_ABSTAINED,
    `candidate ${id} cannot be emitted: a function name is not an identifier`,
  );
}

/** Each distinct id's candidate, or the first id that cannot be used. */
function resolveIds(proposal, lang, ids) {
  const candidates = [];
  for (const id of new Set(ids)) {
    const candidate = proposal.candidates.find((item) => item.id === id);
    const error = candidateError(proposal, lang, id, candidate);
    if (error !== null) return { candidates: [], error };
    candidates.push(candidate);
  }
  return { candidates, error: null };
}

const TARGETS = {
  typescript: (stem, candidate) =>
    `${stem}.${candidate.functions.join('-')}.${candidate.kind}` +
    '.property.test.ts',
  python: (stem, candidate) => {
    const parts = [stem, ...candidate.functions, candidate.kind].join('_');
    return `test_${parts.replace(/-/g, '_')}_property.py`;
  },
};

const targetName = (lang, stem, candidate) => TARGETS[lang](stem, candidate);

/** A relative specifier from the output directory, without the extension. */
function tsImport(file, _root, outDir) {
  const bare = file.slice(0, file.length - path.extname(file).length);
  const relative = path.relative(outDir, bare).split(path.sep).join('/');
  const specifier = relative.startsWith('.') ? relative : `./${relative}`;
  return { importPath: specifier, error: null };
}

/** A dotted module path from the root; every segment must be an identifier. */
function pyImport(file, root) {
  const bare = file.slice(0, file.length - path.extname(file).length);
  const segments = path.relative(root, bare).split(path.sep);
  const odd = segments.find((segment) => !IDENTIFIER.python.test(segment));
  if (odd === undefined) return { importPath: segments.join('.'), error: null };
  return {
    error: fail(
      EXIT_ABSTAINED,
      `cannot write a Python import for ${file}: the path segment ` +
        `'${odd}' is not an identifier. Move the test's import by hand, or ` +
        'run with a --root the module path can be read from.',
    ),
  };
}

const IMPORTS = { typescript: tsImport, python: pyImport };

const RENDERERS = { typescript: renderFastCheck, python: renderHypothesis };

/** The first 8 hex digits of SHA-256 of the id, read as an integer. */
const derivedSeed = (id) =>
  parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16);

function specFor(proposal, candidate, shared) {
  return {
    candidate,
    signatures: candidate.functions.map((name) =>
      proposal.signatures.find((sig) => sig.name === name),
    ),
    importPath: shared.importPath,
    stem: shared.stem,
    seed: shared.seed ?? derivedSeed(candidate.id),
    runs: shared.runs,
  };
}

function existingError(files, force) {
  const taken = force ? [] : files.filter((file) => fs.existsSync(file.path));
  if (taken.length === 0) return null;
  return fail(
    EXIT_USAGE,
    `${taken.map((file) => file.path).join(', ')} already exists; ` +
      'pass --force to overwrite it',
  );
}

/** The checks that need no candidate: the paths and the import. */
function resolveShared(opts, lang) {
  const bad = pathError(opts);
  if (bad !== null) return { error: bad };
  const out = resolveOutDir(opts.root, opts.outDir);
  if (out.error !== null) return { error: out.error };
  const imported = IMPORTS[lang](opts.file, opts.root, out.dir);
  if (imported.error !== null) return { error: imported.error };
  return {
    error: null,
    dir: out.dir,
    importPath: imported.importPath,
    stem: path.basename(opts.file, path.extname(opts.file)),
    seed: opts.seed,
    runs: opts.runs,
  };
}

/**
 * @param {object} proposal the proposal derived from the file as it is now
 * @param {object} opts `{ ids, file, root, outDir, seed, runs, force }`;
 *   `file` and `root` are absolute, `outDir` and `seed` may be null
 * @returns {{ files: { path: string, text: string }[],
 *   error: { exit: number, message: string } | null }} every file, or none
 */
export function planEmit(proposal, opts) {
  const lang = langOf(opts.file);
  const resolved = resolveIds(proposal, lang, opts.ids);
  if (resolved.error !== null) return { files: [], error: resolved.error };
  const shared = resolveShared(opts, lang);
  if (shared.error !== null) return { files: [], error: shared.error };
  const files = resolved.candidates.map((candidate) => ({
    path: path.join(shared.dir, targetName(lang, shared.stem, candidate)),
    text: RENDERERS[lang](specFor(proposal, candidate, shared)),
  }));
  const taken = existingError(files, opts.force);
  return taken === null ? { files, error: null } : { files: [], error: taken };
}

/**
 * Write a plan that `planEmit` returned without an error: every file, or
 * none. Each text is staged beside its target first, and only when all are
 * staged are they moved into place. If anything fails, staged files are
 * removed, files already placed are taken back and a replaced file gets its
 * old content again; the error is then thrown.
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

// A fixed name beside the target: no clock and no randomness, and a file a
// crashed run left behind is overwritten by the next one.
const beside = (file, suffix) =>
  path.join(
    path.dirname(file.path),
    `.${path.basename(file.path)}.harley-${suffix}`,
  );

/** Write the text under its staged name; nothing final is touched yet. */
function stage(file) {
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
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
