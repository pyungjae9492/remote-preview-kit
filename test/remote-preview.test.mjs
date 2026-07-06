import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
      cwd: root,
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

async function withServer(port, fn) {
  return await fn(port || 4173, { REMOTE_PREVIEW_SKIP_READINESS: '1' });
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
