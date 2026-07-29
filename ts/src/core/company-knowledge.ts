/**
 * CompanyKnowledge -- load and validate `.canary/company.json`.
 *
 * Faithful TypeScript port of `agent/core/company_knowledge.py`. Stores
 * *pointers only* (Confluence space keys, Jira project keys, internal URLs, MCP
 * server identifiers, Claude Code skill slugs, free-text notes). No proprietary
 * content is ever committed here; AI agents retrieve actual content at runtime
 * via configured MCP servers or authenticated tooling.
 *
 * ## Merge cascade (lowest -> highest priority)
 *
 *   1. ~/.canary/company.json          -- org-wide defaults
 *   2. .canary/company.json            -- project-local config
 *   3. .canary/company.<env>.json      -- environment override (CANARY_ENV or explicit)
 *
 * List fields are unioned across sources; scalar fields (dashboard_url,
 * dashboard_token_env, notes) are replaced by the highest-priority source that
 * sets them.
 *
 * Python->TS nuances:
 *   - Python patches `Path.home()` in its tests to isolate the home tier. There
 *     is no global monkeypatch in JS, so `load` takes an injectable `home`
 *     argument (defaults to `os.homedir()`), mirroring the `home?` seam the
 *     skill-registry / overlays ports added.
 *   - `re.match` is anchored at string start; JS `RegExp.test` is not, so every
 *     ported `^`-anchored `_match`-style check keeps its explicit `^`. The one
 *     `re.IGNORECASE` secret-prefix regex maps to the `i` flag. None of the
 *     regexes here use `re.MULTILINE`, so no `^`/`$` anchor-trap applies -- the
 *     fence-stripper `_FENCE_RE` uses `re.DOTALL` (`[^`]*` already spans
 *     newlines identically in JS, so no `s` flag is needed).
 *   - Notes are capped by CODE POINT (`str[:2048]`) and the brand-text cap by
 *     code point (`str[:200]`), so both use a code-point slice helper rather
 *     than a UTF-16 `.slice`.
 *   - Python truthiness (`""`/`None`/`{}`/`[]` falsy) via {@link pyTruthy}.
 *   - `type(x).__name__` in warning text maps to {@link pyTypeName} so a
 *     non-list / non-string / non-dict value is named `str`/`list`/`dict`/...
 *     exactly as Python renders it.
 *   - `_warn` printed rich-markup to stderr; this port keeps the warning strings
 *     (they are asserted) but does not re-emit them to stderr, matching how the
 *     other ports drop Python's `rich` console side effects.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { readJsonWithWarning } from './config-validation.js';

// ---------------------------------------------------------------------------
// Python-compatibility helpers (copied locally per-module, matching reporter.ts)
// ---------------------------------------------------------------------------

/**
 * Python-truthiness: `null`/`undefined`/`false`/`0`/`""` and an empty array or
 * object are falsy (mirrors `if x:`).
 */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `type(x).__name__` for JSON-derived values. */
function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number')
    return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  return 'dict';
}

/** `str[:n]` by code point (Python slices by code point, JS `.slice` by UTF-16). */
function codePointSlice(s: string, n: number): string {
  return [...s].slice(0, n).join('');
}

// em-dash (U+2014) kept out of the source text as an escape, emitted verbatim.
const EMDASH = '\u{2014}';

// ---------------------------------------------------------------------------
// secret heuristic
// ---------------------------------------------------------------------------

const _SECRET_PREFIX = /^(sk-|api[_-]?key|token|secret|bearer)/i;
const _MAX_NON_NOTES_LEN = 128;

function looksLikeSecret(value: string): boolean {
  // Python `len(value)` counts code points; use the spread length to match.
  return _SECRET_PREFIX.test(value) || [...value].length > _MAX_NON_NOTES_LEN;
}

// ---------------------------------------------------------------------------
// field validators
// ---------------------------------------------------------------------------

