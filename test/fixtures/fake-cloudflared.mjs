#!/usr/bin/env node

if (process.env.NODE_TEST_CONTEXT && !process.env.REMOTE_PREVIEW_FIXTURE_RUN) {
  process.exit(0);
}

if (process.env.FAKE_CLOUDFLARED_MODE === 'silent') {
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_CLOUDFLARED_MODE === 'no-url') {
  console.log('Your quick Tunnel has been created but URL is unavailable');
  process.exit(0);
} else {
  console.error('2026-07-04 INF Requesting new quick Tunnel on trycloudflare.com...');
  console.log('Your quick Tunnel has been created! Visit it at:');
  console.log('https://agent-preview.trycloudflare.com');
  setInterval(() => {}, 1000);
}
