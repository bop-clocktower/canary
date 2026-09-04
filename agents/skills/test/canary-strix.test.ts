/**
 * canary-strix — identifier leak scanning (#799).
 *
 * The assertions here are denominator-first, like the sibling detectors. This
 * skill's whole value is refusing to report a clean scan it did not earn, so
 * the cases that matter most are the ones where it must NOT say clean:
 *
 *   - zero terms configured   (matches nothing, whatever it scans)
 *   - only half the scan ran  (files read, commits unreadable)
 *
 * NOTE FOR EDITORS: canary is itself a public repo scanned by its own gate, so
 * every fixture identifier here must be synthetic. Terms that must not appear
 * as literals in this file are composed at runtime.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  HERE,
  '..',
  'claude-code',
  'canary-strix',
  'scripts',
  'cli.mjs',
);

/** Synthetic company term — resembles a denylist entry, belongs to nobody. */
const TERM = 'Zorbatron';
const DIRTY = `Dev <dev@zorbatron.example>`;
const CLEAN = 'Dev <dev@example.com>';

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Repo {
  root: string;
  base: string;
  git: (...a: string[]) => string;
}

/** A throwaway repo with one clean base commit. */
function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'strix-'));
  roots.push(root);
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...a], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: undefined,
        GIT_AUTHOR_EMAIL: undefined,
        GIT_COMMITTER_NAME: undefined,
        GIT_COMMITTER_EMAIL: undefined,
      } as NodeJS.ProcessEnv,
    }).trim();

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'base@example.com');
  git('config', 'user.name', 'base');
  writeFileSync(join(root, 'README.md'), 'hello\n', 'utf-8');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { root, base: git('rev-parse', 'HEAD'), git };
}

function commitAs(r: Repo, ident: string, message: string) {
  const name = ident.slice(0, ident.indexOf('<')).trim();
  const email = ident.slice(ident.indexOf('<') + 1, ident.indexOf('>'));
  r.git(
    '-c',
    `user.name=${name}`,
    '-c',
    `user.email=${email}`,
    'commit',
    '-qm',
    message,
  );
}

interface Run {
  status: number;
  out: string;
}

/**
 * Always capture BOTH streams and the code. `execFileSync` returns stdout only
 * and throws on a non-zero exit, which would have hidden every warning this
 * CLI writes to stderr on an otherwise-successful run.
 */
function runAllowFail(args: string[], env: Record<string, string> = {}): Run {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CANARY_PROPRIETARY_DENYLIST: '', ...env },
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  };
}

describe('canary-strix: what it refuses to call clean', () => {
  it('abstains with zero terms configured, rather than reporting a pass', () => {
    const r = repo();

    const res = runAllowFail(['--root', r.root, '--strict']);

    expect(res.out).toContain('ABSTAINED');
    expect(res.out).not.toMatch(/0 finding\(s\)/);
    expect(res.status).toBe(3);
  });

  it('abstains when only the file half could run', () => {
    // Files read, commits unreadable — a partial scan. Zero findings over a
    // half that never ran is not a green.
    const r = repo();

    const res = runAllowFail(
      ['--root', r.root, '--range', 'nosuchref..HEAD', '--strict'],
      { CANARY_PROPRIETARY_DENYLIST: TERM },
    );

    expect(res.out).toContain('authorship scan could not run');
    expect(res.status).toBe(3);
  });

  it('abstains on a range that resolved but held no commits', () => {
    const r = repo();

    const res = runAllowFail(
      ['--root', r.root, '--range', `${r.base}..${r.base}`, '--strict'],
      { CANARY_PROPRIETARY_DENYLIST: TERM },
    );

    expect(res.out).toContain('held no commits');
    expect(res.status).toBe(3);
  });

  it('reports the denominators on a clean run, so the verdict is checkable', () => {
    const r = repo();

    const res = runAllowFail(['--root', r.root, '--files-only'], {
      CANARY_PROPRIETARY_DENYLIST: TERM,
    });

    expect(res.out).toMatch(/0 finding\(s\) over \d+ file\(s\)/);
    expect(res.out).toContain('1 term(s)');
    expect(res.status).toBe(0);
  });
});

describe('canary-strix: the two surfaces', () => {
  it('STRIX-001 finds an identifier in a tracked file', () => {
    const r = repo();
    writeFileSync(join(r.root, 'notes.md'), `deployed for ${TERM}\n`, 'utf-8');
    r.git('add', '-A');
    commitAs(r, CLEAN, 'notes');

    const res = runAllowFail(['--root', r.root, '--files-only', '--strict'], {
      CANARY_PROPRIETARY_DENYLIST: TERM,
    });

    expect(res.out).toContain('STRIX-001');
    expect(res.out).toContain('notes.md');
    expect(res.status).toBe(1);
  });

  it('STRIX-002 finds an identity a file scan cannot see', () => {
    // The whole reason the authorship half exists: the tree is clean.
    const r = repo();
    writeFileSync(join(r.root, 'f.txt'), 'nothing to see\n', 'utf-8');
    r.git('add', '-A');
    commitAs(r, DIRTY, 'a perfectly innocent change');

    const res = runAllowFail(
      ['--root', r.root, '--range', `${r.base}..HEAD`, '--strict'],
      { CANARY_PROPRIETARY_DENYLIST: TERM },
    );

    expect(res.out).toContain('STRIX-002');
    expect(res.out).toContain('(author');
    expect(res.status).toBe(1);
  });

  it('reads Co-authored-by trailers, not just author and committer', () => {
    const r = repo();
    writeFileSync(join(r.root, 'g.txt'), 'x\n', 'utf-8');
    r.git('add', '-A');
    commitAs(r, CLEAN, `feat: something\n\nCo-authored-by: ${DIRTY}`);

    const res = runAllowFail(
      ['--root', r.root, '--range', `${r.base}..HEAD`, '--strict'],
      { CANARY_PROPRIETARY_DENYLIST: TERM },
    );

    expect(res.out).toContain('trailer');
    expect(res.status).toBe(1);
  });

  it('never echoes the matched identifier into the output', () => {
    // The output goes to a world-readable CI log on a public repo.
    const r = repo();
    writeFileSync(join(r.root, 'notes.md'), `deployed for ${TERM}\n`, 'utf-8');
    r.git('add', '-A');
    commitAs(r, DIRTY, 'notes');

    const res = runAllowFail(['--root', r.root, '--strict'], {
      CANARY_PROPRIETARY_DENYLIST: TERM,
    });

    expect(res.out.toLowerCase()).not.toContain('zorbatron');
    expect(res.out).toContain('STRIX-001');
  });
});