const _SPACE_OR_PROJECT_RE = /^[A-Z0-9]{1,32}$/;
const _DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const _MCP_SERVER_RE = /^[A-Za-z0-9_-]+$/;
const _SKILL_RE = /^[a-z0-9][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)?$/;
const _ENV_VAR_RE = /^[A-Z][A-Z0-9_]*$/;
const _NOTES_MAX = 2048;
const _FENCE_RE = /```[^`]*```/g;

const _KNOWN_KEYS = new Set([
  'confluence_spaces',
  'jira_projects',
  'internal_doc_urls',
  'internal_domains',
  'mcp_servers',
  'claude_code_skills',
  'dashboard_url',
  'dashboard_token_env',
  'otel_exporter_endpoint',
  'notes',
  'brand',
  // #459: read by the migrator (`_detectFramework` / overlay `deploy_to`
  // matching) to decide which overlay skills deploy. It is NOT parsed into a
  // `CompanyKnowledge` field, but it is emphatically not "ignored" either --
  // warning that it is told anyone adopting an overlay that the single field
  // driving their adoption does nothing.
  'canary_shape',
  // #459: repo-relative pointers a generated workflow interpolates (the
  // coverage report the guardian reads; the controllers dir it scopes SUT
  // analysis to). See `validateRepoRelativePath` for why they are validated
  // rather than stored verbatim.
  'coverage_report_path',
  'sut_controllers_path',
]);

const _HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const _BRAND_TEXT_MAX = 200;

/** Raised (as an exception) when a secret-like value is detected. */
class SecretDetected extends Error {
  readonly fieldName: string;
  readonly value: string;
  constructor(fieldName: string, value: string) {
    super(`secret-like value in '${fieldName}'`);
    this.fieldName = fieldName;
    this.value = value;
  }
}

/**
 * Parse a URL the way Python's `urllib.parse.urlparse` exposes `scheme` and
 * `netloc`. The stdlib parser is permissive (no host validation); we only need
 * the scheme and whether a network location is present, matching the two checks
 * the Python performs (`scheme in (...)` and `not netloc`).
 */
function parseSchemeNetloc(raw: string): { scheme: string; netloc: string } {
  // urlsplit: scheme is the run of `[a-zA-Z][a-zA-Z0-9+.-]*` before the first
  // ":" -- but only when what follows begins "//", or the remainder is a valid
  // scheme form. urllib is lenient; for the schemes we accept (http/https/grpc/
  // grpcs) the "://" form is what real endpoints use. Mirror urlparse closely
  // enough for the validators: split scheme at the first ":", then netloc is the
  // authority between "//" and the next "/", "?" or "#".
  // Python's urlsplit strips leading C0-control/space bytes and removes any
  // \t\r\n throughout BEFORE parsing, so " http://x.com" is a valid http URL.
  // Mirror that front-strip so a value with accidental leading whitespace is
  // accepted (not dropped) the same as the oracle.
  const cleaned = raw.replace(/[\t\r\n]/g, '').replace(/^[\x00-\x20]+/, '');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s.exec(cleaned);
  let scheme = '';
  let rest = cleaned;
  if (m) {
    scheme = m[1]!.toLowerCase();
    rest = m[2]!;
  }
  let netloc = '';
  if (rest.startsWith('//')) {
    const after = rest.slice(2);
    const end = after.search(/[/?#]/);
    netloc = end === -1 ? after : after.slice(0, end);
  } else if (!m) {
    // No scheme parsed at all -> urlparse would leave scheme empty and netloc
    // empty (the whole thing is a path).
    scheme = '';
  }
  return { scheme, netloc };
}

type Warnings = string[];

function validateStrings(
  raw: unknown,
  fieldName: string,
  validate: (v: string) => boolean,
  transform: ((v: string) => string) | null,
  warnings: Warnings | null,
): string[] {
  if (!Array.isArray(raw)) {
    if (warnings !== null) {
      warnings.push(
        `${fieldName}: expected list, got ${pyTypeName(raw)} ${EMDASH} skipped`,
      );
    }
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const val = transform ? transform(item) : item;
    if (looksLikeSecret(val)) throw new SecretDetected(fieldName, val);
    if (!validate(val)) {
      if (warnings !== null) {
        warnings.push(`${fieldName}: dropped invalid entry ${pyRepr(item)}`);
      }
      continue;
    }
    if (!seen.has(val)) {
      seen.add(val);
      out.push(val);
    }
  }
  return out;
}

/** Python `repr()` of a string: single-quoted, with `'`/`\` escaped. */
function pyRepr(s: string): string {
  // Python prefers single quotes unless the string contains a single quote and
  // no double quote (then it uses double quotes). Matches the common case used
  // in these warnings (identifiers, URLs -- no embedded quotes).
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  if (hasSingle && !hasDouble) {
    return `"${s.replace(/\\/g, '\\\\')}"`;
  }
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function validateUrl(
  raw: unknown,
  fieldName: string,
  warnings: Warnings,
): string {
  if (typeof raw !== 'string') {
    warnings.push(
      `${fieldName}: expected string, got ${pyTypeName(raw)} ${EMDASH} skipped`,
    );
    return '';
  }
  if (looksLikeSecret(raw)) throw new SecretDetected(fieldName, raw);
  const { scheme, netloc } = parseSchemeNetloc(raw);
  if ((scheme !== 'http' && scheme !== 'https') || !netloc) {
    warnings.push(`${fieldName}: dropped invalid URL ${pyRepr(raw)}`);
    return '';
  }
  return raw;
}

const _OTEL_SCHEMES = ['http', 'https', 'grpc', 'grpcs'];

function validateOtelEndpoint(
  raw: unknown,
  fieldName: string,
  warnings: Warnings,
): string {
  if (typeof raw !== 'string') {
    warnings.push(
      `${fieldName}: expected string, got ${pyTypeName(raw)} ${EMDASH} skipped`,
    );
    return '';
  }
  if (!raw.trim()) return '';
  if (looksLikeSecret(raw)) throw new SecretDetected(fieldName, raw);
  const { scheme, netloc } = parseSchemeNetloc(raw);
  if (!_OTEL_SCHEMES.includes(scheme) || !netloc) {
    warnings.push(`${fieldName}: dropped invalid endpoint ${pyRepr(raw)}`);
    return '';
  }
  return raw;
}

// A path that is absolute in any flavour git checkouts run under: POSIX
// (`/x`), UNC / Windows-separator (`\x`), or drive-qualified (`C:x`, `C:/x`).
// Drive-relative `C:x` is included deliberately -- it is not repo-relative.
const _ABSOLUTE_PATH_RE = /^(?:[/\\]|[A-Za-z]:)/;
// Newlines would break out of the scalar these values are interpolated into
// when a workflow template is generated, so they are refused outright rather
// than escaped -- no legitimate repo path contains one.
const _PATH_CONTROL_RE = /[\r\n\t\0]/;

/**
 * A repo-relative path pointer (#459: `coverage_report_path`,
 * `sut_controllers_path`).
 *
 * These are interpolated into generated GitHub Actions YAML, so validation is
 * a safety boundary, not tidiness: an absolute path aims the generated CI at
 * something outside the checkout, and a `..` segment escapes the repo. Both are
 * dropped with a warning (the module's degrade-never-throw convention); a
 * secret-like value raises so the whole layer is refused, exactly as every
 * other non-notes field does.
 *
 * `..` is rejected as a SUBSTRING, not just as a path component. A component
 * check would have to agree with the separator handling of whatever consumes
 * the value later (shell, Actions expression, node `path`); refusing the two
 * characters outright cannot disagree with anything. The cost is rejecting the
 * vanishingly rare legitimate `report..xml`.
 */
function validateRepoRelativePath(
  raw: unknown,
  fieldName: string,
  warnings: Warnings,
): string {
  if (typeof raw !== 'string') {
    warnings.push(
      `${fieldName}: expected string, got ${pyTypeName(raw)} ${EMDASH} skipped`,
    );
    return '';
  }
  const value = raw.trim();
  if (!value) return '';
  if (looksLikeSecret(value)) throw new SecretDetected(fieldName, value);
  if (
    _ABSOLUTE_PATH_RE.test(value) ||
    value.includes('..') ||
    _PATH_CONTROL_RE.test(value)
  ) {
    warnings.push(
      `${fieldName}: dropped invalid repo-relative path ${pyRepr(raw)} ` +
        `${EMDASH} must stay inside the repo (no absolute path, no '..')`,
    );
    return '';
  }
  return value;
}

/** Accept #RGB / #RRGGBB (any case); drop anything else with a warning. */
function validateHexColor(
  raw: unknown,
  fieldName: string,
  warnings: Warnings,
): string {
  if (typeof raw !== 'string' || !raw) return '';
  if (_HEX_COLOR_RE.test(raw)) return raw;
  warnings.push(`${fieldName}: dropped invalid hex color ${pyRepr(raw)}`);
  return '';
}

/** A short free-text brand field. Rejects secret-prefixed values; caps length. */
function brandText(
  raw: unknown,
  fieldName: string,
  warnings: Warnings,
): string {
  if (typeof raw !== 'string') {
    if (raw !== null && raw !== undefined) {
      warnings.push(
        `${fieldName}: expected string, got ${pyTypeName(raw)} ${EMDASH} skipped`,
      );
    }
    return '';
  }
  if (_SECRET_PREFIX.test(raw)) throw new SecretDetected(fieldName, raw);
  return codePointSlice(raw.trim(), _BRAND_TEXT_MAX);
}

// ---------------------------------------------------------------------------
// brand assets (customer-facing report theming, #340c)
// ---------------------------------------------------------------------------

const _BRAND_COLOR_KEYS = new Set([
  'primary_color',
  'secondary_color',
  'text_color',
  'background_color',
  'badge_label_color',
  'badge_accent',
]);
const _BRAND_TEXT_KEYS = new Set(['company_name', 'footer_note', 'logo_path']);

/**
 * Brand assets a customer-facing report generator may consult (Python: `Brand`).
 *
 * An **open** map, not a fixed record: recognized keys are validated/typed and
 * any other key is passed through. Pointers/styling only -- colors, logo
 * paths/URLs, text -- never binary assets or secrets.
 */
export class Brand {
  assets: Record<string, unknown>;

  constructor(assets: Record<string, unknown> = {}) {
    this.assets = assets;
  }

  get isEmpty(): boolean {
    return !pyTruthy(this.assets);
  }

  toDict(): Record<string, unknown> {
    return { ...this.assets };
  }
}

function looksLikeColor(val: string): boolean {
  return val.startsWith('#');
}

function looksLikeUrl(val: string): boolean {
  return val.includes('://');
}

/** A list of hex colors; invalid entries dropped with a warning. */
function cleanAccents(raw: unknown, warnings: Warnings): unknown[] {
  if (!Array.isArray(raw)) {
    warnings.push('brand.accents: expected a list ' + EMDASH + ' skipped');
    return [];
  }
  const out: unknown[] = [];
  raw.forEach((item, i) => {
    const color = validateHexColor(item, `brand.accents[${i}]`, warnings);
    if (color) out.push(color);
  });
  return out;
}

/** A name->path map of logo variants (paths kept as strings). */
function cleanVariants(
  raw: unknown,
  warnings: Warnings,
): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(
      'brand.logo_variants: expected an object ' + EMDASH + ' skipped',
    );
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(raw as Record<string, unknown>)) {
    const text = brandText(path, `brand.logo_variants.${name}`, warnings);
    if (text) out[String(name)] = text;
  }
  return out;
}

