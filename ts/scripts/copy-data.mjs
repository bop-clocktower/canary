#!/usr/bin/env node
/**
 * Copy non-TS engine assets into `dist/` after `tsc` (which only emits compiled
 * JS/d.ts and ignores data files). Currently just the framework registry:
 * `src/data/frameworks/registry.json` -> `dist/data/frameworks/registry.json`.
 *
 * `FrameworkRegistry.defaultRegistryPath()` resolves the registry as
 * `../data/frameworks/registry.json` relative to the compiled
 * `dist/core/framework-registry.js`, so the file must physically exist under
 * `dist/data/`. vitest runs the TS sources directly and resolves against
 * `src/data/` instead, so the source-of-truth lives under `src/`.
 */
import { cpSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tsRoot = resolve(here, '..');
const src = resolve(tsRoot, 'src', 'data');
const dest = resolve(tsRoot, 'dist', 'data');

if (!existsSync(src)) {
  process.stderr.write(`[copy-data] no data dir at ${src}; nothing to copy\n`);
  process.exit(0);
}

cpSync(src, dest, { recursive: true });
process.stdout.write(`[copy-data] copied ${src} -> ${dest}\n`);
