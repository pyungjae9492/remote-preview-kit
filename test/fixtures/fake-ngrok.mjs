#!/usr/bin/env node

if (process.env.NODE_TEST_CONTEXT && !process.env.REMOTE_PREVIEW_FIXTURE_RUN) {
  process.exit(0);
}

if (process.env.FAKE_NGROK_MODE === 'early') {
  console.error('ngrok failed before forwarding');
  process.exit(2);
}

console.log('Session Status                online');
console.log('Forwarding                    http://ignored.example -> http://localhost:4173');
console.log('Forwarding                    https://agent-forward.ngrok-free.app -> http://localhost:4173');
setInterval(() => {}, 1000);
