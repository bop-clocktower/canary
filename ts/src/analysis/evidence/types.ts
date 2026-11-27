/** Shapes of the audit evidence pack (#855). The pack counts evidence and never grades it. */

export type SourceId = 'batwoman' | 'katana' | 'history' | 'ci-ready';

export interface EvidenceItem {
  source: SourceId;
  at: string;
  summary: string;
  ref: {
    kind: 'commit' | 'run' | 'ledger-entry';
    id: string;
    commit?: string;
    url?: string;
  };
}

export interface SourceReport {
  id: SourceId;
  path: string;
  state: 'read' | 'partial' | 'absent' | 'unreadable' | 'out-of-window';
  reason?: string;
  read: number;
  inWindow: number;
  undated: number;
  items: EvidenceItem[];
}

/** One export: the half-open window `[since, until)`, where it reads and writes, and when and at which commit it ran. */
export interface Scope {
  since: string;
  until: string;
  root: string;
  out?: string | undefined;
  at: string;
  commit: string | null;
  repo?: string | undefined;
  batwoman?: string | undefined;
}

/** What the command prints and exits with: stdout on 0, stderr otherwise. */
export type Outcome = { exit: 0 | 1 | 2; lines: string[] };

export interface CatalogueRow {
  id: string;
  framework: string;
  reference: string;
  supports: string;
  sources: SourceId[];
}

export interface EvidencePack {
  schema: 'canary-evidence-pack/1';
  disclaimer: string;
  generated_at: string;
  window: { since: string; until: string };
  commit: string | null;
  sources: Omit<SourceReport, 'items'>[];
  controls: (CatalogueRow & {
    status: 'evidence' | 'no-evidence';
    items: number;
  })[];
  items: (EvidenceItem & { controls: string[] })[];
}
