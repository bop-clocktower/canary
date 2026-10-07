// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { CanaryPanel, el } from '../lib/site-kit/panel.js';
import { live, mount, runRecord, siteFeed } from './site-kit-helpers.js';

class Probe extends CanaryPanel {
  get heading() {
    return 'Probe';
  }
  build(doc: { runs: unknown[] }) {
    return doc.runs.length
      ? {
          nodes: [el('p', { 'data-n': String(doc.runs.length) }, 'ok')],
          abstentions: [],
        }
      : { nodes: [], abstentions: ['Nothing ran.'] };
  }
}

describe('CanaryPanel (#1151 phase 3)', () => {
  it('says so before any feed arrives', () => {
    const root = mount(Probe);
    expect(live(root)).toBe('No feed loaded yet.');
  });

  it('renders the heading and the built nodes', () => {
    const root = mount(Probe, siteFeed({ runs: [runRecord()] }));
    expect(root.querySelector('h2')!.textContent).toBe('Probe');
    expect(root.querySelector('[data-n="1"]')).not.toBeNull();
    expect(live(root)).toBe('');
  });

  it('puts an abstention as text in a polite status region (criterion 11)', () => {
    const root = mount(Probe, siteFeed());
    const region = root.querySelector('[aria-live]')!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('Nothing ran.');
  });

  it('keeps one live region node across renders, so changes are announced', () => {
    const root = mount(Probe, siteFeed());
    const before = root.querySelector('[aria-live]');
    (root.host as HTMLElement & { feed: unknown }).feed = siteFeed({
      runs: [runRecord()],
    });
    expect(root.querySelector('[aria-live]')).toBe(before);
  });

  it('refuse() drops the content and announces why', () => {
    const root = mount(Probe, siteFeed({ runs: [runRecord()] }));
    (root.host as unknown as CanaryPanel).refuse('Feed refused.');
    expect(root.querySelector('[data-n]')).toBeNull();
    expect(live(root)).toBe('Feed refused.');
  });

  it('el() sets attributes and skips null children', () => {
    const node = el(
      'li',
      { 'data-state': 'dark' },
      'a',
      null,
      el('b', {}, 'c'),
    );
    expect(node.getAttribute('data-state')).toBe('dark');
    expect(node.textContent).toBe('ac');
  });

  it('styles through one shared constructed sheet (no <style>, CSP-safe)', () => {
    const a = mount(Probe, siteFeed());
    const b = mount(Probe, siteFeed());
    expect(a.adoptedStyleSheets).toHaveLength(1);
    expect(a.adoptedStyleSheets[0]).toBe(b.adoptedStyleSheets[0]);
    expect(a.querySelector('style')).toBeNull();
  });

  it('never takes the live region out of the accessibility tree when empty', () => {
    // display:none on an empty status region means a later abstention
    // un-hides and fills it in one step, which several screen readers do not
    // announce. Collapsing it is fine; removing it is not.
    const sheet = mount(Probe, siteFeed()).adoptedStyleSheets[0];
    const rules = [...sheet.cssRules].map((r) => r.cssText);
    const hides = rules.filter(
      (r) =>
        /\.abstain/.test(r) && /display:\s*none|visibility:\s*hidden/.test(r),
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(hides).toEqual([]);
  });

  it('wraps the body in a card unless the panel lays out its own cards', () => {
    const plain = class extends Probe {
      get bodyClass() {
        return '';
      }
    };
    const body = (root: ShadowRoot) =>
      root.querySelector('[part="body"]')!.getAttribute('class');
    expect(body(mount(Probe, siteFeed()))).toBe('card');
    expect(body(mount(plain, siteFeed()))).toBe('');
  });
});