/**
 * An unrecognized brand key: validate as a color/URL when it looks like one,
 * else keep the string (secret-rejected, length-capped).
 */
function cleanBrandExtra(
  val: unknown,
  fieldName: string,
  warnings: Warnings,
): unknown {
  if (typeof val !== 'string') {
    warnings.push(`${fieldName}: expected string ${EMDASH} skipped`);
    return '';
  }
  if (looksLikeColor(val)) return validateHexColor(val, fieldName, warnings);
  if (looksLikeUrl(val)) return validateUrl(val, fieldName, warnings);
  return brandText(val, fieldName, warnings);
}

function cleanBrandValue(
  key: string,
  val: unknown,
  warnings: Warnings,
): unknown {
  const fieldName = `brand.${key}`;
  if (_BRAND_COLOR_KEYS.has(key))
    return validateHexColor(val, fieldName, warnings);
  if (key === 'accents') return cleanAccents(val, warnings);
  if (key === 'logo_variants') return cleanVariants(val, warnings);
  if (key === 'logo_url') {
    return typeof val === 'string' ? validateUrl(val, fieldName, warnings) : '';
  }
  if (_BRAND_TEXT_KEYS.has(key)) return brandText(val, fieldName, warnings);
  return cleanBrandExtra(val, fieldName, warnings);
}

