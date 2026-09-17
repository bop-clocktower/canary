#!/usr/bin/env node
// Stage voice/lines.json into dist/voice/ so `canary doctor` ships its voice
// lines (#340). Copied, not committed twice: the repo file is the only source.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', '..', 'voice', 'lines.json');
const to = join(here, '..', 'dist', 'voice', 'lines.json');
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
