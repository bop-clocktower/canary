/**
 * canary-judomaster data model (#614): a pasted stack trace, its frames
 * resolved to files in this repository, and the regression brief built from
 * them. Frames are always ordered innermost first, whatever order the source
 * format printed them in.
 */

export type TraceFormat = 'v8' | 'python';

export interface RawFrame {
  file: string;
  line: number;
  column?: number;
  fn?: string;
}

export interface ParsedTrace {
  format: TraceFormat;
  errorType: string;
  message: string;
  frames: RawFrame[];
} // innermost first

export type FrameStatus = 'resolved' | 'stale' | 'external' | 'missing';

export interface ResolvedFrame extends RawFrame {
  status: FrameStatus;
  path?: string;
  excerpt?: string[];
}

export interface RegressionBrief {
  schema: 'canary-judomaster-brief/1';
  format: TraceFormat;
  errorType: string;
  message: string;
  signature: { text: string; kind: 'message' | 'type-only' };
  suspect: ResolvedFrame | null; // innermost resolved/stale frame
  frames: ResolvedFrame[];
  framework: string;
  outputPath: string; // tests/generated/regression/<slug>.<ext>
  requirement: string; // the /canary-write-test prompt
}

export type VerifyVerdict =
  'reproduced' | 'not-reproduced' | 'failed-other-reason' | 'unverified';
