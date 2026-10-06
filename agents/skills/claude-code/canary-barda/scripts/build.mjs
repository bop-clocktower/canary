// build -- a validated canary.site/1 feed into a static site directory
// (#1151 phase 3b).
//
// The feed is validated before anything is written: an invalid feed builds
// nothing (spec criterion 21). The kit is copied verbatim from lib/site-kit/,
// which ships beside this skill in the npm package. The out dir must be new or
// empty -- barda never deletes or overwrites a file it did not write.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { page } from './page.mjs';

const KIT_DIR = fileURLToPath(
  new URL('../../../lib/site-kit/', import.meta.url),
);

/** `p` with symlinks resolved, though its tail may not exist yet. */
function realish(p) {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return fs.realpathSync(abs);
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(realish(parent), path.basename(abs));
}

/** Why `out` cannot be built into, or null. */
export function outProblem(out) {
  // cpSync cannot copy a tree into itself: it recurses to ENAMETOOLONG and
  // leaves the wreckage in the kit source (review F2).
  const kit = fs.realpathSync(KIT_DIR);
  if (realish(out).startsWith(kit + path.sep))
    return `${out} is inside the site kit (${kit}); build somewhere else`;
  if (!fs.existsSync(out)) return null;
  if (!fs.statSync(out).isDirectory()) return `${out} is not a directory`;
  if (fs.readdirSync(out).length > 0)
    return `${out} is not empty; build into a new or empty directory`;
  return null;
}

const countFiles = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile()).length;

/**
 * Writes index.html, site.json and kit/ into `out`; returns the file count.
 * On failure it removes what it wrote before rethrowing, so a retry is not
 * refused over barda's own half-built output (review S1). `out` was new or
 * empty (outProblem), so everything removed here is barda's.
 */
export function buildSite(doc, out, { title }) {
  const ours = fs.existsSync(out)
    ? ['kit', 'site.json', 'index.html'].map((f) => path.join(out, f))
    : [out];
  try {
    fs.mkdirSync(out, { recursive: true });
    fs.cpSync(KIT_DIR, path.join(out, 'kit'), { recursive: true });
    fs.writeFileSync(
      path.join(out, 'site.json'),
      JSON.stringify(doc) + '\n',
      'utf8',
    );
    fs.writeFileSync(path.join(out, 'index.html'), page({ title }), 'utf8');
  } catch (exc) {
    for (const p of ours) fs.rmSync(p, { recursive: true, force: true });
    throw exc;
  }
  return countFiles(out);
}
