/**
 * Throwaway spike harness for #765 D2 -- questions 2 and 3. NOT engine code.
 *
 * Extracts a ShapeNode tree for real canary targets under each Program config,
 * so the report can say what each config can and cannot resolve, and what the
 * abstain rate looks like on this repo's own code.
 *
 *   node extract-shapes.mjs [--config full|narrowed|noresolve] [--ts <root>]
 *   node extract-shapes.mjs --all-configs
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIGS,
  REPO_TS,
  buildProgram,
  denominator,
  functionShapes,
  functionSyntaxOnly,
  loadTs,
  parseOnly,
  shapeOf,
} from './lib.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);

const SRC = path.join(REPO_TS, 'src');
const HARD = path.join(import.meta.dirname, 'hard-target.ts');

/** Real canary targets, chosen for varied shapes. */
const TARGETS = [
  {
    id: 'T1',
    file: path.join(SRC, 'core', 'executor.ts'),
    symbol: 'shlexSplit',
    why: 'primitive arg',
  },
  {
    id: 'T2',
    file: path.join(SRC, 'core', 'adoption.ts'),
    symbol: 'buildAdoptionReport',
    why: 'local interface arg, nullable fields, imported type',
  },
  {
    id: 'T3',
    file: path.join(SRC, 'core', 'ci-ready.ts'),
    symbol: 'scoreCiReady',
    why: 'interfaces imported across files, discriminated unions',
  },
  {
    id: 'T4',
    file: path.join(SRC, 'core', 'gate-result.ts'),
    symbol: 'gateOutcome',
    why: 'generic param, string-literal union, optional field',
  },
  {
    id: 'T5',
    file: HARD,
    symbol: 'hardMapped',
    why: 'mapped type (synthetic: core has none)',
  },
  {
    id: 'T6',
    file: HARD,
    symbol: 'hardConditional',
    why: 'conditional type (synthetic)',
  },
  {
    id: 'T7',
    file: HARD,
    symbol: 'hardIndexed',
    why: 'index signature (synthetic)',
  },
  {
    id: 'T8',
    file: HARD,
    symbol: 'hardTemplate',
    why: 'template literal type (synthetic)',
  },
  {
    id: 'T9',
    file: HARD,
    symbol: 'hardIntersection',
    why: 'intersection type (synthetic)',
  },
  {
    id: 'T10',
    file: HARD,
    symbol: 'hardAny',
    why: 'any / unknown / callable (synthetic)',
  },
];

const rel = (f) => path.relative(path.resolve(REPO_TS, '..'), f);

function runConfig(ts, cfgName) {
  const cfg = CONFIGS[cfgName];
  const files = [...new Set(TARGETS.map((t) => t.file))];
  const program = buildProgram(ts, files, cfg);
  const out = [];
  for (const t of TARGETS) {
    const res = functionShapes(ts, program, t.file, t.symbol);
    if (res.error) {
      out.push({ ...t, file: rel(t.file), error: res.error });
      continue;
    }
    const acc = { total: 0, unresolved: [] };
    for (const p of res.params) denominator(p.shape, acc, `${p.name}`);
    out.push({
      ...t,
      file: rel(t.file),
      params: res.params,
      leavesTotal: acc.total,
      leavesUnresolved: acc.unresolved.length,
      unresolved: acc.unresolved,
    });
  }
  return { config: cfgName, options: cfg, targets: out };
}

function runParseOnly(ts) {
  const out = [];
  for (const t of TARGETS) {
    const sf = parseOnly(ts, t.file, fs.readFileSync(t.file, 'utf8'));
    const res = functionSyntaxOnly(ts, sf, t.symbol);
    out.push({ ...t, file: rel(t.file), ...res });
  }
  return { config: 'parse-only', options: { checker: false }, targets: out };
}

const { ts, version } = await loadTs(opt('ts', undefined));
const configs = has('all-configs')
  ? ['full', 'narrowed', 'noresolve']
  : [opt('config', 'full')];

const result = {
  tsVersion: version,
  node: process.version,
  results: configs.map((c) => runConfig(ts, c)),
};
if (has('all-configs')) result.results.push(runParseOnly(ts));

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
