import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// #1201: the DOM libs used to sit in tsconfig.json, which typechecks EVERY
// test here. A node-only test that touched a DOM global (`document`, `name`,
// `close`, `event`) then typechecked clean and failed only at runtime. The
// browser surface now has its own config (tsconfig.site-kit.json), and the
// base config must keep refusing DOM globals.
//
// This compiles a real snippet against each config through the TypeScript API
// rather than grepping the JSON: an `extends`, a `lib` alias, or a stray
// `/// <reference lib="dom" />` would fool a string check, not the compiler.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_ONLY_SNIPPET = 'export const title: string = document.title;\n';

function diagnosticsFor(configFile: string, probeName: string): string[] {
  const configPath = path.join(ROOT, configFile);
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, ROOT);
  const probePath = path.join(ROOT, 'test', probeName);
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    path.resolve(fileName) === probePath
      ? ts.createSourceFile(fileName, NODE_ONLY_SNIPPET, languageVersion)
      : getSourceFile(fileName, languageVersion, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) =>
    path.resolve(fileName) === probePath || fileExists(fileName);
  const program = ts.createProgram([probePath], parsed.options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('tsconfig split (#1201)', () => {
  it('the base config refuses a DOM global in a node-only test', () => {
    const messages = diagnosticsFor('tsconfig.json', 'probe-node-only.ts');
    // TS2304 or TS2584 (the latter appends a "change your target library"
    // hint); both start with the same sentence.
    expect(messages).toEqual([
      expect.stringMatching(/^Cannot find name 'document'\./),
    ]);
  });

  it('the site-kit config still provides DOM globals', () => {
    const messages = diagnosticsFor(
      'tsconfig.site-kit.json',
      'site-kit-probe.ts',
    );
    expect(messages).toEqual([]);
  });

  it('npm run typecheck runs both configs', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    );
    expect(pkg.scripts.typecheck).toMatch(/tsc -p (\.|tsconfig\.json)(\s|$)/);
    expect(pkg.scripts.typecheck).toMatch(
      /tsc -p tsconfig\.site-kit\.json(\s|$)/,
    );
  });
});
