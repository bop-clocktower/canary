/**
 * canary-cry's SKILL.md says what the shipped code does (#608 P1-P5; SC20).
 *
 * SC20 reads SKILL.md against the code, not against a list typed here: the
 * subcommands come from the --help choice list (render.mjs USAGE), the limit
 * line from manifest.mjs, the report format and replay command from a report
 * the real report.mjs writes, and the skills the agent layer composes from the
 * skill directories and their CLI_SPECs.
 *
 * The pattern table and the budget table are copies of data the code owns
 * (patterns.mjs, matrix.mjs AMPLITUDES), so they are read back against it: a
 * re-weighted pattern or a re-sized budget fails here, not in a reader's head.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLI_SPEC as CRY_SPEC,
  main as cryMain,
} from '../claude-code/canary-cry/scripts/cli.mjs';
import { ALLOWED_ENVIRONMENTS } from '../claude-code/canary-cry/scripts/gate.mjs';
import { SERVER_SIDE_LIMIT } from '../claude-code/canary-cry/scripts/manifest.mjs';
import { USAGE } from '../claude-code/canary-cry/scripts/render.mjs';
import { CLI_SPEC as REPORTER_SPEC } from '../claude-code/canary-test-reporter/scripts/cli.mjs';
import { AMPLITUDES } from '../claude-code/canary-cry/scripts/matrix.mjs';
import { buildFindings } from '../claude-code/canary-cry/scripts/findings.mjs';
import {
  CHECKPOINT_FORMAT,
  newCheckpoint,
  partialLine,
  recordResult,
} from '../claude-code/canary-cry/scripts/checkpoint.mjs';
import { PATTERNS } from '../claude-code/canary-cry/scripts/patterns.mjs';
import {
  runRounds,
  toResult,
} from '../claude-code/canary-cry/scripts/rounds.mjs';
import {
  scenarioVerdict,
  summarize,
} from '../claude-code/canary-cry/scripts/verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_MD = fs.readFileSync(
  path.join(HERE, '..', 'claude-code', 'canary-cry', 'SKILL.md'),
  'utf8',
);

// Prose is re-wrapped by prettier (proseWrap: always), so a literal sentence is
// matched with its whitespace collapsed.
const PROSE = SKILL_MD.replace(/\s+/g, ' ');

const cells = (line: string | undefined) =>
  (line ?? '')
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
// The table row whose first cell is `first`, compared as a literal string: no
// regex is built from data, so a label never needs escaping.
const row = (first: string) =>
  SKILL_MD.split('\n').find(
    (l) => l.trimStart().startsWith('|') && cells(l)[0] === first,
  );

describe('canary-cry SKILL.md (P1-P4)', () => {
  it.each(['0', '1', '2', '3', '4'])('has an exit-code row for %s', (code) => {
    expect(row(`\`${code}\``), `exit ${code}`).toBeDefined();
  });

  it('documents the abstention line verbatim', () => {
    expect(PROSE).toContain('ABSTAINED: zero scenarios');
  });

  it('lists the allowed environments the gate enforces, exactly', () => {
    expect(PROSE).toContain(
      `${ALLOWED_ENVIRONMENTS.slice(0, -1)
        .map((e) => `\`${e}\``)
        .join(', ')} or \`${ALLOWED_ENVIRONMENTS.at(-1)}\``,
    );
  });

  it('states the server-side limit line verbatim, as the manifest prints it', () => {
    expect(SERVER_SIDE_LIMIT).toMatch(/NOT intercepted/);
    expect(PROSE).toContain(SERVER_SIDE_LIMIT);
  });

  it.each(PATTERNS.map((p) => [p.id, p]))(
    'lists pattern %s with its catalog weight, core and mayRefuse flags',
    (id, p: any) => {
      const [, core, weight, , , mayRefuse] = cells(row(`\`${id}\``));
      expect(weight, id).toBe(String(p.weight));
      expect(core, id).toBe(p.core ? 'yes' : 'no');
      // One flag per intensity (#608 P4), written `i1 / i2 / i3`.
      const flags = p.mayRefuse.map((f: boolean) => (f ? 'yes' : 'no'));
      expect(mayRefuse, id).toBe(flags.join(' / '));
    },
  );

  it.each(Object.entries(AMPLITUDES))(
    'states the %s radius the matrix uses',
    (name, budget: any) => {
      const [, radius] = cells(row(`\`${name}\``));
      const expected =
        budget.radius === Infinity ? 'all flows' : `top ${budget.radius} flows`;
      expect(radius, name).toBe(expected);
    },
  );
});

/** The verdict label verdict.mjs gives one scenario, as SKILL.md writes it. */
function label(over: Record<string, unknown>): string {
  const v = scenarioVerdict({
    flow: 'f',
    pattern: 'multi-submit',
    brokenAt: null,
    invariants: [],
    signals: [],
    ...over,
  });
  const name =
    v.reason === null ? `\`${v.verdict}\`` : `\`abstain: ${v.reason}\``;
  return v.fidelity === null || v.verdict === 'abstain'
    ? name
    : `${name} (${v.fidelity})`;
}

