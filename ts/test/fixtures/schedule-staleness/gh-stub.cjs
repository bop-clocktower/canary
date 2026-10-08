#!/usr/bin/env node
// A stand-in for `gh api <path>`, used by ts/test/schedule-staleness.test.ts.
// The test copies this file into a temp dir as `gh`, next to a `table.json`
// keyed by workflow file. A file missing from the table answers like a 404;
// `raw` is printed verbatim; `workflow` replaces the default workflow payload.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const table = JSON.parse(readFileSync(join(__dirname, 'table.json'), 'utf8'));
const path = process.argv[3] || '';
const m = /actions\/workflows\/([^/?]+)(\/runs)?/.exec(path);
const entry = m ? table[m[1]] : undefined;

function body() {
  if (typeof entry.raw === 'string') return entry.raw;
  if (m[2]) {
    const runs = entry.runs || [];
    return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
  }
  return JSON.stringify('workflow' in entry ? entry.workflow : { state: 'active' });
}

if (entry === undefined) {
  process.stderr.write(`gh: Not Found (HTTP 404) ${path}\n`);
  process.exit(1);
}
process.stdout.write(body());
