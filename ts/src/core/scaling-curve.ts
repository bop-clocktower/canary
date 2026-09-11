/**
 * Scaling-curve probe (#856): how does cost grow as input grows?
 *
 * Fits the log-log slope of a cost metric against input size. A fixed-size load
 * test cannot see an O(n·m) matcher; the exponent can, before the surge does.
 *
 * Pure: points in, verdict out. The Phase 2 runner only produces points, so it
 * can never disagree with the abstention rules here.
 *
 * Every abstention rule is a way "linear ✓" could be printed off data that does
 * not support it (ADR 0009): too few sizes, too narrow a span, noisy samples,
 * or a curve the power law does not fit.
 */

export interface Point {
  size: number;
  value: number;
}

export interface MedianPoint extends Point {
  samples: number;
}

export type ScalingVerdict =
  'LINEAR_OR_BETTER' | 'SUPERLINEAR' | 'STRONGLY_SUPERLINEAR';

export type ScalingResult =
  | {
      verdict: ScalingVerdict;
      exponent: number;
      r2: number;
      knee: number | null;
      points: MedianPoint[];
      extrapolation?: {
        size: number;
        value: number;
        multipleOfLargest: number;
      };
    }
  | { verdict: 'INSUFFICIENT_DATA'; reasons: string[]; points: MedianPoint[] };

const MIN_SIZES = 4;
const MIN_SPAN = 8;
const MAX_CV = 0.25;
const MIN_R2 = 0.9;
const KNEE_DELTA = 0.5;
const LINEAR_MAX = 1.15;
const SUPERLINEAR_MAX = 1.6;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function cv(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
  return sd / mean;
}

/** Least-squares slope, intercept and R² of y on x. */
function fit(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  const b = sxy / sxx;
  // A perfectly flat curve is a perfect (b = 0) fit, not a 0/0.
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { b, a: my - b * mx, r2 };
}

export function fitScaling(
  raw: Point[],
  opts: { target?: number } = {},
): ScalingResult {
  const reasons: string[] = [];
  const bad = raw.filter(
    (p) =>
      !(Number.isFinite(p.size) && p.size > 0) ||
      !(Number.isFinite(p.value) && p.value > 0),
  );
  if (bad.length > 0) {
    reasons.push(
      `${bad.length} point(s) with a size or value that is not a positive finite number`,
    );
  }
  const good = raw.filter((p) => !bad.includes(p));

  const bySize = new Map<number, number[]>();
  for (const p of good) {
    const vs = bySize.get(p.size);
    if (vs) vs.push(p.value);
    else bySize.set(p.size, [p.value]);
  }
  const points: MedianPoint[] = [...bySize]
    .sort(([a], [b]) => a - b)
    .map(([size, vs]) => ({ size, value: median(vs), samples: vs.length }));

  if (points.length < MIN_SIZES) {
    reasons.push(
      `${points.length} distinct size(s); need at least ${MIN_SIZES} distinct sizes`,
    );
  } else {
    const span = points.at(-1)!.size / points[0]!.size;
    if (span < MIN_SPAN) {
      reasons.push(
        `size span is ${span.toFixed(1)}x; need at least ${MIN_SPAN}x`,
      );
    }
  }
  for (const [size, vs] of bySize) {
    if (vs.length >= 3 && cv(vs) > MAX_CV) {
      reasons.push(
        `size ${size} is noisy: coefficient of variation ${cv(vs).toFixed(2)} > ${MAX_CV}`,
      );
    }
  }

  let result: ReturnType<typeof fit> | null = null;
  if (points.length >= 2) {
    result = fit(
      points.map((p) => Math.log(p.size)),
      points.map((p) => Math.log(p.value)),
    );
    if (result.r2 < MIN_R2) {
      reasons.push(
        `power-law fit R² ${result.r2.toFixed(2)} < ${MIN_R2}: the curve is not one exponent`,
      );
    }
  }

  if (reasons.length > 0 || result === null) {
    return { verdict: 'INSUFFICIENT_DATA', reasons, points };
  }

  const slopes = points
    .slice(1)
    .map(
      (p, i) =>
        Math.log(p.value / points[i]!.value) /
        Math.log(p.size / points[i]!.size),
    );
  const kneeAt = slopes.findIndex((s) => s >= slopes[0]! + KNEE_DELTA);

  const verdict: ScalingVerdict =
    result.b <= LINEAR_MAX
      ? 'LINEAR_OR_BETTER'
      : result.b <= SUPERLINEAR_MAX
        ? 'SUPERLINEAR'
        : 'STRONGLY_SUPERLINEAR';

  const out: ScalingResult = {
    verdict,
    exponent: result.b,
    r2: result.r2,
    knee: kneeAt === -1 ? null : points[kneeAt]!.size,
    points,
  };
  if (opts.target !== undefined) {
    out.extrapolation = {
      size: opts.target,
      value: Math.exp(result.a + result.b * Math.log(opts.target)),
      multipleOfLargest: opts.target / points.at(-1)!.size,
    };
  }
  return out;
}

/** Read `{metric, points}` JSON or a `size,value` CSV. Unreadable input throws. */
export function parsePoints(text: string): {
  metric?: string;
  points: Point[];
} {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const j = JSON.parse(trimmed) as { metric?: string; points?: Point[] };
    if (!Array.isArray(j.points)) {
      throw new Error('JSON input needs a "points" array of {size, value}');
    }
    return j.metric === undefined
      ? { points: j.points }
      : { metric: j.metric, points: j.points };
  }
  const [header, ...rows] = trimmed.split(/\r?\n/);
  if (header?.replace(/\s/g, '').toLowerCase() !== 'size,value') {
    throw new Error(
      'expected JSON {"points": [...]} or CSV with a size,value header',
    );
  }
  return {
    points: rows
      .filter((r) => r.trim())
      .map((r) => {
        const [size, value] = r.split(',').map(Number);
        return { size: size!, value: value! };
      }),
  };
}