describe('canary-cry SKILL.md: a confirmed run (P3)', () => {
  it.each<[string, Record<string, unknown>]>([
    ['corrupted', { invariants: [{ id: 'i', breached: true }] }],
    ['symptom', { signals: [{ kind: 'pageerror' }] }],
    ['clean', { invariants: [{ id: 'i', breached: false }] }],
    ['no-probes', {}],
    ['flow-broken', { brokenAt: '<step>' }],
    ['probe-failed', { invariants: [{ id: '<invariant>', error: 'x' }] }],
  ])('has a verdict row for %s, worded as the code reports it', (_, over) => {
    const first = label(over);
    expect(row(first), first).toBeDefined();
  });

  it.each(['no-observation', 'runtime-error'])(
    'has a verdict row for abstain: %s',
    (reason) => {
      expect(row(`\`abstain: ${reason}\``)).toBeDefined();
    },
  );

  it.each([
    'ABSTAINED: no @playwright/test in target',
    'ABSTAINED: target unreachable',
    'ABSTAINED: playwright crashed',
  ])('documents the run-level abstention %s', (line) => {
    expect(PROSE).toContain(line);
  });

  it('documents the every-scenario-abstained line the summary prints', () => {
    const { reason } = summarize([{ verdict: 'abstain', reason: 'no-probes' }]);
    expect(reason).toMatch(/^every scenario abstained \(/);
    expect(PROSE).toContain('ABSTAINED: every scenario abstained (');
  });

  it('names the findings.json format the code writes', () => {
    const doc = buildFindings({
      run: {},
      manifest: { scenarios: [] },
      observations: new Map(),
    });
    expect(PROSE).toContain(`"format": "${doc.format}"`);
  });

  it('no longer lists the token-expiry false positive as a known limit (#1720)', () => {
    expect(PROSE).not.toContain('correctly refuses the unauthenticated write');
    expect(PROSE).toContain('passes on a clean refusal');
  });

  it('shows the standalone replay command', () => {
    expect(SKILL_MD).toContain(
      'npx playwright test -c playwright.config.mjs specs/<scenario>.spec.mjs',
    );
  });
});

/** A scream of `rounds` rounds whose round-k scenario finds `found[k]`. */
async function screamLine(found: (string | null)[]) {
  const scenarios = found.map((_, i) => ({
    id: `f:multi-submit:i${i + 1}:sa`,
    flow: 'f',
    pattern: 'multi-submit',
    intensity: i + 1,
  }));
  const observation = (inv: string | null) => ({
    verdict: inv === null ? 'clean' : 'corrupted',
    reason: null,
    invariants: inv === null ? [] : [{ id: inv, breached: true }],
    signals: [],
  });
  const out = await runRounds({
    manifest: { amplitude: 'scream', scenarios },
    run: { id: RUN_ID, manifestSha: 'e'.repeat(64) },
    resumed: null,
    runOne: async (s: any) => ({
      result: toResult(s, observation(found[s.intensity - 1]!)),
    }),
    save: () => {},
    clock: () => 0,
    maxWall: null,
  });
  return out.line!;
}

const RUN_ID = '20261125T143333Z-0123abcd';

describe('canary-cry SKILL.md: rounds, checkpoints, --resume (P4)', () => {
  it('has a run usage line for --resume and documents --max-wall', () => {
    expect(SKILL_MD).toContain('canary-cry run --resume RUN_ID --confirm SHA');
    expect(SKILL_MD).toContain('[--max-wall D]');
  });

  it('documents the convergence line, worded as the code prints it', async () => {
    const line = await screamLine([null, null, null]);
    expect(line).toBe('converged after round 2');
    expect(SKILL_MD).toContain(line);
  });

  it('documents the ceiling line, worded as the code prints it', async () => {
    const line = await screamLine([null, 'one-order', null]);
    expect(PROSE).toContain(line);
  });

  it('documents the PARTIAL line, worded as the code prints it', () => {
    const cp = ['a', 'b'].reduce(
      (c, step) =>
        recordResult(c, {
          id: `f:multi-submit:i1:s${step}`,
          verdict: 'clean',
          fingerprints: [],
        }),
      newCheckpoint({ runId: RUN_ID, manifestSha: 'e'.repeat(64), total: 6 }),
    );
    expect(SKILL_MD).toContain(partialLine(cp));
  });

  it('names the checkpoint format the code writes', () => {
    expect(PROSE).toContain(`\`${CHECKPOINT_FORMAT}\``);
  });

  it('lists every stop reason findings.json can carry', () => {
    for (const reason of [
      'budget',
      'converged',
      'ceiling',
      'partial',
      'crashed',
    ]) {
      expect(PROSE, reason).toContain(`\`${reason}\``);
    }
  });
});

const REPO = path.join(HERE, '..', '..', '..');
const SKILLS_DIR = path.join(HERE, '..', 'claude-code');
const SPEC_MD = path.join(REPO, 'docs', 'changes', 'canary-cry', 'proposal.md');
const ADR_0046 = path.join(
  REPO,
  'docs',
  'knowledge',
  'decisions',
  '0046-live-target-skills-confirmed-manifest-no-replay-no-finding.md',
);

/** The body of the `## <title>` / `### <title>` section, up to the next heading of its level or above. */
function section(title: string): string {
  const lines = SKILL_MD.split('\n');
  const at = lines.findIndex(
    (l) => /^#{2,3} /.test(l) && l.replace(/^#+ /, '') === title,
  );
  if (at < 0) return '';
  const level = lines[at]!.indexOf(' ');
  const end = lines.findIndex(
    (l, i) => i > at && /^#+ /.test(l) && l.indexOf(' ') <= level,
  );
  return lines
    .slice(at + 1, end < 0 ? undefined : end)
    .join(' ')
    .replace(/\s+/g, ' ');
}

/** The commands --help offers: `{validate,matrix,run,report}` in USAGE. */
const COMMANDS = /\{([a-z,]+)\}/.exec(USAGE)![1]!.split(',');

const tmps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** A real report.mjs --json document, over a findings.json buildFindings wrote. */
function realReport(): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cry-docs-'));
  tmps.push(dir);
  const runDir = path.join(dir, 'runs', RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  const id = 'checkout:multi-submit:i1:spay';
  const doc = buildFindings({
    run: { id: RUN_ID },
    manifest: {
      scenarios: [
        {
          id,
          flow: 'checkout',
          pattern: 'multi-submit',
          intensity: 1,
          step: 'pay',
          score: 25,
        },
      ],
    },
    observations: new Map([
      [
        'checkout.multi-submit.i1.spay',
        {
          verdict: 'clean',
          reason: null,
          fidelity: 'state-verified',
          fingerprints: [],
          invariants: [],
          signals: [],
          blockedEgress: [],
          error: null,
        },
      ],
    ]),
  });
  fs.writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify(doc));
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  const code = cryMain([
    'report',
    RUN_ID,
    '--json',
    '--flows',
    path.join(dir, 'flows.json'),
  ]);
  vi.restoreAllMocks();
  expect(code).toBe(0);
  return JSON.parse(out.join('\n'));
}

