/**
 * Read a `history record` results file (#538): JSON, or JUnit XML kept as text.
 * Moved out of `../cli.ts` (#461); the CLI still prints and exits 1.
 */

import { existsSync, readFileSync } from 'node:fs';

import { isWellFormedXml } from '../../util/xml.js';

/**
 * XML (JUnit, #963) stays text for the reader; everything else is JSON. A
 * malformed XML document throws, so it is refused exactly like bad JSON.
 */
function parseReportText(text: string): unknown {
  if (!text.trimStart().startsWith('<')) return JSON.parse(text);
  if (!isWellFormedXml(text)) throw new Error('XML is not well formed');
  return text;
}

/** A results file that could not be read; `label` is printed in red. */
export class ReportReadError extends Error {
  constructor(
    readonly label: string,
    readonly detail: string,
  ) {
    super(`${label} ${detail}`);
    this.name = 'ReportReadError';
  }
}

/**
 * Read + parse the results file, or throw a `ReportReadError`. The caller
 * owns the exit code; this module stays below the CLI layer.
 */
export function readReport(resultsFile: string): unknown {
  if (!existsSync(resultsFile))
    throw new ReportReadError('Not found:', resultsFile);
  try {
    return parseReportText(readFileSync(resultsFile, 'utf-8'));
  } catch (err) {
    // Loud, not silent: an unreadable report means this run recorded NOTHING,
    // and a later `analyze` would abstain without ever saying why.
    throw new ReportReadError(
      'Could not be read:',
      `${resultsFile} (${(err as Error).message}) \u{2014} nothing was recorded.`,
    );
  }
}
