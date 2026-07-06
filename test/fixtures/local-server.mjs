#!/usr/bin/env node

import http from 'node:http';

if (process.env.NODE_TEST_CONTEXT && !process.env.REMOTE_PREVIEW_FIXTURE_RUN) {
  process.exit(0);
}

const port = Number(process.argv[2] ?? 4173);
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('remote-preview fixture');
});

setTimeout(() => {
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    console.log(`listening ${address.port}`);
  });
}, Number(process.env.LOCAL_SERVER_DELAY_MS ?? 0));

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
