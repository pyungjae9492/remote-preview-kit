import assert from 'node:assert/strict';

// allow: SIZE_OK - CLI behavior matrix stays together until commands split.

import http from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'remote-preview.mjs');
const fixtures = join(root, 'test', 'fixtures');

function run(args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code, signal) => {
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function fixturePathEnv() {
  return `${fixtures}:${process.env.PATH ?? ''}`;
}

function fixtureEnv(extra = {}) {
  const env = { ...extra, PATH: fixturePathEnv(), REMOTE_PREVIEW_FIXTURE_RUN: '1' };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function withFakeBrew(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'remote-preview-brew-'));
  const record = join(dir, 'brew.json');
  const brew = join(dir, 'brew');
  await writeFile(brew, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(brew, 0o755);
  try {
    return await fn({ dir, record, env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin` } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withServer(port, fn) {
  return await fn(port || 4173, { REMOTE_PREVIEW_SKIP_READINESS: '1' });
}

async function withHttpServer(port, fn) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`ok ${request.url}`);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  try {
    return await fn(address.port);
  } finally {
    await new Promise((resolveClose) => {
      server.close(resolveClose);
    });
  }
}

async function requestLocal(port, path, headers = {}) {
  return await new Promise((resolveRequest, rejectRequest) => {
    const request = http.request({ host: '127.0.0.1', port, path, headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolveRequest({ statusCode: response.statusCode, headers: response.headers, body });
      });
    });
    request.on('error', rejectRequest);
    request.end();
  });
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose) => {
    server.close(resolveClose);
  });
  return port;
}

function stopProcessGroup(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function wait(ms) {
  await new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

test('help exits 0 and names remote-preview', async () => {
  const result = await run(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /remote-preview/);
});

test('unknown option exits 64', async () => {
  const result = await run(['--unknown']);
  assert.equal(result.code, 64);
  assert.match(result.stderr, /unknown/i);
});

test('codespaces dry-run emits success JSON', async () => {
  const result = await run(['--port', '3000', '--provider', 'codespaces', '--json', '--dry-run'], {
    env: {
      CODESPACE_NAME: 'bright-space',
      GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'preview.app.github.dev',
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    provider: 'codespaces',
    url: 'https://bright-space-3000.preview.app.github.dev',
    port: 3000,
    public: false,
    pid: null,
    cleanup: null,
  });
});

test('invalid port emits usage JSON with exit 64', async () => {
  const result = await run(['--port', 'nope', '--json']);
  assert.equal(result.code, 64);
  assert.equal(JSON.parse(result.stdout).error.code, 'USAGE');
});

test('denies risky ports unless explicitly allowed', async () => {
  const result = await run(['--port', '5432', '--provider', 'cloudflared', '--public', '--json']);
  assert.equal(result.code, 65);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'DENIED_PORT');
});

test('rejects remote upstream URLs', async () => {
  const result = await run(['--url', 'https://example.com', '--provider', 'cloudflared', '--public']);
  assert.equal(result.code, 64);
  assert.match(result.stderr, /localhost|127\.0\.0\.1|\[::1\]/);
});

test('accepts localhost URL and derives port', async () => {
  const result = await run(['--url', 'http://127.0.0.1:4173', '--provider', 'codespaces', '--dry-run', '--json'], {
    env: { CODESPACE_NAME: 'local-url' },
  });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).port, 4173);
});

test('public providers require --public', async () => {
  const result = await run(['--port', '3000', '--provider', 'cloudflared', '--json']);
  assert.equal(result.code, 66);
  assert.equal(JSON.parse(result.stdout).error.code, 'PUBLIC_REQUIRED');
});

test('auto-detects a responsive localhost dev server when port is omitted', async () => {
  let detectedPort;
  const result = await withHttpServer(0, (port) => {
    detectedPort = port;
    return run(['--provider', 'cloudflared', '--public', '--json'], {
      env: fixtureEnv({ REMOTE_PREVIEW_PORTS: String(port) }),
    });
  });
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.provider, 'cloudflared');
  assert.equal(payload.port, detectedPort);
  assert.match(payload.url, /^https:\/\/.+\.trycloudflare\.com$/);
});

test('auto-detect skips macOS AirTunes on port 5000', async () => {
  const airTunes = http.createServer((request, response) => {
    response.writeHead(403, {
      'content-length': '0',
      server: 'AirTunes/950.7.1',
      'x-apple-processingtime': '0',
    });
    response.end();
  });
  await new Promise((resolveListen, rejectListen) => {
    airTunes.once('error', rejectListen);
    airTunes.listen(0, '127.0.0.1', resolveListen);
  });
  try {
    const airTunesPort = airTunes.address().port;
    let detectedPort;
    const result = await withHttpServer(0, (port) => {
      detectedPort = port;
      return run(['--provider', 'cloudflared', '--public', '--json'], {
        env: fixtureEnv({ REMOTE_PREVIEW_PORTS: `${airTunesPort},${port}` }),
      });
    });
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).port, detectedPort);
  } finally {
    await new Promise((resolveClose) => airTunes.close(resolveClose));
  }
});

test('auto-detect reports tried ports when no localhost dev server responds', async () => {
  const result = await run(['--provider', 'cloudflared', '--public', '--json'], {
    env: fixtureEnv({ REMOTE_PREVIEW_PORTS: '6553' }),
  });
  assert.equal(result.code, 64);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(payload.port, null);
  assert.match(payload.error.message, /tried 6553/);
});

test('starts package dev script when no localhost dev server responds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-preview-start-'));
  const port = await unusedPort();
  const command = `"${process.execPath}" "${join(fixtures, 'local-server.mjs')}" ${port}`;
  let payload;
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: command } }));
    const result = await run(['--provider', 'cloudflared', '--public', '--json', '--timeout-ms', '5000'], {
      cwd: dir,
      env: fixtureEnv({ REMOTE_PREVIEW_PORTS: String(port) }),
    });
    assert.equal(result.code, 0);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.provider, 'cloudflared');
    assert.equal(payload.port, port);
    assert.equal(payload.devServerPid > 0, true);
    assert.match(payload.cleanup, new RegExp(`kill -TERM -${payload.devServerPid}`));
  } finally {
    if (payload?.devServerPid) stopProcessGroup(payload.devServerPid);
    await rm(dir, { recursive: true, force: true });
  }
});

test('starts pnpm package dev script when packageManager is pnpm', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-preview-pnpm-start-'));
  const binDir = await mkdtemp(join(tmpdir(), 'remote-preview-pnpm-bin-'));
  const record = join(dir, 'pnpm-argv.json');
  const pnpm = join(binDir, 'pnpm');
  const port = await unusedPort();
  let payload;
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@11.9.0',
      scripts: {
        dev: `"${process.execPath}" "${join(fixtures, 'local-server.mjs')}" ${port}`,
      },
    }));
    await writeFile(pnpm, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const child = spawn(manifest.scripts.dev, { shell: true, stdio: 'ignore' });
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
`);
    await chmod(pnpm, 0o755);
    const result = await run(['--provider', 'cloudflared', '--public', '--json', '--timeout-ms', '5000'], {
      cwd: dir,
      env: {
        ...fixtureEnv(),
        PATH: `${binDir}:${fixturePathEnv()}`,
        REMOTE_PREVIEW_PORTS: String(port),
      },
    });
    assert.equal(result.code, 0);
    payload = JSON.parse(result.stdout);
    assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), ['run', 'dev']);
    assert.equal(payload.port, port);
  } finally {
    if (payload?.devServerPid) stopProcessGroup(payload.devServerPid);
    await rm(dir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test('waits longer for package dev script startup than provider URL timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-preview-slow-start-'));
  const port = await unusedPort();
  const command = `"${process.execPath}" "${join(fixtures, 'local-server.mjs')}" ${port}`;
  let payload;
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: command } }));
    const result = await run(['--provider', 'cloudflared', '--public', '--json', '--timeout-ms', '500'], {
      cwd: dir,
      env: fixtureEnv({
        LOCAL_SERVER_DELAY_MS: '1200',
        REMOTE_PREVIEW_PORTS: String(port),
      }),
    });
    assert.equal(result.code, 0);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.port, port);
  } finally {
    if (payload?.devServerPid) stopProcessGroup(payload.devServerPid);
    await rm(dir, { recursive: true, force: true });
  }
});

