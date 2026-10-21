// Ingest reporter: the per-test entry shapes, in a leaf module.
//
// `redact.ts` needs these to type its inputs and `payload.ts` calls into
// `redact.ts`, so declaring them in `payload.ts` made a type-only import cycle
// that harness 13's arch gate counts (`circular-deps`). `payload.ts`
// re-exports both, so every existing importer is unchanged.

export interface ResultEntry {
  full_title: string;
  test_file: string;
  status: string;
  duration_ms?: number;
  error_message?: string;
  error_stack?: string;
  retries: number;
  tags: string[];
  area?: string;
}

/** One test the run collected, whether or not it ran (the suite's denominator). */
export interface CollectedEntry {
  full_title: string;
  test_file: string;
  tags: string[];
  area?: string;
}