/** Whether a cleaned brand value should be omitted (Python `not in (None,"",[],{})`). */
function omittedBrandValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

function parseBrand(raw: unknown, warnings: Warnings): Brand {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== null && raw !== undefined) {
      warnings.push(
        `brand: expected object, got ${pyTypeName(raw)} ${EMDASH} skipped`,
      );
    }
    return new Brand();
  }
  const assets: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const cleaned = cleanBrandValue(String(key), val, warnings);
    if (!omittedBrandValue(cleaned)) assets[String(key)] = cleaned;
  }
  return new Brand(assets);
}

function mergeBrand(layers: Layer[]): Brand {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) Object.assign(merged, layer.brand.assets);
  return new Brand(merged);
}

// ---------------------------------------------------------------------------
// raw validated layer
// ---------------------------------------------------------------------------

interface Layer {
  confluence_spaces: string[];
  jira_projects: string[];
  internal_doc_urls: string[];
  internal_domains: string[];
  mcp_servers: string[];
  claude_code_skills: string[];
  dashboard_url: string;
  dashboard_token_env: string;
  otel_exporter_endpoint: string;
  coverage_report_path: string;
  sut_controllers_path: string;
  notes: string;
  brand: Brand;
  warnings: string[];
  source: string;
}

/** `dict.get(key, default)`: default only when the key is absent. */
function dictGet(
  data: Record<string, unknown>,
  key: string,
  fallback: unknown,
): unknown {
  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;
}