test('auth token proxy blocks requests until token sets cookie', async () => {
  let payload;
  await withHttpServer(0, async (port) => {
    try {
      const result = await run([
        '--port',
        String(port),
        '--provider',
        'cloudflared',
        '--public',
        '--json',
        '--auth-token',
        'secret-token',
      ], { env: fixtureEnv() });
      assert.equal(result.code, 0);
      payload = JSON.parse(result.stdout);
      assert.equal(payload.upstreamPort > 0, true);
      assert.match(payload.url, /remote_preview_token=secret-token/);

      const blocked = await requestLocal(payload.port, '/');
      assert.equal(blocked.statusCode, 401);

      const login = await requestLocal(payload.port, '/?remote_preview_token=secret-token');
      assert.equal(login.statusCode, 200);
      assert.equal(login.body, 'ok /');
      assert.match(login.headers['set-cookie'][0], /;\s*Secure\b/);
      const cookie = login.headers['set-cookie'][0].split(';')[0];

      const allowed = await requestLocal(payload.port, '/', { cookie });
      assert.equal(allowed.statusCode, 200);
      assert.equal(allowed.body, 'ok /');
    } finally {
      if (payload?.authProxyPid) stopProcessGroup(payload.authProxyPid);
    }
  });
});

test('auth token proxy uses localhost host header for upstream requests', async () => {
  const server = http.createServer((request, response) => {
    if (request.headers.host?.startsWith('localhost:')) {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`host ${request.headers.host}`);
      return;
    }
    response.writeHead(307, { location: '/' });
    response.end('/');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  let payload;
  try {
    const { port } = server.address();
    const result = await run([
      '--port',
      String(port),
      '--provider',
      'cloudflared',
      '--public',
      '--json',
      '--auth-token',
      'secret-token',
    ], { env: fixtureEnv() });
    assert.equal(result.code, 0);
    payload = JSON.parse(result.stdout);

    const login = await requestLocal(payload.port, '/?remote_preview_token=secret-token');
    assert.equal(login.statusCode, 200);
    assert.equal(login.body, `host localhost:${port}`);
  } finally {
    if (payload?.authProxyPid) stopProcessGroup(payload.authProxyPid);
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('auth token proxy does not forward preview credentials upstream', async () => {
  let seenHeaders;
  const server = http.createServer((request, response) => {
    seenHeaders = request.headers;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  let payload;
  try {
    const { port } = server.address();
    const result = await run([
      '--port',
      String(port),
      '--provider',
      'cloudflared',
      '--public',
      '--json',
      '--auth-token',
      'secret-token',
    ], { env: fixtureEnv() });
    assert.equal(result.code, 0);
    payload = JSON.parse(result.stdout);

    const login = await requestLocal(payload.port, '/?remote_preview_token=secret-token', {
      cookie: 'theme=dark; remote_preview_token=secret-token',
      'x-remote-preview-token': 'secret-token',
    });
    assert.equal(login.statusCode, 200);
    assert.equal(seenHeaders.cookie, 'theme=dark');
    assert.equal(seenHeaders['x-remote-preview-token'], undefined);
  } finally {
    if (payload?.authProxyPid) stopProcessGroup(payload.authProxyPid);
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('REMOTE_PREVIEW_TOKEN is used only when auth is requested', async () => {
  let plain;
  let protectedPreview;
  await withHttpServer(0, async (port) => {
    try {
      const env = fixtureEnv({ REMOTE_PREVIEW_TOKEN: 'env-token' });
      const plainResult = await run(['--port', String(port), '--provider', 'cloudflared', '--public', '--json'], { env });
      assert.equal(plainResult.code, 0);
      plain = JSON.parse(plainResult.stdout);
      assert.equal(plain.auth, undefined);
      assert.equal(plain.authProxyPid, undefined);
      assert.equal(plain.port, port);
      assert.doesNotMatch(plain.url, /remote_preview_token/);

      const protectedResult = await run(['--port', String(port), '--provider', 'cloudflared', '--public', '--json', '--auth'], { env });
      assert.equal(protectedResult.code, 0);
      protectedPreview = JSON.parse(protectedResult.stdout);
      assert.equal(protectedPreview.auth, true);
      assert.match(protectedPreview.url, /remote_preview_token=env-token/);
    } finally {
      if (plain?.pid) stopProcessGroup(plain.pid);
      if (protectedPreview?.pid) stopProcessGroup(protectedPreview.pid);
      if (protectedPreview?.authProxyPid) stopProcessGroup(protectedPreview.authProxyPid);
    }
  });
});

test('setup dry-run prints provider install command as JSON', async () => {
  const result = await withFakeBrew(({ env }) => run(['setup', '--provider', 'cloudflared', '--dry-run', '--json'], { env }));
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    provider: 'cloudflared',
    installed: false,
    installCommand: 'brew install cloudflared',
    dryRun: true,
  });
});

test('setup installs selected provider through brew when confirmed', async () => {
  await withFakeBrew(async ({ env, record }) => {
    const result = await run(['setup', '--provider', 'ngrok', '--yes', '--json'], { env });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), ['install', 'ngrok']);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.provider, 'ngrok');
    assert.equal(payload.installCommand, 'brew install ngrok');
  });
});

test('cloudflared parses trycloudflare URL and stays alive', async () => {
  const result = await withServer(0, (port, env) => run(['--port', String(port), '--provider', 'cloudflared', '--public', '--json', '--timeout-ms', '5000'], {
    env: fixtureEnv(env),
  }));
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.provider, 'cloudflared');
  assert.match(payload.url, /^https:\/\/.+\.trycloudflare\.com$/);
  assert.equal(payload.cleanup, `kill ${payload.pid}`);
});

test('real provider process keeps running after URL is returned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-preview-provider-'));
  const provider = join(dir, 'cloudflared');
  let payload;
  await writeFile(provider, `#!/usr/bin/env node
process.stdout.write('Visit https://lifetime.trycloudflare.com\\n');
const fail = () => process.exit(13);
process.stdout.on('error', fail);
process.stderr.on('error', fail);
setInterval(() => process.stderr.write('heartbeat\\n'), 10);
process.on('SIGTERM', () => process.exit(0));
`);
  await chmod(provider, 0o755);
  try {
    const result = await withServer(0, (port, env) => run(['--port', String(port), '--provider', 'cloudflared', '--public', '--json', '--timeout-ms', '5000'], {
      env: { ...env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    }));
    assert.equal(result.code, 0);
    payload = JSON.parse(result.stdout);
    await wait(300);
    assert.equal(processAlive(payload.pid), true);
  } finally {
    if (payload?.pid) stopProcessGroup(payload.pid);
    await rm(dir, { recursive: true, force: true });
  }
});

test('ngrok prefers Forwarding HTTPS URL', async () => {
  const result = await withServer(0, (port, env) => run(['--port', String(port), '--provider', 'ngrok', '--public', '--json', '--timeout-ms', '5000'], {
    env: fixtureEnv(env),
  }));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).url, 'https://agent-forward.ngrok-free.app');
});

