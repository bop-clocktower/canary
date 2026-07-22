import { afterEach, describe, expect, it } from 'vitest';

import {
  MetadataScanner,
  detectedLanguages,
  isEmpty,
  parsePyprojectDeps,
  parseRequirements,
} from '../src/core/metadata-scanner.js';
import { makeProject, type TempProject } from './scanner-testkit.js';

let project: TempProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

function scan(files: Record<string, string>) {
  project = makeProject(files);
  return new MetadataScanner().scan(project.root);
}

describe('MetadataScanner', () => {
  it('is empty for a project with no metadata files', () => {
    const m = scan({ 'README.md': '# hi' });
    expect(isEmpty(m)).toBe(true);
    expect([...detectedLanguages(m)]).toEqual([]);
  });

  it('merges dependencies and devDependencies (dev wins on conflict)', () => {
    const m = scan({
      'package.json': JSON.stringify({
        dependencies: { react: '^18.0.0', lodash: '^4' },
        devDependencies: { react: '^18.3.0', vitest: '^2' },
      }),
    });
    expect(m.jsDependencies).toEqual({
      react: '^18.3.0',
      lodash: '^4',
      vitest: '^2',
    });
    expect([...detectedLanguages(m)].sort()).toEqual([
      'javascript',
      'typescript',
    ]);
  });

  it('ignores malformed package.json', () => {
    const m = scan({ 'package.json': '{ not json' });
    expect(m.jsDependencies).toEqual({});
  });

  it('reads tsconfig compilerOptions, and treats a missing one as empty', () => {
    expect(
      scan({
        'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
      }).tsconfig,
    ).toEqual({ strict: true });
    const noOpts = scan({ 'tsconfig.json': JSON.stringify({ files: [] }) });
    expect(noOpts.tsconfig).toEqual({});
    expect([
      ...detectedLanguages(
        scan({
          'tsconfig.json': JSON.stringify({
            compilerOptions: { strict: true },
          }),
        }),
      ),
    ]).toEqual(['typescript']);
  });

  it('parses requirements.txt and detects python', () => {
    const m = scan({
      'requirements.txt':
        '# comment\nflask==2.3.0\nrequests>=2.28\nbare-pkg\n-e .\n',
    });
    expect(m.pythonPackages).toEqual({
      flask: '==2.3.0',
      requests: '>=2.28',
      'bare-pkg': '',
    });
    expect([...detectedLanguages(m)]).toEqual(['python']);
  });

  it('falls back to pyproject.toml when there is no requirements.txt', () => {
    const m = scan({
      'pyproject.toml': [
        '[project]',
        'name = "x"',
        'dependencies = [',
        '  "flask==2.3.0",',
        '  "httpx",',
        ']',
        '',
        '[tool.ruff]',
        'line-length = 100',
      ].join('\n'),
    });
    expect(m.pythonPackages).toEqual({ flask: '==2.3.0', httpx: '' });
  });

  it('prefers requirements.txt over pyproject.toml when both exist', () => {
    const m = scan({
      'requirements.txt': 'flask==1.0\n',
      'pyproject.toml': '[project]\ndependencies = ["django==4"]\n',
    });
    expect(m.pythonPackages).toEqual({ flask: '==1.0' });
  });

  it('parsePyprojectDeps returns {} without a [project] dependencies array', () => {
    expect(parsePyprojectDeps('[tool.x]\nfoo = 1\n')).toEqual({});
    expect(parsePyprojectDeps('[project]\nname = "x"\n')).toEqual({});
  });

  it('parseRequirements handles all version separators', () => {
    expect(
      parseRequirements('a==1\nb>=2\nc<=3\nd~=4\ne!=5\nf>6\ng<7\nh'),
    ).toEqual({
      a: '==1',
      b: '>=2',
      c: '<=3',
      d: '~=4',
      e: '!=5',
      f: '>6',
      g: '<7',
      h: '',
    });
  });
});
