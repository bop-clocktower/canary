// feed -- read and validate the canary.site/1 feed canary-barda builds from
// (#1151 phase 3b). An unreadable or invalid feed is a refusal, never a
// partial build.

import fs from 'node:fs';

import { validateText } from '../../../lib/contracts/document.mjs';

/** {doc, errors}: doc is null when the feed is unreadable or invalid. */
export function readFeed(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (exc) {
    return { doc: null, errors: [`cannot read ${file}: ${exc.message}`] };
  }
  const v = validateText(text, { layer: 'site' });
  if (!v.valid)
    return {
      doc: null,
      errors: v.errors.map((e) => `${e.path}: ${e.message}`),
    };
  return { doc: JSON.parse(text), errors: [] };
}