test('missing provider binary exits 67', async () => {
  const result = await withServer(0, (port, env) => run(['--port', String(port), '--provider', 'cloudflared', '--public', '--json', '--timeout-ms', '500'], {
    env: { PATH: '/usr/bin:/bin', ...env },
  }));
  assert.equal(result.code, 67);
  assert.equal(JSON.parse(result.stdout).error.code, 'PROVIDER_MISSING');
});

test('fake provider fixture is ignored outside fixture mode', async () => {
  const result = await withServer(0, (port, env) => run(['--port', String(port), '--provider', 'cloudflared', '--public', '--json', '--timeout-ms', '500'], {
    env: { ...env, PATH: `${fixtures}:${dirname(process.execPath)}:/usr/bin:/bin` },
  }));
  assert.equal(result.code, 67);
  assert.equal(JSON.parse(result.stdout).error.code, 'PROVIDER_MISSING');
});

test('early provider exit exits 68', async () => {
  const result = await withServer(0, (port, env) => run(['--port', String(port), '--provider', 'ngrok', '--public', '--json'], {
    env: fixtureEnv({ FAKE_NGROK_MODE: 'early', ...env }),
  }));
  assert.equal(result.code, 68);
});

test('provider URL timeout exits 70 and kills child', async () => {
  const result = await withServer(0, (port, env) => run(['--port', String(port), '--provider', 'cloudflared', '--public', '--json', '--timeout-ms', '300'], {
    env: fixtureEnv({ FAKE_CLOUDFLARED_MODE: 'silent', ...env }),
  }));
  assert.equal(result.code, 70);
  assert.equal(JSON.parse(result.stdout).error.code, 'PROVIDER_TIMEOUT');
});

