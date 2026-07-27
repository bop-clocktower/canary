/**
 * Faithful TypeScript port of `tests/unit/test_guardian_agent_tier.py` (plus the
 * `tier.ts` resolution seam it exercises).
 *
 * `agent-tier.ts` is the ONE module where agent orchestration is allowed. Under
 * Option A it NEVER calls an LLM -- it plans authoring intents, parses agent
 * transcripts, and enforces the write-safety model, reaching agents only through
 * an injected `AgentInvoker` port. Every test drives that port with a local
 * `FakeInvoker` (or the default `RecordingInvoker`) -- no real agent/LLM/network,
 * and the read-only/planning paths write nothing to disk.
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentInvoker,
  AuthoringContext,
  GeneratedTest,
  InSessionAgentProbe,
  InSessionAgentTier,
  RecordingInvoker,
  ReviewRequest,
  decideBlock,
  planAuthoring,
  targetTestPath,
} from '../src/guardian/agent-tier.js';
import { Severity } from '../src/guardian/impact-mapper.js';
import { Finding } from '../src/guardian/pr-check.js';
import { resolveTier } from '../src/guardian/tier.js';
import { mkTmp, rmTmp } from './guardian-cli-testkit.js';

function finding(path = 'src/foo.py', unit = 'foo'): Finding {
  return new Finding({ path, unit });
}

/** Test double satisfying the `AgentInvoker` port. Calls nothing real. */
class FakeInvoker implements AgentInvoker {
  reviewCalls: ReviewRequest[] = [];
  authorCalls: GeneratedTest[] = [];

  constructor(private readonly reviewTranscript = '') {}

  review(request: ReviewRequest): string {
    this.reviewCalls.push(request);
    return this.reviewTranscript;
  }

  author(intent: GeneratedTest): GeneratedTest {
    this.authorCalls.push(intent);
    return new GeneratedTest({
      gap: intent.gap,
      target_path: intent.target_path,
      requirement: intent.requirement,
      status: 'authored',
      written_path: intent.target_path,
    });
  }
}

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => {
  rmTmp(tmp);
});

describe('foundation (T1)', () => {
  it('generated_test defaults', () => {
    const gen = new GeneratedTest({
      gap: finding(),
      target_path: 't',
      requirement: 'r',
    });
    expect(gen.status).toBe('planned');
    expect(gen.written_path).toBeNull();
    expect(gen.skip_reason).toBeNull();
  });

  it('recording invoker reviews nothing', () => {
    expect(new RecordingInvoker().review({ test_paths: [] })).toBe('');
  });

  it('recording invoker author stays planned', () => {
    const intent = new GeneratedTest({
      gap: finding(),
      target_path: 't',
      requirement: 'r',
    });
    const result = new RecordingInvoker().author(intent);
    expect(result.status).toBe('planned');
    expect(result.written_path).toBeNull();
  });
});

describe('audit test quality (T2)', () => {
  it('parses transcript into weak-test findings', () => {
    const invoker = new FakeInvoker(
      '[Critical] tests/foo_test.py:12 assertion is tautological\n' +
        '[medium] tests/bar_test.py:4 missing negative case\n',
    );
    const tier = new InSessionAgentTier({ invoker });
    const findings = tier.audit_test_quality(['tests/foo_test.py']);

    expect(findings.length).toBe(2);
    expect(findings.every((f) => f.kind === 'weak-test')).toBe(true);
    const first = findings[0]!;
    expect(first.path).toBe('tests/foo_test.py');
    expect(first.severity).toBe(Severity.CRITICAL);
    expect(invoker.reviewCalls.length).toBeGreaterThan(0);
    expect(invoker.reviewCalls[0]!.test_paths).toEqual(['tests/foo_test.py']);
  });

  it('default recording invoker audits nothing', () => {
    const tier = new InSessionAgentTier();
    expect(tier.audit_test_quality(['some_test.py'])).toEqual([]);
  });

  it('malformed lines are skipped not crashing', () => {
    const invoker = new FakeInvoker(
      'this is not a finding line\n' +
        '[Critical] tests/foo_test.py:12 real one\n' +
        '[bogus-severity] tests/x_test.py:1 unknown severity\n' +
        '\n',
    );
    const tier = new InSessionAgentTier({ invoker });
    const findings = tier.audit_test_quality(['tests/foo_test.py']);
    expect(findings.length).toBe(1);
    expect(findings[0]!.path).toBe('tests/foo_test.py');
    expect(findings[0]!.severity).toBe(Severity.CRITICAL);
  });
});

