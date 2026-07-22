/**
 * Framework Registry — queries the collection of supported testing frameworks.
 *
 * Faithful TypeScript port of `agent/core/framework_registry.py`. Reads the same
 * `agent/frameworks/registry.json` the Python engine uses. The default path is
 * resolved relative to this file (../../.. → repo root, then agent/frameworks).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { def } from '../util/coalesce.js';

export interface Framework {
  name: string;
  category?: string;
  categories?: string[];
  languages?: string[];
  file_extensions?: string[];
  execution_command?: string | null;
  ci_flags?: string[];
  status?: string;
  maturity?: string;
  recommended_for?: string[];
  strengths?: string[];
  license?: string;
  license_note?: string;
  license_gate?: string | null;
  license_scopes?: string[] | null;
  [key: string]: unknown;
}

export interface ExecutionInfo {
  execution_command: string | null;
  ci_flags: string[];
}

export interface FrameworkSummary {
  name: string;
  category: string | null;
  categories: string[];
  languages: string[];
  file_extensions: string[];
  execution_command: string | null;
  ci_flags: string[];
  status: string | null;
}

/** Default registry path: <repo>/agent/frameworks/registry.json. */
export function defaultRegistryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = ts/src/core → repo root is three levels up.
  return resolve(
    here,
    '..',
    '..',
    '..',
    'agent',
    'frameworks',
    'registry.json',
  );
}

export class FrameworkRegistry {
  private readonly frameworks: Framework[];

  constructor(registryPath: string = defaultRegistryPath()) {
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8')) as {
      frameworks?: Framework[];
    };
    this.frameworks = def(raw.frameworks, []);
  }

  getAllFrameworks(): Framework[] {
    return this.frameworks;
  }

  getByCategory(category: string): Framework[] {
    return this.frameworks.filter(
      (f) =>
        f.category === category || def(f.categories, []).includes(category),
    );
  }

  getPreferredByCategory(category: string): Framework | null {
    const frameworks = this.getByCategory(category);
    const preferred = frameworks.find((f) => f.status === 'preferred');
    if (preferred) return preferred;
    return frameworks[0] ?? null;
  }

  findByName(name: string): Framework | null {
    return this.frameworks.find((f) => f.name === name) ?? null;
  }

  executionInfo(name: string): ExecutionInfo | null {
    const f = this.findByName(name);
    if (f === null) return null;
    return {
      execution_command: def(f.execution_command, null),
      ci_flags: def(f.ci_flags, []),
    };
  }

  summaries(): FrameworkSummary[] {
    return this.frameworks.map((f) => ({
      name: f.name,
      category: def(f.category, null),
      categories: def(f.categories, []),
      languages: def(f.languages, []),
      file_extensions: def(f.file_extensions, []),
      execution_command: def(f.execution_command, null),
      ci_flags: def(f.ci_flags, []),
      status: def(f.status, null),
    }));
  }

  matchByLanguage(language: string): Framework[] {
    return this.frameworks.filter((f) =>
      def(f.languages, []).includes(language),
    );
  }
}
