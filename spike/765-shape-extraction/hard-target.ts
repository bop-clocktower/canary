/**
 * Throwaway spike fixture for #765 D2 -- question 3. NOT engine code.
 *
 * `ts/src/core` contains no mapped or conditional types at the base commit of
 * this spike (verified by grep, recorded in SPIKE_REPORT.md), so the "genuinely
 * hard" target the spike had to probe does not exist in real canary code. This
 * file supplies the constructs synthetically so the extractor's abstention
 * behaviour is measured rather than assumed.
 *
 * Nothing under ts/ imports this file; it is never compiled by ts/tsconfig.json
 * (which includes `src` only).
 */

export interface Base {
  id: string;
  count: number;
  tags: string[];
}

/** Mapped type. */
export type Flags<T> = { [K in keyof T]: boolean };

/** Conditional type. */
export type Unwrap<T> = T extends Array<infer U> ? U : T;

/** Index signature: field names are not statically knowable. */
export type Bag = Record<string, unknown>;

/** Template literal type. */
export type EventName = `on${Capitalize<'click' | 'focus'>}`;

/** Intersection. */
export type Merged = Base & { extra: boolean };

export function hardMapped(flags: Flags<Base>): void {
  void flags;
}

export function hardConditional(value: Unwrap<string[]>): void {
  void value;
}

export function hardIndexed(bag: Bag): void {
  void bag;
}

export function hardTemplate(name: EventName): void {
  void name;
}

export function hardIntersection(m: Merged): void {
  void m;
}

export function hardAny(a: any, u: unknown, fn: (x: number) => string): void {
  void a;
  void u;
  void fn;
}