test('provider no-url output exits 71', async () => {
  const result = await withServer(0, (port, env) => run(['--port', String(port), '--provider', 'cloudflared', '--public', '--json'], {
    env: fixtureEnv({ FAKE_CLOUDFLARED_MODE: 'no-url', ...env }),
  }));
  assert.equal(result.code, 71);
  assert.equal(JSON.parse(result.stdout).error.code, 'NO_URL');
});

test('public provider refuses when localhost is not running', async () => {
  const result = await run(['--port', '6553', '--provider', 'cloudflared', '--public', '--json'], {
    env: fixtureEnv(),
  });
  assert.equal(result.code, 64);
  assert.equal(JSON.parse(result.stdout).error.code, 'UPSTREAM_UNAVAILABLE');
});

test('codespaces derives fallback app.github.dev URL and mentions public command', async () => {
  const result = await run(['--provider', 'codespaces', '--port', '3000', '--public'], {
    env: { CODESPACE_NAME: 'silver-spoon', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: '' },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /https:\/\/silver-spoon-3000\.app\.github\.dev/);
  assert.match(result.stdout, /gh codespace ports visibility 3000:public/);
});

test('normal mode prints URL as first non-empty stdout line', async () => {
  const result = await withServer(0, (port, env) => run(['--port', String(port), '--provider', 'cloudflared', '--public', '--timeout-ms', '5000'], {
    env: fixtureEnv(env),
  }));
  assert.equal(result.code, 0);
  const first = result.stdout.split(/\r?\n/).find((line) => line.trim());
  assert.match(first, /^https:\/\//);
});

test('json mode prints only JSON', async () => {
  const result = await withServer(0, (port, env) => run(['--port', String(port), '--provider', 'cloudflared', '--public', '--json'], {
    env: fixtureEnv(env),
  }));
  assert.equal(result.code, 0);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.equal(result.stderr, '');
});

test('notify command receives URL in env and final argv', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-preview-test-'));
  const record = join(dir, 'notify.json');
  const result = await withServer(0, (port, env) => run([
    '--port',
    String(port),
    '--provider',
    'cloudflared',
    '--public',
    '--json',
    '--notify-cmd',
    process.execPath,
    '--notify-arg',
    join(fixtures, 'notify-recorder.mjs'),
    '--notify-arg',
    record,
  ], { env: fixtureEnv(env) }));
  try {
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    const recorded = JSON.parse(await readFile(record, 'utf8'));
    assert.equal(recorded.env, payload.url);
    assert.equal(recorded.argv.at(-1), payload.url);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('notify command with whitespace exits 69', async () => {
  const result = await run(['--port', '4173', '--provider', 'codespaces', '--notify-cmd', 'sh -c echo'], {
    env: { CODESPACE_NAME: 'bad-notify' },
  });
  assert.equal(result.code, 69);
});

test('docs contain required safety and provider language', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const skill = await readFile(join(root, 'skills', 'remote-preview', 'SKILL.md'), 'utf8');
  const combined = `${readme}\n${skill}`;
  for (const phrase of [
    'does not run a tunnel service',
    'does not store secrets',
    '--public',
    '--allow-risky-port',
    'REMOTE_PREVIEW_URL',
    'cloudflared',
    'ngrok',
    'Codespaces',
  ]) {
    assert.match(combined, new RegExp(phrase.replaceAll('-', '\\-')));
  }
});
