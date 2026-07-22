/** Test helper: materialize a throwaway project tree in a temp dir. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempProject {
  root: string;
  cleanup: () => void;
}

export function makeProject(files: Record<string, string>): TempProject {
  const base = mkdtempSync(join(tmpdir(), 'canary-scan-'));
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
  return {
    root,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