/** Validate a raw JSON dict into a Layer. Throws SecretDetected on secrets. */
function parseLayer(data: Record<string, unknown>, source: string): Layer {
  const warns: Warnings = [];

  const confluence_spaces = validateStrings(
    dictGet(data, 'confluence_spaces', []),
    'confluence_spaces',
    (v) => _SPACE_OR_PROJECT_RE.test(v),
    (v) => v.toUpperCase(),
    warns,
  );
  const jira_projects = validateStrings(
    dictGet(data, 'jira_projects', []),
    'jira_projects',
    (v) => _SPACE_OR_PROJECT_RE.test(v),
    (v) => v.toUpperCase(),
    warns,
  );

  const rawUrls = dictGet(data, 'internal_doc_urls', []);
  const internal_doc_urls: string[] = [];
  if (Array.isArray(rawUrls)) {
    for (const u of rawUrls) {
      if (typeof u !== 'string') continue;
      const validated = validateUrl(u, 'internal_doc_urls', warns);
      if (validated) internal_doc_urls.push(validated);
    }
  }

  const internal_domains = validateStrings(
    dictGet(data, 'internal_domains', []),
    'internal_domains',
    (v) => _DOMAIN_RE.test(v),
    (v) => v.toLowerCase(),
    warns,
  );
  const mcp_servers = validateStrings(
    dictGet(data, 'mcp_servers', []),
    'mcp_servers',
    (v) => _MCP_SERVER_RE.test(v),
    null,
    warns,
  );
  const claude_code_skills = validateStrings(
    dictGet(data, 'claude_code_skills', []),
    'claude_code_skills',
    (v) => _SKILL_RE.test(v),
    (v) => v.toLowerCase(),
    warns,
  );

  let dashboard_url = '';
  if (Object.prototype.hasOwnProperty.call(data, 'dashboard_url')) {
    dashboard_url = validateUrl(data['dashboard_url'], 'dashboard_url', warns);
  }

  let dashboard_token_env = '';
  if (Object.prototype.hasOwnProperty.call(data, 'dashboard_token_env')) {
    const rawEnv = data['dashboard_token_env'];
    if (typeof rawEnv === 'string') {
      if (looksLikeSecret(rawEnv))
        throw new SecretDetected('dashboard_token_env', rawEnv);
      if (_ENV_VAR_RE.test(rawEnv)) {
        dashboard_token_env = rawEnv;
      } else {
        warns.push(
          `dashboard_token_env: dropped invalid env-var name ${pyRepr(rawEnv)}`,
        );
      }
    }
  }

  let otel_exporter_endpoint = '';
  if (Object.prototype.hasOwnProperty.call(data, 'otel_exporter_endpoint')) {
    otel_exporter_endpoint = validateOtelEndpoint(
      data['otel_exporter_endpoint'],
      'otel_exporter_endpoint',
      warns,
    );
  }

  let coverage_report_path = '';
  if (Object.prototype.hasOwnProperty.call(data, 'coverage_report_path')) {
    coverage_report_path = validateRepoRelativePath(
      data['coverage_report_path'],
      'coverage_report_path',
      warns,
    );
  }

  let sut_controllers_path = '';
  if (Object.prototype.hasOwnProperty.call(data, 'sut_controllers_path')) {
    sut_controllers_path = validateRepoRelativePath(
      data['sut_controllers_path'],
      'sut_controllers_path',
      warns,
    );
  }

  let notes = '';
  if (Object.prototype.hasOwnProperty.call(data, 'notes')) {
    const rawNotes = data['notes'];
    if (typeof rawNotes === 'string') {
      notes = codePointSlice(
        rawNotes.replace(_FENCE_RE, '').trim(),
        _NOTES_MAX,
      );
    }
  }

  const brand = parseBrand(dictGet(data, 'brand', undefined), warns);

  const unknown = [...Object.keys(data)]
    .filter((k) => !_KNOWN_KEYS.has(k))
    .sort();
  for (const k of unknown) warns.push(`ignored unknown field: ${k}`);

  return {
    confluence_spaces,
    jira_projects,
    internal_doc_urls,
    internal_domains,
    mcp_servers,
    claude_code_skills,
    dashboard_url,
    dashboard_token_env,
    otel_exporter_endpoint,
    coverage_report_path,
    sut_controllers_path,
    notes,
    brand,
    warnings: warns,
    source,
  };
}

