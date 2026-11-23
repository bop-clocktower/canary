// Ingest reporter: the glob rules `areaMap` and `featureMap` share, in a leaf
// module so config.ts and features.ts both read one definition.

/** Only `**`, `*` and `?` are glob syntax here; `{a,b}` and `[ab]` would match as literal text. */
export function checkGlobs<T>(
  name: string,
  map: Record<string, T>,
  warnings: string[],
): Record<string, T> {
  for (const glob of Object.keys(map)) {
    if (/[{}[\]]/.test(glob)) {
      warnings.push(
        `${name} glob "${glob}" uses unsupported {a,b} or [ab] syntax and matches only literally; list each path instead.`,
      );
    }
  }
  return map;
}

/** `**` crosses directories, `*` and `?` stay within one path segment. */
const GLOB_TOKENS: Record<string, string> = {
  '**/': '(?:.*/)?',
  '**': '.*',
  '*': '[^/]*',
  '?': '[^/]',
};

export function globToRegExp(glob: string): RegExp {
  const re = glob.replace(
    /\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g,
    (t) => GLOB_TOKENS[t] ?? `\\${t}`,
  );
  return new RegExp(`^${re}$`);
}
