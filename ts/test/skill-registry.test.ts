/**
 * Tests for the `skill-registry` port (`agent/core/skill_registry.py`). Every
 * non-CLI Python case across the five source test modules is preserved:
 *   - tests/unit/test_skill_registry.py (bundled, local, frontmatter,
 *     executable fields, resolve_cli_path, is_executable_skill_allowed)
 *   - tests/unit/test_global_skill_discovery.py
 *   - tests/unit/test_overlay_discovery.py
 *   - tests/unit/test_skill_registry_precedence.py
 *   - tests/unit/test_skill_requires_frontmatter.py
 *
 * Python patches `Path.home()` to isolate the home-dir tiers; the port injects
 * `home` through the constructor instead (see the source's Python->TS notes).
 * The typer-CLI integration cases (TestOracleSkillsCli) exercise agent/cli, not
 * this module, and are out of scope.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SkillInfo,
  SkillRegistry,
  isExecutableSkillAllowed,
  resolveCliPath,
} from '../src/core/skill-registry.js';

// --- temp-dir bookkeeping ---------------------------------------------------

const tmps: string[] = [];

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

// --- fixture writers (mirror the Python test helpers) -----------------------

function writeSkill(
  skillsRoot: string,
  name: string,
  opts: {
    description?: string;
    cli?: string;
    entry?: string;
    body?: string;
  } = {},
): string {
  const skillDir = join(skillsRoot, name);
  mkdirSync(skillDir, { recursive: true });
  const lines = [`name: ${name}`];
  if (opts.description) lines.push(`description: ${opts.description}`);
  if (opts.cli) lines.push(`cli: ${opts.cli}`);
  if (opts.entry) lines.push(`entry: ${opts.entry}`);
  const text = '---\n' + lines.join('\n') + '\n---\n\n' + (opts.body ?? '');
  writeFileSync(join(skillDir, 'SKILL.md'), text, 'utf-8');
  return skillDir;
}

function makeGitRoot(): string {
  const root = mkTmp('canary-skreg-root-');
  mkdirSync(join(root, '.git'));
  return root;
}

function writeGlobalSkill(
  home: string,
  name: string,
  deployTo?: string[],
): string {
  const skillDir = join(home, '.canary', 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  const dtLine = deployTo ? `deploy_to: [${deployTo.join(', ')}]\n` : '';
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\n${dtLine}---\n\n# ${name}\n`,
    'utf-8',
  );
  return skillDir;
}

function writeOverlaySkill(
  home: string,
  overlay: string,
  name: string,
  description?: string,
): string {
  const skillDir = join(
    home,
    '.canary',
    'overlays',
    overlay,
    '.canary',
    'skills',
    name,
  );
  mkdirSync(skillDir, { recursive: true });
  const descLine = description ? `description: ${description}\n` : '';
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\n${descLine}---\n\n# ${name}\n`,
    'utf-8',
  );
  return skillDir;
}

function writeLocalSkill(cwd: string, name: string): string {
  const skillDir = join(cwd, '.canary', 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\n---\n\n# ${name}\n`,
    'utf-8',
  );
  return skillDir;
}

function writeRegistry(home: string, entries: unknown[]): void {
  mkdirSync(join(home, '.canary'), { recursive: true });
  writeFileSync(
    join(home, '.canary', 'overlays.json'),
    JSON.stringify({ schemaVersion: 1, overlays: entries }),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// Bundled catalog (home isolated so only bundled + cwd-local are discovered)
// ---------------------------------------------------------------------------

describe('bundled skills', () => {
  it('all discovered skills have existing paths', () => {
    const home = mkTmp('canary-home-');
    for (const skill of new SkillRegistry(home).discover()) {
      expect(typeof skill.path).toBe('string');
      expect(require('node:fs').existsSync(skill.path)).toBe(true);
    }
  });

  it('bundled skills have source bundled or local', () => {
    const home = mkTmp('canary-home-');
    for (const s of new SkillRegistry(home).discover()) {
      expect(['bundled', 'local']).toContain(s.source);
    }
  });

  it('result is sorted by name', () => {
    const home = mkTmp('canary-home-');
    const names = new SkillRegistry(home).discover().map((s) => s.name);
    expect(names).toEqual([...names].sort());
  });

  it('isolated from installed home overlays still sees the overlay tier', () => {
    // Regression for #349: an installed overlay under the (isolated) home IS a
    // legitimate source; the original bug was reading the developer's real home.
    const home = mkTmp('canary-home-');
    const sk = join(
      home,
      '.canary',
      'overlays',
      'acme-overlay',
      '.canary',
      'skills',
      'ov-skill',
    );
    mkdirSync(sk, { recursive: true });
    writeFileSync(join(sk, 'SKILL.md'), '---\nname: ov-skill\n---\n\n# ov\n');
    const sources = new Map(
      new SkillRegistry(home).discover().map((s) => [s.name, s.source]),
    );
    expect(sources.get('ov-skill')).toBe('overlay');
  });
});

// ---------------------------------------------------------------------------
// Local overlay skills
// ---------------------------------------------------------------------------

describe('local overlay skills', () => {
  it('local skill is discovered', () => {
    const root = makeGitRoot();
    writeSkill(join(root, '.canary', 'skills'), 'my-custom-skill', {
      description: 'Custom',
    });
    const names = new SkillRegistry(mkTmp('h-'))
      .discover(root)
      .map((s) => s.name);
    expect(names).toContain('my-custom-skill');
  });

  it('local skill has source local', () => {
    const root = makeGitRoot();
    writeSkill(join(root, '.canary', 'skills'), 'company-skill');
    const local = new SkillRegistry(mkTmp('h-'))
      .discover(root)
      .filter((s) => s.name === 'company-skill');
    expect(local).toHaveLength(1);
    expect(local[0]!.source).toBe('local');
  });

  it('local skill overrides bundled', () => {
    const root = makeGitRoot();
    writeSkill(join(root, '.canary', 'skills'), 'canary-generate-test', {
      description: 'Company override',
    });
    const matches = new SkillRegistry(mkTmp('h-'))
      .discover(root)
      .filter((s) => s.name === 'canary-generate-test');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.source).toBe('local');
    expect(matches[0]!.description).toBe('Company override');
  });

  it('local skill discovered from a subdirectory', () => {
    const root = makeGitRoot();
    writeSkill(join(root, '.canary', 'skills'), 'team-skill');
    const subdir = join(root, 'src', 'components');
    mkdirSync(subdir, { recursive: true });
    const names = new SkillRegistry(mkTmp('h-'))
      .discover(subdir)
      .map((s) => s.name);
    expect(names).toContain('team-skill');
  });
});

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

describe('frontmatter parser', () => {
  it('extracts name and description', () => {
    const result = SkillRegistry.parseFrontmatter(
      '---\nname: my-skill\ndescription: Does things\n---\n',
    );
    expect(result['name']).toBe('my-skill');
    expect(result['description']).toBe('Does things');
  });

  it('extracts cli field', () => {
    expect(
      SkillRegistry.parseFrontmatter(
        '---\nname: x\ncli: scripts/cli.py\n---\n',
      )['cli'],
    ).toBe('scripts/cli.py');
  });

  it('extracts entry field', () => {
    // partition on the FIRST colon keeps the module:callable value intact.
    expect(
      SkillRegistry.parseFrontmatter(
        '---\nname: y\nentry: pkg.mod:main\n---\n',
      )['entry'],
    ).toBe('pkg.mod:main');
  });

  it('returns empty without frontmatter', () => {
    expect(SkillRegistry.parseFrontmatter('# no\n')).toEqual({});
  });

  it('skips comment and colon-less lines, parses flow lists', () => {
    const fm = SkillRegistry.parseFrontmatter(
      '---\n# a comment\nname: z\nbare line\nrequires: [a, b]\n---\n',
    );
    expect(fm['name']).toBe('z');
    expect(fm['requires']).toEqual(['a', 'b']);
    expect(fm['bare line']).toBeUndefined();
  });
});

// Regression (adversarial review): discovery is sorted by name. Python sorted()
// orders by code point; JS default string compare orders by UTF-16 code unit,
// which mis-orders astral names (a lead surrogate 0xD83D sorts before BMP
// U+E000, opposite to the true code-point order).
describe('discovery order (code point, not UTF-16 unit)', () => {
  it('orders a BMP name (U+E000) before an astral name (U+1F600)', () => {
    const root = makeGitRoot();
    const skillsRoot = join(root, '.canary', 'skills');
    const astral = '\u{1F600}z'; // U+1F600 -- lead surrogate unit 0xD83D
    const bmp = '\uE000z'; // U+E000 -- a BMP char above the surrogate range
    writeSkill(skillsRoot, astral, {});
    writeSkill(skillsRoot, bmp, {});
    const names = new SkillRegistry(mkTmp('h-'))
      .discover(root)
      .map((s) => s.name);
    const ia = names.indexOf(astral);
    const ib = names.indexOf(bmp);
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ib).toBeGreaterThanOrEqual(0);
    // Code point: U+E000 (0xE000) < U+1F600 -> bmp first (matches Python).
    // UTF-16 unit: 0xD83D < 0xE000 -> astral would sort first (the bug we fixed).
    expect(ib).toBeLessThan(ia);
  });
});

// ---------------------------------------------------------------------------
// Executable fields
// ---------------------------------------------------------------------------

describe('executable fields', () => {
  it('cli field makes skill executable', () => {
    const root = makeGitRoot();
    writeSkill(join(root, '.canary', 'skills'), 'alpha', {
      cli: 'scripts/cli.py',
    });
    const skill = new SkillRegistry(mkTmp('h-')).find('alpha', root)!;
    expect(skill.cli).toBe('scripts/cli.py');
    expect(skill.entry).toBeNull();
    expect(skill.error).toBeNull();
    expect(skill.isExecutable).toBe(true);
  });

  it('entry field makes skill executable', () => {
    const root = makeGitRoot();
    writeSkill(join(root, '.canary', 'skills'), 'alpha', {
      entry: 'pkg.mod:main',
    });
    const skill = new SkillRegistry(mkTmp('h-')).find('alpha', root)!;
    expect(skill.entry).toBe('pkg.mod:main');
    expect(skill.isExecutable).toBe(true);
  });

  it('both cli and entry is a validation error', () => {
    const root = makeGitRoot();
    writeSkill(join(root, '.canary', 'skills'), 'alpha', {
      cli: 'scripts/cli.py',
      entry: 'pkg:main',
    });
    const skill = new SkillRegistry(mkTmp('h-')).find('alpha', root)!;
    expect(skill.error).not.toBeNull();
    expect(skill.error).toContain('mutually exclusive');
    expect(skill.isExecutable).toBe(false);
  });

  it('markdown-only skill is not executable', () => {
    const root = makeGitRoot();
    writeSkill(join(root, '.canary', 'skills'), 'alpha', {
      description: 'prose only',
    });
    const skill = new SkillRegistry(mkTmp('h-')).find('alpha', root)!;
    expect(skill.isExecutable).toBe(false);
  });

  // Regression (adversarial review): a flow-list `cli:` is malformed. The Python
  // oracle accepts it (marks the skill executable) then crashes with a TypeError
  // in resolve_cli_path. We consciously diverge: reject it as a validation error
  // (non-executable, clear diagnostic) rather than crash or silently downgrade.
  it('rejects a list-valued cli: as a validation error', () => {
    const root = makeGitRoot();
    // `cli: [run.js]` parses as a flow-list, not a scalar path.
    writeSkill(join(root, '.canary', 'skills'), 'alpha', {
      cli: '[run.js]',
    });
    const skill = new SkillRegistry(mkTmp('h-')).find('alpha', root)!;
    expect(skill.error).not.toBeNull();
    expect(skill.error).toContain('scalar path');
    expect(skill.isExecutable).toBe(false);
  });

  it('uses the blockquote tagline when description is absent', () => {
    // Exercises parse_nested's blockquote fallback.
    const root = makeGitRoot();
    const skillsRoot = join(root, '.canary', 'skills');
    mkdirSync(join(skillsRoot, 'quoted'), { recursive: true });
    writeFileSync(
      join(skillsRoot, 'quoted', 'SKILL.md'),
      '---\nname: quoted\n---\n\n> One line\n> tagline\n\nBody.\n',
      'utf-8',
    );
    const skill = new SkillRegistry(mkTmp('h-')).find('quoted', root)!;
    expect(skill.description).toBe('One line tagline');
  });
});

// ---------------------------------------------------------------------------
// resolveCliPath
// ---------------------------------------------------------------------------

describe('resolveCliPath', () => {
  it('resolves inside the skill dir', () => {
    const root = makeGitRoot();
    const skillDir = writeSkill(join(root, '.canary', 'skills'), 'alpha', {
      cli: 'scripts/cli.py',
    });
    mkdirSync(join(skillDir, 'scripts'));
    writeFileSync(
      join(skillDir, 'scripts', 'cli.py'),
      '#!/usr/bin/env python3\n',
    );
    const skill = new SkillRegistry(mkTmp('h-')).find('alpha', root)!;
    const target = resolveCliPath(skill);
    expect(basename(target)).toBe('cli.py');
    expect(isAbsolute(target)).toBe(true);
  });

  it('rejects a path escape', () => {
    const root = makeGitRoot();
    writeSkill(join(root, '.canary', 'skills'), 'alpha', {
      cli: '../../../etc/passwd',
    });
    const skill = new SkillRegistry(mkTmp('h-')).find('alpha', root)!;
    expect(() => resolveCliPath(skill)).toThrow(/escapes/);
  });

  it('rejects a missing target', () => {
    const root = makeGitRoot();
    writeSkill(join(root, '.canary', 'skills'), 'alpha', {
      cli: 'scripts/missing.py',
    });
    const skill = new SkillRegistry(mkTmp('h-')).find('alpha', root)!;
    expect(() => resolveCliPath(skill)).toThrow(/does not exist/);
  });

  it('rejects a symlink escape', () => {
    const root = makeGitRoot();
    const skillDir = writeSkill(join(root, '.canary', 'skills'), 'alpha', {
      cli: 'scripts/cli.py',
    });
    const outside = join(root, 'outside.py');
    writeFileSync(outside, '#!/usr/bin/env python3\n');
    mkdirSync(join(skillDir, 'scripts'));
    try {
      symlinkSync(outside, join(skillDir, 'scripts', 'cli.py'));
    } catch {
      return; // symlink creation not supported
    }
    const skill = new SkillRegistry(mkTmp('h-')).find('alpha', root)!;
    expect(() => resolveCliPath(skill)).toThrow(/escapes/);
  });

  it('rejects a skill without cli', () => {
    const root = makeGitRoot();
    writeSkill(join(root, '.canary', 'skills'), 'alpha', {
      description: 'prose only',
    });
    const skill = new SkillRegistry(mkTmp('h-')).find('alpha', root)!;
    expect(() => resolveCliPath(skill)).toThrow(/no cli:/);
  });
});

// ---------------------------------------------------------------------------
// isExecutableSkillAllowed
// ---------------------------------------------------------------------------

describe('isExecutableSkillAllowed', () => {
  let origCI: string | undefined;
  let origTTY: boolean | undefined;

  function setTTY(value: boolean | undefined): void {
    Object.defineProperty(process.stdin, 'isTTY', {
      value,
      configurable: true,
    });
  }

  afterEach(() => {
    if (origCI === undefined) delete process.env.CI;
    else process.env.CI = origCI;
    setTTY(origTTY);
  });

  function snapshot(): void {
    origCI = process.env.CI;
    origTTY = process.stdin.isTTY;
  }

  it('interactive tty, no CI, allows', () => {
    snapshot();
    process.env.CI = '';
    setTTY(true);
    expect(isExecutableSkillAllowed(false)).toBe(true);
  });

  it('CI=true blocks', () => {
    snapshot();
    process.env.CI = 'true';
    setTTY(true);
    expect(isExecutableSkillAllowed(false)).toBe(false);
  });

  it('CI=true with the allow flag allows', () => {
    snapshot();
    process.env.CI = 'true';
    setTTY(true);
    expect(isExecutableSkillAllowed(true)).toBe(true);
  });

  it('non-tty blocks', () => {
    snapshot();
    process.env.CI = '';
    setTTY(false);
    expect(isExecutableSkillAllowed(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Global home-dir discovery
// ---------------------------------------------------------------------------

describe('global skill discovery', () => {
  it('global skill discovered outside any repo', () => {
    const home = mkTmp('h-');
    const cwd = mkTmp('cwd-');
    writeGlobalSkill(home, 'my-global-skill');
    const names = new SkillRegistry(home).discover(cwd).map((s) => s.name);
    expect(names).toContain('my-global-skill');
  });

  it('global skill source is global', () => {
    const home = mkTmp('h-');
    const cwd = mkTmp('cwd-');
    writeGlobalSkill(home, 'my-global-skill');
    const skill = new SkillRegistry(home)
      .discover(cwd)
      .find((s) => s.name === 'my-global-skill')!;
    expect(skill.source).toBe('global');
  });

  it('local skill overrides global of the same name', () => {
    const home = mkTmp('h-');
    const cwd = mkTmp('cwd-');
    writeGlobalSkill(home, 'shared-skill');
    writeLocalSkill(cwd, 'shared-skill');
    const skill = new SkillRegistry(home)
      .discover(cwd)
      .find((s) => s.name === 'shared-skill')!;
    expect(skill.source).toBe('local');
  });

  it('no global dir returns no global skills', () => {
    const home = mkTmp('h-');
    const cwd = mkTmp('cwd-');
    const skills = new SkillRegistry(home).discover(cwd);
    expect(skills.some((s) => s.source === 'global')).toBe(false);
  });

  it('multiple global skills all discovered', () => {
    const home = mkTmp('h-');
    const cwd = mkTmp('cwd-');
    writeGlobalSkill(home, 'skill-alpha');
    writeGlobalSkill(home, 'skill-beta');
    const globalNames = new SkillRegistry(home)
      .discover(cwd)
      .filter((s) => s.source === 'global')
      .map((s) => s.name);
    expect(globalNames).toContain('skill-alpha');
    expect(globalNames).toContain('skill-beta');
  });

  it('global skill with deploy_to parsed', () => {
    const home = mkTmp('h-');
    const cwd = mkTmp('cwd-');
    writeGlobalSkill(home, 'login-helper', ['e2e_ui', 'api']);
    const skill = new SkillRegistry(home)
      .discover(cwd)
      .find((s) => s.name === 'login-helper')!;
    expect(skill.deploy_to).toEqual(['e2e_ui', 'api']);
  });

  it('global skill wins over bundled', () => {
    const home = mkTmp('h-');
    const cwd = mkTmp('cwd-');
    writeGlobalSkill(home, 'verify'); // 'verify' may or may not be bundled here
    const verify = new SkillRegistry(home)
      .discover(cwd)
      .find((s) => s.name === 'verify');
    if (verify) expect(verify.source).toBe('global');
  });

  it('global skill available from any cwd', () => {
    const home = mkTmp('h-');
    const cwd1 = mkTmp('cwd1-');
    const cwd2 = mkTmp('cwd2-');
    writeGlobalSkill(home, 'my-global-skill');
    const reg = new SkillRegistry(home);
    expect(reg.discover(cwd1).map((s) => s.name)).toContain('my-global-skill');
    expect(reg.discover(cwd2).map((s) => s.name)).toContain('my-global-skill');
  });
});

// ---------------------------------------------------------------------------
// Tracked-overlay discovery
// ---------------------------------------------------------------------------

describe('overlay discovery', () => {
  it('overlay skill discovered', () => {
    const home = mkTmp('h-');
    const cwd = mkTmp('cwd-');
    writeOverlaySkill(home, 'example-org-example-overlay', 'ov-skill');
    const names = new SkillRegistry(home).discover(cwd).map((s) => s.name);
    expect(names).toContain('ov-skill');
  });

  it('overlay source label', () => {
    const home = mkTmp('h-');
    const cwd = mkTmp('cwd-');
    writeOverlaySkill(home, 'ov', 'ov-skill');
    const skill = new SkillRegistry(home)
      .discover(cwd)
      .find((s) => s.name === 'ov-skill')!;
    expect(skill.source).toBe('overlay');
  });

  it('overlay overrides bundled', () => {
    const home = mkTmp('h-');
    const cwd = mkTmp('cwd-');
    const bundled = new SkillRegistry(home)
      .discover(cwd)
      .filter((s) => s.source === 'bundled');
    if (bundled.length === 0) return; // no bundled skills to shadow
    const name = bundled[0]!.name;
    writeOverlaySkill(home, 'ov', name);
    const skill = new SkillRegistry(home)
      .discover(cwd)
      .find((s) => s.name === name)!;
    expect(skill.source).toBe('overlay');
  });

  it('global overrides overlay', () => {
    const home = mkTmp('h-');
    const cwd = mkTmp('cwd-');
    writeOverlaySkill(home, 'ov', 'shared');
    writeGlobalSkill(home, 'shared');
    const skill = new SkillRegistry(home)
      .discover(cwd)
      .find((s) => s.name === 'shared')!;
    expect(skill.source).toBe('global');
  });

  it('local overrides overlay', () => {
    const home = mkTmp('h-');
    const cwd = mkTmp('cwd-');
    writeOverlaySkill(home, 'ov', 'shared');
    writeLocalSkill(cwd, 'shared');
    const skill = new SkillRegistry(home)
      .discover(cwd)
      .find((s) => s.name === 'shared')!;
    expect(skill.source).toBe('local');
  });

  it('no overlays dir yields no overlay skills', () => {
    const home = mkTmp('h-');
    const cwd = mkTmp('cwd-');
    const skills = new SkillRegistry(home).discover(cwd);
    expect(skills.some((s) => s.source === 'overlay')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Overlay precedence (#333)
// ---------------------------------------------------------------------------

describe('overlay precedence', () => {
  function descOf(home: string, name: string): string {
    const skill = new SkillRegistry(home)
      .discover()
      .find((s) => s.name === name)!;
    return skill.description;
  }

  it('higher precedence overlay wins the collision', () => {
    const home = mkTmp('h-');
    // "a-ov" sorts first (would LOSE under dir-name order); higher precedence
    // must make it WIN.
    writeOverlaySkill(home, 'a-ov', 'dup', 'from-a');
    writeOverlaySkill(home, 'z-ov', 'dup', 'from-z');
    writeRegistry(home, [
      { name: 'a-ov', precedence: 10 },
      { name: 'z-ov', precedence: 1 },
    ]);
    expect(descOf(home, 'dup')).toBe('from-a');
  });

  it('equal precedence falls back to dir-name order', () => {
    const home = mkTmp('h-');
    writeOverlaySkill(home, 'a-ov', 'dup', 'from-a');
    writeOverlaySkill(home, 'z-ov', 'dup', 'from-z');
    writeRegistry(home, [{ name: 'a-ov' }, { name: 'z-ov' }]);
    expect(descOf(home, 'dup')).toBe('from-z');
  });

  it('missing registry falls back to dir-name order', () => {
    const home = mkTmp('h-');
    writeOverlaySkill(home, 'a-ov', 'dup', 'from-a');
    writeOverlaySkill(home, 'z-ov', 'dup', 'from-z');
    expect(descOf(home, 'dup')).toBe('from-z');
  });

  it('null precedence loses to positive', () => {
    const home = mkTmp('h-');
    writeOverlaySkill(home, 'a-ov', 'dup', 'from-a');
    writeOverlaySkill(home, 'z-ov', 'dup', 'from-z');
    writeRegistry(home, [
      { name: 'a-ov', precedence: null },
      { name: 'z-ov', precedence: 3 },
    ]);
    expect(descOf(home, 'dup')).toBe('from-z');
  });
});

// ---------------------------------------------------------------------------
// requires: frontmatter (#336)
// ---------------------------------------------------------------------------

describe('requires frontmatter', () => {
  it('flow list is parsed', () => {
    const fm = SkillRegistry.parseFrontmatter(
      '---\nname: x\nrequires: [python3>=3.10, node>=20]\n---\n',
    );
    expect(SkillRegistry.parseStrList(fm, 'requires')).toEqual([
      'python3>=3.10',
      'node>=20',
    ]);
  });

  it('scalar is normalized to a list', () => {
    const fm = SkillRegistry.parseFrontmatter(
      '---\nname: x\nrequires: python3\n---\n',
    );
    expect(SkillRegistry.parseStrList(fm, 'requires')).toEqual(['python3']);
  });

  it('absent is an empty list', () => {
    const fm = SkillRegistry.parseFrontmatter('---\nname: x\n---\n');
    expect(SkillRegistry.parseStrList(fm, 'requires')).toEqual([]);
  });

  it('SkillInfo exposes requires', () => {
    const home = mkTmp('h-');
    const d = join(home, '.canary', 'skills', 'runner');
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, 'SKILL.md'),
      '---\nname: runner\ncli: scripts/cli.py\nrequires: [python3>=3.10]\n---\n',
      'utf-8',
    );
    const skill = new SkillRegistry(home).find('runner', home)!;
    expect(skill.requires).toEqual(['python3>=3.10']);
  });

  it('every executable bundled skill declares requires', () => {
    // Contract-adoption guard (#336): isolate home so only bundled are seen.
    const skills = new SkillRegistry(mkTmp('h-')).discover();
    const executable = skills.filter((s) => s.isExecutable);
    expect(executable.length).toBeGreaterThan(0);
    const missing = executable.filter((s) => s.requires.length === 0);
    expect(missing.map((s) => s.name)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SkillInfo construction defaults
// ---------------------------------------------------------------------------

describe('SkillInfo', () => {
  it('defaults optional fields and derives dir', () => {
    const info = new SkillInfo({
      name: 'x',
      path: join('a', 'b', 'SKILL.md'),
      source: 'bundled',
    });
    expect(info.description).toBe('');
    expect(info.cli).toBeNull();
    expect(info.entry).toBeNull();
    expect(info.deploy_to).toEqual([]);
    expect(info.requires).toEqual([]);
    expect(info.error).toBeNull();
    expect(info.isExecutable).toBe(false);
    expect(basename(info.dir)).toBe('b');
  });
});