describe('canary-strix: term matching', () => {
  function withFile(body: string) {
    const r = repo();
    writeFileSync(join(r.root, 'notes.md'), body, 'utf-8');
    r.git('add', '-A');
    commitAs(r, CLEAN, 'notes');
    return r;
  }

  it('matches a multi-word term against a concatenated domain', () => {
    // `\b<term>\b` misses this, silently, and fails open.
    const r = withFile('contact dev@zorbatronhealth.example\n');

    const res = runAllowFail(['--root', r.root, '--files-only', '--strict'], {
      CANARY_PROPRIETARY_DENYLIST: 'Zorbatron Health',
    });

    expect(res.status).toBe(1);
  });

  it('matches a term carrying trailing punctuation', () => {
    // `\bZorbatron Inc\.\b` can never match anything: the trailing \b after a
    // dot requires a word character.
    const r = withFile('Zorbatron Inc. ships it\n');

    const res = runAllowFail(['--root', r.root, '--files-only', '--strict'], {
      CANARY_PROPRIETARY_DENYLIST: 'Zorbatron Inc.',
    });

    expect(res.status).toBe(1);
  });

  it('does not match a term that is only a substring', () => {
    const r = withFile('the zorbatronic widget\n');

    const res = runAllowFail(['--root', r.root, '--files-only', '--strict'], {
      CANARY_PROPRIETARY_DENYLIST: TERM,
    });

    expect(res.status).toBe(0);
  });

  it('accepts newline-separated terms, which is the maskable secret form', () => {
    const r = withFile(`deployed for ${TERM}\n`);

    const res = runAllowFail(['--root', r.root, '--files-only', '--strict'], {
      CANARY_PROPRIETARY_DENYLIST: `Quuxcorp\n${TERM}\n`,
    });

    expect(res.status).toBe(1);
  });
});

describe('canary-strix: term sources', () => {
  it('reads a gitignored .proprietary-denylist', () => {
    const r = repo();
    writeFileSync(
      join(r.root, '.proprietary-denylist'),
      `# a comment\n${TERM}\n`,
      'utf-8',
    );
    writeFileSync(join(r.root, 'notes.md'), `for ${TERM}\n`, 'utf-8');
    r.git('add', 'notes.md');
    commitAs(r, CLEAN, 'notes');

    const res = runAllowFail(['--root', r.root, '--files-only', '--strict']);

    expect(res.out).toContain('.proprietary-denylist');
    expect(res.status).toBe(1);
  });

  it('reads .canary/company.json and warns that it is committed', () => {
    const r = repo();
    mkdirSync(join(r.root, '.canary'), { recursive: true });
    writeFileSync(
      join(r.root, '.canary', 'company.json'),
      JSON.stringify({ proprietary_denylist: [TERM] }),
      'utf-8',
    );
    writeFileSync(join(r.root, 'notes.md'), 'nothing here\n', 'utf-8');
    r.git('add', '-A');
    commitAs(r, CLEAN, 'notes');

    const res = runAllowFail(['--root', r.root, '--files-only']);

    expect(res.out).toContain('company.json');
    // The warning is the point: a committed denylist on a public repo
    // publishes the list of identifiers being hidden.
    expect(res.out).toContain('COMMITTED');
  });

  it('unions the sources rather than letting one win', () => {
    const r = repo();
    writeFileSync(join(r.root, '.proprietary-denylist'), 'Quuxcorp\n', 'utf-8');
    writeFileSync(join(r.root, 'notes.md'), `for ${TERM}\n`, 'utf-8');
    r.git('add', 'notes.md');
    commitAs(r, CLEAN, 'notes');

    // The env term is the one that matches; the file term must not displace it.
    const res = runAllowFail(['--root', r.root, '--files-only', '--strict'], {
      CANARY_PROPRIETARY_DENYLIST: TERM,
    });

    expect(res.out).toContain('2 term(s)');
    expect(res.status).toBe(1);
  });
});

describe('canary-strix: CLI contract', () => {
  it('--help exits 0 and needs no repository', () => {
    const res = runAllowFail(['--help']);
    expect(res.out).toContain('usage: canary-strix');
    expect(res.status).toBe(0);
  });

  it('rejects an unknown flag with the family usage code', () => {
    const res = runAllowFail(['--bogus']);
    expect(res.status).toBe(2);
  });

  it('emits a parseable --json payload carrying both denominators', () => {
    const r = repo();

    const res = runAllowFail(['--root', r.root, '--files-only', '--json'], {
      CANARY_PROPRIETARY_DENYLIST: TERM,
    });
    const payload = JSON.parse(res.out);

    expect(payload.skill).toBe('canary-strix');
    expect(payload.term_count).toBe(1);
    expect(payload).toHaveProperty('files_scanned');
    expect(payload).toHaveProperty('commits_scanned');
    expect(Array.isArray(payload.findings)).toBe(true);
  });
});
