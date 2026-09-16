/**
 * Seeded PRNG for emit-time generation (#765 D4). Values are baked into the
 * emitted file as literals, so the test itself never touches a PRNG.
 */
export const DEFAULT_SEED = 765;

/** mulberry32: small, well-known 32-bit generator; returns [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SeedResult =
  { ok: true; seed: number } | { ok: false; reason: string };

/** Mirrors savant's `--seed`: non-integer or unsafe integer is a usage error. */
export function parseSeed(raw: string | undefined): SeedResult {
  if (raw === undefined) return { ok: true, seed: DEFAULT_SEED };
  const n = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(n)
    ? { ok: true, seed: n }
    : {
        ok: false,
        reason: `--seed must be a safe integer, got ${JSON.stringify(raw)}`,
      };
}
