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

/**
 * One cause in an exception chain (#1138). `start` indexes the flat,
 * innermost-first `frames` list where this error's frames begin.
 */
export interface ChainLink {
  errorType: string;
  message: string;
  relation: 'cause' | 'context';
  start: number;
}

export interface ParsedTrace {
  format: TraceFormat;
  errorType: string;
  message: string;
  frames: RawFrame[];
  /** Outward-in: [0] caused the reported error, the last is the root cause. Absent when unchained. */
  chain?: ChainLink[];
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
  signature: {
    text: string;
    kind: 'message' | 'type-only';
    /** Error type the signature must sit on; absent for a bare `--expect`. */
    type?: string;
  };
  suspect: ResolvedFrame | null; // innermost resolved/stale frame
  frames: ResolvedFrame[];
  chain?: (ChainLink & { suspect: ResolvedFrame | null })[];
  framework: string;
  outputPath: string; // tests/generated/regression/<slug>.<ext>
  requirement: string; // the /canary-write-test prompt
}

export type VerifyVerdict =
  'reproduced' | 'not-reproduced' | 'failed-other-reason' | 'unverified';