describe('InSessionAgentProbe (T3 / SC-5)', () => {
  it('env unset -> ceiling zero and degrades', () => {
    const probe = new InSessionAgentProbe({});
    expect(probe.availableTier()).toBe(0);
    const resolution = resolveTier(2, probe);
    expect(resolution.effective).toBe(0);
    expect(resolution.degraded_notice).not.toBeNull();
    expect(resolution.degraded_notice).toContain('tier 2');
  });

  it('tier two present -> no false degradation', () => {
    const probe = new InSessionAgentProbe({ CANARY_GUARDIAN_AGENT: '2' });
    expect(probe.availableTier()).toBe(2);
    const resolution = resolveTier(2, probe);
    expect(resolution.effective).toBe(2);
    expect(resolution.degraded_notice).toBeNull();
  });

  it('tier one present caps two loudly, serves one', () => {
    const probe = new InSessionAgentProbe({ CANARY_GUARDIAN_AGENT: '1' });
    expect(probe.availableTier()).toBe(1);
    const capped = resolveTier(2, probe);
    expect(capped.effective).toBe(1);
    expect(capped.degraded_notice).toContain('tier 2');
    const served = resolveTier(1, probe);
    expect(served.effective).toBe(1);
    expect(served.degraded_notice).toBeNull();
  });

  it.each(['9', 'x', '', '-1', '1.0'])(
    'garbage value %s is zero',
    (garbage) => {
      const probe = new InSessionAgentProbe({ CANARY_GUARDIAN_AGENT: garbage });
      expect(probe.availableTier()).toBe(0);
    },
  );

  it('resolveTier default probe is NoAgentProbe', () => {
    // No probe -> NoAgentProbe -> tier 0 ceiling.
    expect(resolveTier(2).effective).toBe(0);
    expect(resolveTier(0).degraded_notice).toBeNull();
  });
});

describe('plan authoring (T4 / D4)', () => {
  function okCtx(): AuthoringContext {
    return new AuthoringContext(true, 2, {
      is_fork: false,
      repo_root: tmp,
      authored_sentinel_present: false,
    });
  }

  it('guard d opt-in off skips all', () => {
    const ctx = new AuthoringContext(false, 2, { repo_root: tmp });
    const results = planAuthoring([finding()], ctx);
    expect(results.map((r) => r.status)).toEqual(['skipped']);
    expect(results[0]!.skip_reason ?? '').toContain('opt-in');
  });

  it('guard d tier below two skips', () => {
    const ctx = new AuthoringContext(true, 1, { repo_root: tmp });
    const results = planAuthoring([finding()], ctx);
    expect(results[0]!.status).toBe('skipped');
    expect(results[0]!.skip_reason ?? '').toContain('tier');
  });

  it('guard b fork skips all', () => {
    const ctx = new AuthoringContext(true, 2, {
      is_fork: true,
      repo_root: tmp,
    });
    const results = planAuthoring([finding()], ctx);
    expect(results.every((r) => r.status === 'skipped')).toBe(true);
    expect(results[0]!.skip_reason ?? '').toContain('fork');
  });

  it('guard a sentinel skips all', () => {
    const ctx = new AuthoringContext(true, 2, {
      repo_root: tmp,
      authored_sentinel_present: true,
    });
    const results = planAuthoring([finding()], ctx);
    expect(results.every((r) => r.status === 'skipped')).toBe(true);
    expect(results[0]!.skip_reason ?? '').toContain('already authored');
  });

  it('guard c collision when target exists', () => {
    const gap = finding('src/foo.py', 'foo');
    const target = join(tmp, targetTestPath(gap));
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(target, '# pre-existing test from another PR\n', 'utf-8');
    const results = planAuthoring([gap], okCtx());
    expect(results[0]!.status).toBe('skipped');
    const reason = results[0]!.skip_reason ?? '';
    expect(reason.includes('collision') || reason.includes('exists')).toBe(
      true,
    );
  });

  it('happy path emits one planned intent per gap, writes nothing', () => {
    const before = readdirSync(tmp);
    const gaps = [finding('src/foo.py', 'foo'), finding('src/bar.py', 'bar')];
    const results = planAuthoring(gaps, okCtx());
    expect(results.map((r) => r.status)).toEqual(['planned', 'planned']);
    for (const r of results) {
      expect(r.requirement.trim()).not.toBe('');
      expect(r.target_path.trim()).not.toBe('');
      expect(r.skip_reason).toBeNull();
    }
    expect(readdirSync(tmp)).toEqual(before);
  });

  it('target test path mirrors peer layout by language', () => {
    expect(targetTestPath(finding('src/foo.py', 'foo'))).toBe(
      'src/test_foo.py',
    );
    expect(targetTestPath(finding('src/foo.ts', 'foo'))).toBe(
      'src/foo.test.ts',
    );
    expect(targetTestPath(finding('foo.py', 'foo'))).toBe('test_foo.py');
    expect(targetTestPath(finding('src/data.bin', 'x'))).toBe(
      'src/data.test.bin',
    );
  });
});