describe('canary-cry SKILL.md: SC20 (P5)', () => {
  it('--help offers the four top-level commands, report among them', () => {
    expect(COMMANDS).toEqual(['validate', 'matrix', 'run', 'report']);
  });

  it.each([...COMMANDS, 'run --resume'])(
    'has a section for `%s`',
    (command) => {
      const level = command.includes(' ') ? '###' : '##';
      expect(SKILL_MD.split('\n')).toContain(`${level} \`${command}\``);
    },
  );

  it('every command in a usage block is one --help offers', () => {
    const blocks = [...SKILL_MD.matchAll(/^```text\n([\s\S]*?)^```/gm)].map(
      (m) => m[1]!,
    );
    const used = blocks.flatMap((b) =>
      [...b.matchAll(/^canary-cry ([a-z]+) /gm)].map((m) => m[1]),
    );
    expect(new Set(used)).toEqual(new Set(COMMANDS));
  });

  it('ADR 0046 exists and the spec links it', () => {
    expect(fs.existsSync(ADR_0046)).toBe(true);
    const spec = fs.readFileSync(SPEC_MD, 'utf8');
    const links = [...spec.matchAll(/\]\(([^)]+0046-[^)]+\.md)\)/g)].map((m) =>
      path.resolve(path.dirname(SPEC_MD), m[1]!),
    );
    expect(links).toContain(ADR_0046);
  });

  it('documents the report format and replay command report.mjs writes', () => {
    const r = realReport();
    expect(PROSE).toContain(`"format": "${r.format}"`);
    const generic = r.ranked[0].replay.replace(
      /specs\/\S+$/,
      'specs/<scenario>.spec.mjs',
    );
    expect(section('`report`')).toContain(generic);
    for (const key of Object.keys(r.ranked[0])) {
      expect(section('`report`'), key).toContain(key);
    }
  });

  it('states the report ranking the code applies', () => {
    expect(section('`report`')).toContain('corrupted, symptom, clean, abstain');
  });
});

