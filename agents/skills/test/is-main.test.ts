import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { isMain } from '../lib/is-main.mjs';

describe('isMain (#1182)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  function scratch(): { real: string; file: string } {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'is-main-'));
    dirs.push(real);
    const dir = path.join(real, 'with space %25 é');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'cli.mjs');
    fs.writeFileSync(file, '');
    return { real, file };
  }

  it('matches the same file named by its URL and by its path', () => {
    const { file } = scratch();
    expect(isMain(pathToFileURL(file).href, file)).toBe(true);
  });

  it('matches through a symlink to the directory', () => {
    const { real, file } = scratch();
    const link = path.join(real, 'link');
    fs.symlinkSync(path.dirname(file), link, 'dir');
    expect(isMain(pathToFileURL(file).href, path.join(link, 'cli.mjs'))).toBe(
      true,
    );
  });

  it('is false for a different file, a missing entry, or no entry', () => {
    const { real, file } = scratch();
    const other = path.join(real, 'other.mjs');
    fs.writeFileSync(other, '');
    expect(isMain(pathToFileURL(file).href, other)).toBe(false);
    expect(isMain(pathToFileURL(file).href, path.join(real, 'nope.mjs'))).toBe(
      false,
    );
    expect(isMain(pathToFileURL(file).href, undefined)).toBe(false);
  });
});
