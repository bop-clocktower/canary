// Input for the real-instrumenter count in guardian-mutation-run.test.ts.
// Line 3 carries mutants; line 4 is a bare string (StringLiteral is excluded).
export const gate = (force: boolean, n: number): boolean => force && n > 1;
export const label = 'unchanged';