/** Read and parse one source file. Returns `[layer, errorMsg]`. */
function loadLayer(path: string, label: string): [Layer | null, string] {
  // `read_json_with_warning` distinguishes absent from malformed and never
  // raises; it returns `[data, warning]`. Python read the file directly with
  // `json.loads` and mapped OSError / JSONDecodeError to an error message. We
  // reuse the shared reader: an absent file -> `[null, null]` -> silent skip;
  // a malformed file -> `[null, warning]` -> that warning as the error message.
  const [data, warning] = readJsonWithWarning(path);
  if (data === null) {
    if (warning === null) {
      // read_json_with_warning collapses BOTH an absent file and a file whose
      // content is the bare literal `null` to [null, null]. Python's raw
      // json.loads path distinguishes them: an absent file -> ("") silent skip;
      // a present `null` -> `not isinstance(dict)` -> "expected JSON object at
      // root". Re-derive that split with an existence check.
      if (existsSync(path)) {
        return [null, `${label}: expected JSON object at root`];
      }
      return [null, ''];
    }
    return [null, `${label}: ${warning}`];
  }
  if (Array.isArray(data) || typeof data !== 'object') {
    return [null, `${label}: expected JSON object at root`];
  }
  try {
    return [parseLayer(data as Record<string, unknown>, label), ''];
  } catch (exc) {
    if (exc instanceof SecretDetected) {
      const msg =
        `[red]![/red] ${label} contains a secret-like value in ` +
        `${pyRepr(exc.fieldName)} ${EMDASH} remove it and store secrets in environment variables`;
      return [null, msg];
    }
    throw exc;
  }
}

