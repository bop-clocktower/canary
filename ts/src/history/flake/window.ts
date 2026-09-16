/**
 * The store-facing half of #604's flake-window disclosure: reading the window
 * a flake query actually covered. The layer-neutral rules it reports against
 * live in `util/flake-window.ts` -- see that module for the doctrine, and for
 * why it sits in `util/` rather than here.
 */

import { measurabilityOf, type FlakyWindow } from '../../util/flake-window.js';

/** The store seam: raw records, or nothing when the backend has none to give. */
interface WindowSource {
  readAll?: () => Promise<{ suite?: string | null }[]>;
}

/**
 * Describe the window a flake query just read, or `null` when the backend
 * cannot say (G4/SC5).
 *
 * Keyed off the OPTIONAL `readAll` capability rather than a new contract
 * method, which is the same capability split #711 already established: the
 * local NDJSON adapter has it, the remote Supabase store does not. The cost is
 * a second pass over the local file per flake command, bounded by the window
 * and cheap next to the process start-up it rides along with.
 */
export async function describeFlakyWindow(
  store: WindowSource,
  window: number,
  suite: string | null,
): Promise<FlakyWindow | null> {
  if (!store.readAll) return null;
  const all = await store.readAll();
  const scoped = suite ? all.filter((r) => r.suite === suite) : all;
  const read = scoped.slice(-window) as { reporter_format?: string | null }[];
  return { runs_read: read.length, flaky_measurable: measurabilityOf(read) };
}
