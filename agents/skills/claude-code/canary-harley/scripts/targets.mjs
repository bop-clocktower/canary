/**
 * canary-harley -- the name of a generated test and the import it carries.
 *
 * Both are built from the source path and from function names, so both are
 * checked here: a Python module path is refused unless every segment is an
 * identifier, and `isIdentifier` is what `emit` asks before a function name
 * goes into code.
 */
import path from 'node:path';

import { EXIT_ABSTAINED, fail } from './failure.mjs';
import { langOf } from './signatures.mjs';

const IDENTIFIER = {
  typescript: /^[A-Za-z_$][\w$]*$/,
  python: /^[A-Za-z_]\w*$/,
};

/**
 * @param {string | null} lang
 * @param {string} name
 * @returns {boolean} whether `name` can be written into code as it is
 */
export const isIdentifier = (lang, name) =>
  IDENTIFIER[lang]?.test(name) ?? false;

const TARGETS = {
  typescript: (stem, candidate) =>
    `${stem}.${candidate.functions.join('-')}.${candidate.kind}` +
    '.property.test.ts',
  python: (stem, candidate) => {
    const parts = [stem, ...candidate.functions, candidate.kind].join('_');
    return `test_${parts.replace(/-/g, '_')}_property.py`;
  },
};

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

/**
 * @param {string} file the absolute source path
 * @returns {string | null} the language its tests are written in
 */
export const targetLang = (file) => langOf(file);

/**
 * @param {string} file the absolute source path
 * @param {string} root the absolute project root
 * @param {string} outDir the absolute output directory
 * @returns {object} `{ importPath, stem, pathFor(candidate) }`, or `error`
 */
export function resolveTargets(file, root, outDir) {
  const lang = langOf(file);
  const imported = IMPORTS[lang](file, root, outDir);
  if (imported.error !== null) return { error: imported.error };
  const stem = path.basename(file, path.extname(file));
  return {
    error: null,
    importPath: imported.importPath,
    stem,
    pathFor: (candidate) => path.join(outDir, TARGETS[lang](stem, candidate)),
  };
}