function union(a: string[], b: string[]): string[] {
  const seen = new Set(a);
  const out = [...a];
  for (const v of b) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

interface MergedFields {
  confluence_spaces: string[];
  jira_projects: string[];
  internal_doc_urls: string[];
  internal_domains: string[];
  mcp_servers: string[];
  claude_code_skills: string[];
  dashboard_url: string;
  dashboard_token_env: string;
  otel_exporter_endpoint: string;
  coverage_report_path: string;
  sut_controllers_path: string;
  notes: string;
  brand: Brand;
  warnings: string[];
  sources: string[];
}

function mergeLayers(layers: Layer[]): MergedFields {
  let confluence_spaces: string[] = [];
  let jira_projects: string[] = [];
  let internal_doc_urls: string[] = [];
  let internal_domains: string[] = [];
  let mcp_servers: string[] = [];
  let claude_code_skills: string[] = [];
  let dashboard_url = '';
  let dashboard_token_env = '';
  let otel_exporter_endpoint = '';
  let coverage_report_path = '';
  let sut_controllers_path = '';
  let notes = '';
  const warns: string[] = [];
  const sources: string[] = [];

  for (const layer of layers) {
    confluence_spaces = union(confluence_spaces, layer.confluence_spaces);
    jira_projects = union(jira_projects, layer.jira_projects);
    internal_doc_urls = union(internal_doc_urls, layer.internal_doc_urls);
    internal_domains = union(internal_domains, layer.internal_domains);
    mcp_servers = union(mcp_servers, layer.mcp_servers);
    claude_code_skills = union(claude_code_skills, layer.claude_code_skills);
    if (layer.dashboard_url) dashboard_url = layer.dashboard_url;
    if (layer.dashboard_token_env)
      dashboard_token_env = layer.dashboard_token_env;
    if (layer.otel_exporter_endpoint)
      otel_exporter_endpoint = layer.otel_exporter_endpoint;
    // Scalar replace-by-highest-priority, same as the fields above: a layer
    // whose value was DROPPED as invalid contributes '' and therefore leaves
    // the lower layer's valid pointer standing (degrade, never blank out).
    if (layer.coverage_report_path)
      coverage_report_path = layer.coverage_report_path;
    if (layer.sut_controllers_path)
      sut_controllers_path = layer.sut_controllers_path;
    if (layer.notes) notes = layer.notes;
    warns.push(...layer.warnings);
    if (layer.source) sources.push(layer.source);
  }

  return {
    confluence_spaces,
    jira_projects,
    internal_doc_urls,
    internal_domains,
    mcp_servers,
    claude_code_skills,
    dashboard_url,
    dashboard_token_env,
    otel_exporter_endpoint,
    coverage_report_path,
    sut_controllers_path,
    notes,
    brand: mergeBrand(layers),
    warnings: warns,
    sources,
  };
}

// ---------------------------------------------------------------------------
// internal helpers (flavor / attribution)
// ---------------------------------------------------------------------------

const _ATTRIBUTION = 'made with Canary';
// Voice is garnish, never load-bearing (#340). One tasteful Oracle line.
const _VOICE_LINE = 'Oracle: eyes on every test.';
const _FLAVOR_OFF_ENV = ['CANARY_NO_FLAVOR', 'NO_FLAVOR'];
const _FALSEY = new Set(['', '0', 'false', 'no', 'off']);

function envTruthy(val: string | undefined): boolean {
  return val !== undefined && !_FALSEY.has(val.trim().toLowerCase());
}

function resolveFlavor(flavor: boolean | null | undefined): boolean {
  if (flavor !== null && flavor !== undefined) return flavor;
  if (_FLAVOR_OFF_ENV.some((v) => envTruthy(process.env[v]))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// public dataclass
// ---------------------------------------------------------------------------

export interface CompanyKnowledgeInit {
  confluence_spaces?: string[];
  jira_projects?: string[];
  internal_doc_urls?: string[];
  internal_domains?: string[];
  mcp_servers?: string[];
  claude_code_skills?: string[];
  dashboard_url?: string;
  dashboard_token_env?: string;
  otel_exporter_endpoint?: string;
  coverage_report_path?: string;
  sut_controllers_path?: string;
  notes?: string;
  brand?: Brand;
  warnings?: string[];
  sources?: string[];
  error?: string;
}

export class CompanyKnowledge {
  confluence_spaces: string[];
  jira_projects: string[];
  internal_doc_urls: string[];
  internal_domains: string[];
  mcp_servers: string[];
  claude_code_skills: string[];
  dashboard_url: string;
  dashboard_token_env: string;
  otel_exporter_endpoint: string;
  /** Repo-relative path to the coverage report a generated workflow reads. */
  coverage_report_path: string;
  /** Repo-relative path to the SUT controllers dir analysis is scoped to. */
  sut_controllers_path: string;
  notes: string;
  brand: Brand;
  warnings: string[];
  sources: string[];
  error: string;

  constructor(init: CompanyKnowledgeInit = {}) {
    this.confluence_spaces = init.confluence_spaces ?? [];
    this.jira_projects = init.jira_projects ?? [];
    this.internal_doc_urls = init.internal_doc_urls ?? [];
    this.internal_domains = init.internal_domains ?? [];
    this.mcp_servers = init.mcp_servers ?? [];
    this.claude_code_skills = init.claude_code_skills ?? [];
    this.dashboard_url = init.dashboard_url ?? '';
    this.dashboard_token_env = init.dashboard_token_env ?? '';
    this.otel_exporter_endpoint = init.otel_exporter_endpoint ?? '';
    this.coverage_report_path = init.coverage_report_path ?? '';
    this.sut_controllers_path = init.sut_controllers_path ?? '';
    this.notes = init.notes ?? '';
    this.brand = init.brand ?? new Brand();
    this.warnings = init.warnings ?? [];
    this.sources = init.sources ?? [];
    this.error = init.error ?? '';
  }

  get isEmpty(): boolean {
    // Python `not any([... , not self.brand.is_empty])`.
    const signals: unknown[] = [
      this.confluence_spaces,
      this.jira_projects,
      this.internal_doc_urls,
      this.internal_domains,
      this.mcp_servers,
      this.claude_code_skills,
      this.dashboard_url,
      this.notes,
      !this.brand.isEmpty,
    ];
    return !signals.some((x) => pyTruthy(x));
  }

  // -- factory --------------------------------------------------------------

  /**
   * Load and merge the company-knowledge cascade.
   *
   * Sources (lowest -> highest priority):
   *   1. ~/.canary/company.json          -- org-wide defaults
   *   2. <root>/.canary/company.json     -- project-local
   *   3. <root>/.canary/company.<env>.json -- environment override
   *
   * `env` defaults to the `CANARY_ENV` environment variable when not passed
   * explicitly. If neither is set, the env layer is skipped.
   *
   * `home` is a TS-only test seam (Python patches `Path.home()`); it defaults
   * to `os.homedir()`.
   *
   * Returns an empty instance when no source files exist. Returns an instance
   * with `.error` set when a secret is detected in any layer (that layer is
   * skipped; earlier layers are still merged).
   */
  static load(
    root?: string | null,
    env?: string | null,
    home?: string,
  ): CompanyKnowledge {
    const base = root ?? process.cwd();
    const resolvedEnv = env ?? process.env['CANARY_ENV'] ?? '';
    const homeDir = home ?? homedir();

    const candidates: Array<[string, string]> = [
      [join(homeDir, '.canary', 'company.json'), '~/.canary/company.json'],
      [join(base, '.canary', 'company.json'), '.canary/company.json'],
    ];
    if (resolvedEnv) {
      candidates.push([
        join(base, '.canary', `company.${resolvedEnv}.json`),
        `.canary/company.${resolvedEnv}.json`,
      ]);
    }

    const layers: Layer[] = [];
    const errors: string[] = [];

    for (const [path, label] of candidates) {
      const [layer, err] = loadLayer(path, label);
      if (err) {
        errors.push(err);
        continue;
      }
      if (layer !== null) layers.push(layer);
    }

    if (layers.length === 0) {
      const instance = new CompanyKnowledge();
      if (errors.length > 0) instance.error = errors[0]!;
      return instance;
    }

    const merged = mergeLayers(layers);
    const instance = new CompanyKnowledge(merged);
    if (errors.length > 0) instance.error = errors[0]!;
    return instance;
  }

  // -- prompt injection -----------------------------------------------------

  /**
   * Return the '--- COMPANY KNOWLEDGE ---' section for prompt injection.
   *
   * Returns an empty string when isEmpty is true.
   */
  promptBlock(): string {
    if (this.isEmpty) return '';

    const lines: string[] = [
      '--- COMPANY KNOWLEDGE ---',
      'Consult these company-internal sources when generating:',
    ];

    let mcpHint = '';
    if (pyTruthy(this.mcp_servers)) {
      mcpHint = ` (via ${this.mcp_servers.join(', ')} MCP)`;
    }

    if (pyTruthy(this.confluence_spaces)) {
      lines.push(
        `- Confluence spaces${mcpHint}: ${this.confluence_spaces.join(', ')}`,
      );
    }
    if (pyTruthy(this.jira_projects)) {
      lines.push(`- Jira projects${mcpHint}: ${this.jira_projects.join(', ')}`);
    }
    if (pyTruthy(this.internal_doc_urls)) {
      lines.push('- Reference docs (fetch via MCP / authenticated tool):');
      for (const url of this.internal_doc_urls) lines.push(`    - ${url}`);
    }
    if (pyTruthy(this.internal_domains)) {
      lines.push(`- Internal domains: ${this.internal_domains.join(', ')}`);
    }
    if (pyTruthy(this.claude_code_skills)) {
      const skillList = this.claude_code_skills.map((s) => `/${s}`).join(', ');
      lines.push(
        `- Claude Code skills available for this project: ${skillList}. ` +
          'Invoke the relevant skill when its scope matches the task.',
      );
    }
    if (pyTruthy(this.notes)) {
      lines.push(`- Notes from the project owner: ${this.notes}`);
    }

    lines.push(
      'Do not invent internal URLs, project keys, or hostnames. If a piece of\n' +
        "context isn't covered above, say so in a comment rather than guessing.",
    );
    return lines.join('\n');
  }

  // -- serialisation --------------------------------------------------------

  toDict(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      is_empty: this.isEmpty,
      confluence_spaces: this.confluence_spaces,
      jira_projects: this.jira_projects,
      internal_doc_urls: this.internal_doc_urls,
      internal_domains: this.internal_domains,
      mcp_servers: this.mcp_servers,
      claude_code_skills: this.claude_code_skills,
      dashboard_url: this.dashboard_url,
      dashboard_token_env: this.dashboard_token_env,
      otel_exporter_endpoint: this.otel_exporter_endpoint,
      coverage_report_path: this.coverage_report_path,
      sut_controllers_path: this.sut_controllers_path,
      notes: this.notes,
      brand: this.brand.toDict(),
      sources: this.sources,
      warnings: this.warnings,
    };
    if (pyTruthy(this.error)) out['error'] = this.error;
    return out;
  }

  // -- report branding hook (#340c) -----------------------------------------

  /**
   * Brand assets + attribution for a customer-facing report generator.
   *
   * Returns every brand asset that is present. When `logo_path` is set,
   * `logo_path_resolved` is added, resolved against the consuming repo (cwd).
   * `attribution` is always present. `voice_line` is optional garnish, included
   * only when *flavor* is on (explicit arg wins; else a truthy
   * CANARY_NO_FLAVOR / NO_FLAVOR turns it off; default on).
   */
  reportBranding(flavor?: boolean | null): Record<string, unknown> {
    const on = resolveFlavor(flavor);
    const out: Record<string, unknown> = { ...this.brand.assets };
    const logoPath = out['logo_path'];
    if (typeof logoPath === 'string' && logoPath) {
      const cwd = process.cwd();
      out['logo_path_resolved'] = isAbsolute(logoPath)
        ? logoPath
        : join(cwd, logoPath);
    }
    out['attribution'] = _ATTRIBUTION;
    out['voice_line'] = on ? _VOICE_LINE : '';
    out['flavor'] = on;
    return out;
  }
}
