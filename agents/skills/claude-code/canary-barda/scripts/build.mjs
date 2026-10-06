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

/** Why `out` cannot be built into, or null. */
export function outProblem(out) {
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

/** Writes index.html, site.json and kit/ into `out`; returns the file count. */
export function buildSite(doc, out, { title }) {
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync(KIT_DIR, path.join(out, 'kit'), { recursive: true });
  fs.writeFileSync(
    path.join(out, 'site.json'),
    JSON.stringify(doc) + '\n',
    'utf8',
  );
  fs.writeFileSync(path.join(out, 'index.html'), page({ title }), 'utf8');
  return countFiles(out);
}