describe('canary-cry SKILL.md: the agent layer (P5)', () => {
  it.each([
    'The agent layer',
    'Drafting `flows.json`',
    'Composing with other skills',
    'The gate pause',
    'Triage with Playwright MCP',
  ])('has a section: %s', (title) => {
    expect(section(title), title).not.toBe('');
  });

  it('the agent never supplies --confirm, fresh or on --resume', () => {
    const gate = section('The gate pause');
    expect(gate).toContain('never run a command that carries `--confirm`');
    expect(gate).toContain('`run --resume`');
    expect(gate).toContain('The human runs the confirmed command themselves');
  });

  it('MCP triage never produces or alters a verdict (D2)', () => {
    const triage = section('Triage with Playwright MCP');
    expect(triage).toContain('never produces a finding');
    expect(triage).toContain(
      'never produces, upgrades, downgrades or removes a verdict',
    );
  });

  it('composes only skills that exist, the five the spec names among them', () => {
    const named = new Set(
      [
        ...section('Composing with other skills').matchAll(
          /\*\*(canary-[a-z-]+)\*\*/g,
        ),
      ].map((m) => m[1]!),
    );
    expect([...named].sort()).toEqual([
      'canary-company-knowledge',
      'canary-critical-areas',
      'canary-edge-case-discovery',
      'canary-failure-impact',
      'canary-test-reporter',
    ]);
    for (const skill of named) {
      expect(
        fs.existsSync(path.join(SKILLS_DIR, skill, 'SKILL.md')),
        skill,
      ).toBe(true);
    }
  });

  it('hands each composed skill a flag its CLI really takes', () => {
    const compose = section('Composing with other skills');
    expect(compose).toContain('--results <run dir>/results.json');
    expect(Object.keys(REPORTER_SPEC.values)).toContain('--results');
    expect(compose).toContain('--critical-areas PATH');
    expect(Object.keys(CRY_SPEC.values)).toContain('--critical-areas');
  });
});