describe('author tests (T5 / SC-6)', () => {
  function okCtx(): AuthoringContext {
    return new AuthoringContext(true, 2, { repo_root: tmp });
  }

  it('fake invoker authors planned, preserves skipped', () => {
    const authorable = finding('src/foo.py', 'foo');
    const colliding = finding('src/bar.py', 'bar');
    const target = join(tmp, targetTestPath(colliding));
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(target, '# owned by another PR\n', 'utf-8');

    const invoker = new FakeInvoker();
    const tier = new InSessionAgentTier({ invoker });
    const results = tier.author_tests([authorable, colliding], okCtx());

    const byPath = new Map(results.map((r) => [r.gap.path, r]));
    expect(byPath.get('src/foo.py')!.status).toBe('authored');
    expect(byPath.get('src/foo.py')!.written_path).toBe(
      targetTestPath(authorable),
    );
    expect(byPath.get('src/bar.py')!.status).toBe('skipped');
    expect(invoker.authorCalls.length).toBe(1);
    expect(invoker.authorCalls[0]!.gap.path).toBe('src/foo.py');
  });

  it('default recording invoker authors nothing', () => {
    const tier = new InSessionAgentTier();
    const results = tier.author_tests([finding()], okCtx());
    expect(results.map((r) => r.status)).toEqual(['planned']);
    expect(results[0]!.written_path).toBeNull();
  });

  it('no ctx -> fail-closed default skips everything', () => {
    // Absent ctx: opt-in off, tier 0 -> everything skipped.
    const results = new InSessionAgentTier().author_tests([finding()]);
    expect(results[0]!.status).toBe('skipped');
  });
});

describe('decide block (T5 / D4)', () => {
  function authored(): GeneratedTest {
    return new GeneratedTest({
      gap: finding(),
      target_path: 'tests/test_foo.py',
      requirement: 'r',
      status: 'authored',
      written_path: 'tests/test_foo.py',
    });
  }
  function skipped(): GeneratedTest {
    return new GeneratedTest({
      gap: finding(),
      target_path: 'tests/test_foo.py',
      requirement: 'r',
      status: 'skipped',
      skip_reason: 'fork: read-only',
    });
  }
  function planned(): GeneratedTest {
    return new GeneratedTest({
      gap: finding(),
      target_path: 'tests/test_foo.py',
      requirement: 'r',
    });
  }

  it('blocks once when tests authored', () => {
    const d = decideBlock([authored(), authored()]);
    expect(d.block).toBe(true);
    expect(d.authored_count).toBe(2);
    expect(d.message).toContain('authored & staged');
    expect(d.message).toContain('re-commit');
  });

  it('blocks on planned actionable intents', () => {
    const d = decideBlock([planned(), planned()]);
    expect(d.block).toBe(true);
    expect(d.authored_count).toBe(2);
    expect(d.message).toContain('review');
    expect(d.message).toContain('re-commit');
  });

  it('blocks on planned plus skipped, counts actionable only', () => {
    const d = decideBlock([planned(), skipped()]);
    expect(d.block).toBe(true);
    expect(d.authored_count).toBe(1);
  });

  it('does not block on all skipped', () => {
    const d = decideBlock([skipped(), skipped()]);
    expect(d.block).toBe(false);
    expect(d.authored_count).toBe(0);
  });

  it('blocks on mixed, counting only actionable', () => {
    const d = decideBlock([authored(), skipped()]);
    expect(d.block).toBe(true);
    expect(d.authored_count).toBe(1);
  });
});
