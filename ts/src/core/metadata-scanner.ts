/**
 * Project metadata scanner — faithful TS port of
 * `agent/core/metadata_scanner.py`.
 *
 * Scans a project root for package.json / requirements.txt / pyproject.toml /
 * tsconfig.json and surfaces dependency versions. Pure filesystem reads; no
 * network, no execution.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ProjectMetadata {
  jsDependencies: Record<string, string>;
  pythonPackages: Record<string, string>;
  tsconfig: Record<string, unknown>;
}

export function isEmpty(m: ProjectMetadata): boolean {
  return (
    Object.keys(m.jsDependencies).length === 0 &&
    Object.keys(m.pythonPackages).length === 0 &&
    Object.keys(m.tsconfig).length === 0
  );
}

/** Infer project languages from detected metadata (matches Python's set). */
export function detectedLanguages(m: ProjectMetadata): Set<string> {
  const langs = new Set<string>();
  if (Object.keys(m.jsDependencies).length > 0) {
    langs.add('typescript');
    langs.add('javascript');
  }
  if (Object.keys(m.tsconfig).length > 0) langs.add('typescript');
  if (Object.keys(m.pythonPackages).length > 0) langs.add('python');
  return langs;
}

const _VERSION_SEPARATORS = ['==', '>=', '<=', '~=', '!=', '>', '<'];

export class MetadataScanner {
  scan(projectRoot = '.'): ProjectMetadata {
    const root = resolve(projectRoot);
    const metadata: ProjectMetadata = {
      jsDependencies: {},
      pythonPackages: {},
      tsconfig: {},
    };

    this.readPackageJson(root, metadata);
    this.readRequirementsTxt(root, metadata);
    if (Object.keys(metadata.pythonPackages).length === 0) {
      this.readPyprojectToml(root, metadata);
    }
    this.readTsconfig(root, metadata);

    return metadata;
  }

  private readPackageJson(root: string, metadata: ProjectMetadata): void {
    const pkg = readJson(resolve(root, 'package.json'));
    if (!pkg) return;
    const deps: Record<string, string> = {};
    const rawDeps = pkg['dependencies'];
    const rawDev = pkg['devDependencies'];
    if (isPlainObject(rawDeps)) Object.assign(deps, rawDeps);
    if (isPlainObject(rawDev)) Object.assign(deps, rawDev);
    metadata.jsDependencies = deps;
  }

  private readRequirementsTxt(root: string, metadata: ProjectMetadata): void {
    const text = readText(resolve(root, 'requirements.txt'));
    if (text === null) return;
    metadata.pythonPackages = parseRequirements(text);
  }

  private readPyprojectToml(root: string, metadata: ProjectMetadata): void {
    const text = readText(resolve(root, 'pyproject.toml'));
    if (text === null) return;
    metadata.pythonPackages = parsePyprojectDeps(text);
  }

  private readTsconfig(root: string, metadata: ProjectMetadata): void {
    const cfg = readJson(resolve(root, 'tsconfig.json'));
    if (!cfg) return;
    const opts = cfg['compilerOptions'];
    metadata.tsconfig = isPlainObject(opts) ? opts : {};
  }
}

function splitDependency(spec: string): [string, string] | null {
  for (const sep of _VERSION_SEPARATORS) {
    const idx = spec.indexOf(sep);
    if (idx !== -1) {
      const name = spec.slice(0, idx);
      const version = spec.slice(idx + sep.length);
      return [name.trim(), sep + version.trim()];
    }
  }
  return null;
}

export function parseRequirements(text: string): Record<string, string> {
  const packages: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const split = splitDependency(line);
    if (split) packages[split[0]] = split[1];
    else packages[line] = '';
  }
  return packages;
}

export function parsePyprojectDeps(text: string): Record<string, string> {
  const section = text.match(/^\[project\]$([\s\S]*?)(?=^\[|$(?![\s\S]))/m);
  if (!section) return {};
  const deps = section[1]!.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (!deps) return {};
  const packages: Record<string, string> = {};
  for (const m of deps[1]!.matchAll(/"([^"]+)"/g)) {
    const depStr = m[1]!;
    const split = splitDependency(depStr);
    if (split) packages[split[0]] = split[1];
    else if (depStr.trim()) packages[depStr.trim()] = '';
  }
  return packages;
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
