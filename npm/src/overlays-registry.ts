'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Reader/writer for `~/.canary/overlays.json` — the tracked-overlay registry.
 *
 * Cross-runtime contract (spec Assumption): this file is written ONLY by the
 * TS side. The Python skill loader never parses it; it directory-scans the
 * `~/.canary/overlays/<name>/` clone dirs instead. So the schema here serves
 * the `overlay` commands alone.
 */

export const SCHEMA_VERSION = 1;

export interface OverlayEntry {
  /** Registry key and clone dir name: `<owner>-<repo>`. */
  name: string;
  /** The source spec as the user gave it (`github:...`, URL, or path). */
  source: string;
  /** Pinned tag/branch, or null to track the remote default branch. */
  ref: string | null;
  /** Absolute clone path under `~/.canary/overlays/`. */
  path: string;
  /** ISO date the overlay was added. */
  addedDate: string;
  /**
   * Consent for this overlay's `command-succeeds` doctor checks: true when the
   * user allowed them at `overlay add`, false when declined, null when the
   * overlay ships no such checks (nothing to gate).
   */
  consent: boolean | null;
  /**
   * Fingerprint of the `command-succeeds` set that `consent` was granted for,
   * or null when there are no such checks. Consent is re-requested when the
   * live manifest's fingerprint no longer matches this.
   */
  consentCommandsHash: string | null;
  /**
   * Declared arbitration priority when two overlays ship the same skill name
   * (#333). Higher wins; null/absent is treated as 0. A collision is only
   * *resolved* when exactly one contending overlay holds the highest
   * precedence — otherwise which definition wins is accidental and `doctor`
   * flags it. Both runtimes read this: TS diagnostics and the Python skill
   * loader must agree on the winner.
   */
  precedence: number | null;
}

export interface OverlayRegistry {
  schemaVersion: number;
  overlays: OverlayEntry[];
}

/** Raised when the registry file exists but cannot be read or parsed. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export function canaryHome(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.canary');
}

export function registryPath(homeDir: string = os.homedir()): string {
  return path.join(canaryHome(homeDir), 'overlays.json');
}

export function overlaysDir(homeDir: string = os.homedir()): string {
  return path.join(canaryHome(homeDir), 'overlays');
}

export function clonePath(
  name: string,
  homeDir: string = os.homedir(),
): string {
  return path.join(overlaysDir(homeDir), name);
}

export function emptyRegistry(): OverlayRegistry {
  return { schemaVersion: SCHEMA_VERSION, overlays: [] };
}

/**
 * Read the registry. A missing file is an empty registry (not an error); a
 * present-but-unparseable file throws {@link RegistryError} so callers can
 * report it rather than silently discarding overlays.
 */
/** Parse registry JSON, throwing a RegistryError on unreadable/malformed input. */
function parseRegistryFile(file: string): OverlayRegistry {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyRegistry();
    }
    throw new RegistryError(`cannot read ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RegistryError(`malformed ${file}: ${(err as Error).message}`);
  }
  const overlays = (parsed as { overlays?: unknown } | null)?.overlays;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray(overlays)
  ) {
    throw new RegistryError(
      `malformed ${file}: expected { schemaVersion, overlays: [] }`,
    );
  }
  return parsed as OverlayRegistry;
}

/** Normalize forward-added optional fields so callers never see `undefined`. */
function normalizeEntry(o: OverlayEntry): OverlayEntry {
  return {
    ...o,
    consent: o.consent ?? null,
    consentCommandsHash: o.consentCommandsHash ?? null,
    precedence: typeof o.precedence === 'number' ? o.precedence : null,
  };
}

export function read(homeDir: string = os.homedir()): OverlayRegistry {
  const reg = parseRegistryFile(registryPath(homeDir));
  return {
    schemaVersion:
      typeof reg.schemaVersion === 'number'
        ? reg.schemaVersion
        : SCHEMA_VERSION,
    overlays: reg.overlays.map(normalizeEntry),
  };
}

/**
 * Whether `command-succeeds` doctor checks may run for an overlay: consent must
 * have been granted (`true`) AND still cover the live manifest's command set
 * (`liveHash` matching the recorded fingerprint). A changed manifest (hash
 * mismatch) revokes consent until it is re-confirmed at `overlay add`.
 */
export function consentGranted(
  entry: OverlayEntry,
  liveHash: string | null,
): boolean {
  return (
    entry.consent === true &&
    liveHash !== null &&
    entry.consentCommandsHash === liveHash
  );
}

/** Write the registry atomically (temp file + rename), creating `~/.canary`. */
export function write(
  registry: OverlayRegistry,
  homeDir: string = os.homedir(),
): void {
  fs.mkdirSync(canaryHome(homeDir), { recursive: true });
  const file = registryPath(homeDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function get(
  registry: OverlayRegistry,
  name: string,
): OverlayEntry | null {
  return registry.overlays.find((o) => o.name === name) ?? null;
}

export function list(registry: OverlayRegistry): OverlayEntry[] {
  return [...registry.overlays];
}

/** Add an entry. Throws if one with the same name is already registered. */
export function add(
  registry: OverlayRegistry,
  entry: OverlayEntry,
): OverlayRegistry {
  if (get(registry, entry.name)) {
    throw new RegistryError(`overlay "${entry.name}" is already registered`);
  }
  return { ...registry, overlays: [...registry.overlays, entry] };
}

/** Remove an entry by name. Returns the new registry and whether it existed. */
export function remove(
  registry: OverlayRegistry,
  name: string,
): { registry: OverlayRegistry; removed: boolean } {
  const kept = registry.overlays.filter((o) => o.name !== name);
  return {
    registry: { ...registry, overlays: kept },
    removed: kept.length !== registry.overlays.length,
  };
}
