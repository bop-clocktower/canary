// output -- turn the gathered inputs into the printed text, and write --out.
// Split from cli.mjs so the entry point stays within the perf coupling rule.

import fs from 'node:fs';
import path from 'node:path';

import { assembleReport, renderJson } from './scorecard.mjs';
import { renderMarkdown } from './render.mjs';

/**
 * @param {Record<string, object>} inputs what inputs.gather read
 * @param {{branch: string, json: boolean}} opts
 * @returns {{abstained: boolean, text: string}}
 */
export function produce(inputs, { branch, json }) {
  const report = assembleReport(inputs, { branch });
  const text = json ? renderJson(report) : renderMarkdown(report);
  return { abstained: report.abstained, text };
}

/**
 * The sibling-skill `--out` convention (canary-ivy, canary-question): create
 * parent directories, write the printed text, or say why it could not be
 * written.
 *
 * @returns {string|null} null on success
 */
export function writeArtifact(out, text) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${text}\n`, 'utf8');
    return null;
  } catch (exc) {
    return `cannot write artifact: ${exc.code ?? exc.name}`;
  }
}
