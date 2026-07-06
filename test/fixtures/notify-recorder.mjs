#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

if (process.env.NODE_TEST_CONTEXT && !process.env.REMOTE_PREVIEW_FIXTURE_RUN) {
  process.exit(0);
}

const [recordPath, ...rest] = process.argv.slice(2);
await writeFile(recordPath, JSON.stringify({
  env: process.env.REMOTE_PREVIEW_URL,
  argv: rest,
}));
