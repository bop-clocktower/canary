/**
 * Python-compatible numeric rounding, shared by the history store (rate
 * computation) and the report builders (display formatting).
 */

/** Python-compatible round-half-to-even at 1 decimal place. */
export function round1(x: number): number {
  const scaled = x * 10;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const eps = 1e-9;
  let rounded: number;
  if (Math.abs(diff - 0.5) < eps) {
    // Exact .5 tie → round to even.
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / 10;
}

/** Render a 1-decimal-rounded number the way Python's `str(float)` would. */
export function num1(x: number): string {
  return round1(x).toFixed(1);
}

/** Python-compatible `round(x)` to the nearest integer, half-to-even. */
export function roundHalfEvenInt(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  const eps = 1e-9;
  if (Math.abs(diff - 0.5) < eps) {
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(x);
}

/**
 * Render a float the way Python's `str(float)` would: an integer-valued float
 * keeps a trailing ".0" (Python `str(10.0)` → "10.0", whereas JS `${10.0}`
 * yields "10"). Used for threshold parameters interpolated raw into headers.
 */
export function pyFloat(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : `${x}`;
}
