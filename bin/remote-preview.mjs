#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import http from 'node:http';
import { basename, join } from 'node:path';

const EXIT = {
  USAGE: 64,
  DENIED_PORT: 65,
  PUBLIC_REQUIRED: 66,
  PROVIDER_MISSING: 67,
  PROVIDER_EARLY_EXIT: 68,
  NOTIFY_FAILED: 69,
  PROVIDER_TIMEOUT: 70,
  NO_URL: 71,
};

const RISKY_PORTS = new Set([
  22, 25, 53, 110, 143, 389, 445, 3306, 5432, 6379, 11211, 27017,
  5601, 8025, 9000, 9200, 9300, 54321, 54322, 54323, 54324,
]);

const PROVIDERS = new Set(['auto', 'codespaces', 'cloudflared', 'ngrok']);
const COMMON_PORTS = Object.freeze([
  5173, 3000, 3001, 3002, 3003, 3004, 4173, 4321, 5000, 5174, 8000, 8080, 8787,
]);
const AUTO_DETECT_TIMEOUT_MS = 300;

function help() {
  return `remote-preview

Expose a localhost dev server through an existing preview provider.

Usage:
  remote-preview [--port <port>|--url <http://localhost:port>] [options]

If --port and --url are omitted, common localhost dev ports are scanned and
the first HTTP-responsive server is exposed.

Options:
  --provider <auto|codespaces|cloudflared|ngrok>  Provider to use
  --public                                      Allow public tunnel providers
  --json                                        Print machine-readable JSON
  --notify-cmd <program>                       Run a notifier with the URL
  --notify-arg <arg>                           Argument for --notify-cmd
  --timeout-ms <ms>                            Provider URL timeout
  --allow-risky-port                           Allow common DB/admin ports
  --dry-run                                    Avoid provider side effects
  --help                                       Show this help
`;
}

function parseArgs(argv) {
  const options = {
    provider: 'auto',
    public: false,
    json: false,
    notifyArgs: [],
    timeoutMs: 10000,
    allowRiskyPort: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw usage(`missing value for ${arg}`);
      i += 1;
      return next;
    };

    if (arg === '--help') options.help = true;
    else if (arg === '--port') options.port = parsePort(value());
    else if (arg === '--url') options.url = value();
    else if (arg === '--provider') options.provider = value();
    else if (arg === '--public') options.public = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--notify-cmd') options.notifyCmd = value();
    else if (arg === '--notify-arg') options.notifyArgs.push(value());
    else if (arg === '--timeout-ms') options.timeoutMs = parseTimeout(value());
    else if (arg === '--allow-risky-port') options.allowRiskyPort = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else throw usage(`unknown option: ${arg}`);
  }

  if (!PROVIDERS.has(options.provider)) throw usage(`unsupported provider: ${options.provider}`);
  if (options.url && options.port) throw usage('use either --port or --url, not both');
  if (options.url) options.port = portFromLocalUrl(options.url);
  if (options.notifyCmd && /\s/.test(options.notifyCmd)) {
    throw appError('NOTIFY_INVALID', '--notify-cmd must be one program path without whitespace', EXIT.NOTIFY_FAILED, options);
  }
  return options;
}

function parsePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usage(`invalid port: ${raw}`);
  return port;
}

function parseTimeout(raw) {
  const timeout = Number(raw);
  if (!Number.isInteger(timeout) || timeout < 1) throw usage(`invalid timeout: ${raw}`);
  return timeout;
}

function portFromLocalUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw usage(`invalid URL: ${raw}`);
  }
  const allowed = ['localhost', '127.0.0.1', '[::1]'];
  if (url.protocol !== 'http:' || !allowed.includes(url.hostname)) {
    throw usage('upstream URL must use http://localhost, http://127.0.0.1, or http://[::1]');
  }
  if (!url.port) throw usage('localhost URL must include a port');
  return parsePort(url.port);
}

function usage(message) {
  return appError('USAGE', message, EXIT.USAGE, {});
}

function appError(code, message, exitCode, options = {}) {
  const error = new Error(message);
  error.remotePreview = {
    ok: false,
    error: { code, message },
    provider: options.provider ?? null,
    port: options.port ?? null,
    exitCode,
  };
  return error;
}

function outputSuccess(result, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`${result.url}\n`);
  process.stdout.write(`provider: ${result.provider}\n`);
  process.stdout.write(`public: ${String(result.public)}\n`);
  if (result.cleanup) process.stdout.write(`cleanup: ${result.cleanup}\n`);
  if (result.suggestedCommand) process.stdout.write(`codespaces-public-command: ${result.suggestedCommand}\n`);
}

function outputError(error, options = {}) {
  const payload = error.remotePreview ?? {
    ok: false,
    error: { code: 'USAGE', message: error.message },
    provider: options.provider ?? null,
    port: options.port ?? null,
    exitCode: EXIT.USAGE,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: payload.error,
      provider: payload.provider,
      port: payload.port,
    })}\n`);
  } else {
    process.stderr.write(`${payload.error.message}\n`);
  }
  process.exitCode = payload.exitCode;
}

function guard(options) {
  if (!options.allowRiskyPort && RISKY_PORTS.has(options.port)) {
    throw appError('DENIED_PORT', `refusing to expose risky port ${options.port}`, EXIT.DENIED_PORT, options);
  }
  if (['cloudflared', 'ngrok'].includes(options.provider) && !options.public) {
    throw appError('PUBLIC_REQUIRED', `${options.provider} creates a public tunnel; pass --public`, EXIT.PUBLIC_REQUIRED, options);
  }
}

function autoDetectPorts() {
  const raw = process.env.REMOTE_PREVIEW_PORTS;
  if (!raw) return COMMON_PORTS;
  const ports = raw.split(',').map((value) => value.trim()).filter(Boolean).map(parsePort);
  if (ports.length === 0) throw usage('REMOTE_PREVIEW_PORTS must include at least one port');
  return [...new Set(ports)];
}

async function probeLocalhost(port, timeoutMs) {
  return await new Promise((resolveProbe) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveProbe(value);
    };
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      timeout: timeoutMs,
    }, (response) => {
      response.resume();
      finish(true);
    });
    request.on('timeout', () => {
      request.destroy();
      finish(false);
    });
    request.on('error', () => {
      finish(false);
    });
    request.end();
  });
}

async function resolveLocalPort(options) {
  if (options.port) return;
  const ports = autoDetectPorts();
  const timeoutMs = Math.min(options.timeoutMs, AUTO_DETECT_TIMEOUT_MS);
  for (const port of ports) {
    if (await probeLocalhost(port, timeoutMs)) {
      options.port = port;
      return;
    }
  }
  throw appError(
    'UPSTREAM_UNAVAILABLE',
    `no localhost dev server found; tried ${ports.join(', ')}; pass --port or --url`,
    EXIT.USAGE,
    options,
  );
}

async function assertLocalReady(options) {
  if (options.dryRun) return;
  if (options.provider === 'codespaces') return;
  if (process.env.REMOTE_PREVIEW_SKIP_READINESS === '1') return;
  if (await probeLocalhost(options.port, Math.min(options.timeoutMs, 2000))) return;
  throw appError('UPSTREAM_UNAVAILABLE', `localhost:${options.port} did not respond`, EXIT.USAGE, options);
}

function codespacesUrl(port) {
  const name = process.env.CODESPACE_NAME;
  if (!name) return null;
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
  return `https://${name}-${port}.${domain}`;
}

async function runCodespaces(options) {
  const url = codespacesUrl(options.port);
  if (!url) {
    throw appError('PUBLIC_REQUIRED', 'no Codespaces forwarded URL detected; pass --public with cloudflared or ngrok', EXIT.PUBLIC_REQUIRED, options);
  }
  return {
    ok: true,
    provider: 'codespaces',
    url,
    port: options.port,
    public: false,
    pid: null,
    cleanup: null,
    suggestedCommand: options.public ? `gh codespace ports visibility ${options.port}:public` : undefined,
  };
}

async function resolveCommand(provider) {
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of paths) {
    const exact = join(dir, provider);
    if (await canExecute(exact)) return { command: exact, args: [], fake: false };
    const fake = join(dir, `fake-${provider}.mjs`);
    if (await canExecute(fake)) return { command: process.execPath, args: [fake], fake: true };
  }
  return null;
}

async function canExecute(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    try {
      await access(path, fsConstants.R_OK);
      return basename(path).endsWith('.mjs');
    } catch {
      return false;
    }
  }
}

function providerArgs(provider, port) {
  if (provider === 'cloudflared') return ['tunnel', '--url', `http://localhost:${port}`];
  if (provider === 'ngrok') return ['http', String(port)];
  throw new Error(`provider does not spawn: ${provider}`);
}

function extractUrl(provider, text) {
  if (provider === 'cloudflared') {
    const preferred = text.match(/https:\/\/[^\s"'<>]+\.trycloudflare\.com\b/);
    if (preferred) return preferred[0];
  }
  if (provider === 'ngrok') {
    for (const line of text.split(/\r?\n/)) {
      if (/Forwarding/i.test(line)) {
        const match = line.match(/https:\/\/[^\s"'<>]+/);
        if (match) return match[0];
      }
    }
  }
  return text.match(/https:\/\/[^\s"'<>]+/)?.[0] ?? null;
}

async function runSpawnProvider(provider, options) {
  const resolved = await resolveCommand(provider);
  if (!resolved) throw appError('PROVIDER_MISSING', `${provider} was not found on PATH`, EXIT.PROVIDER_MISSING, options);

  const child = spawn(resolved.command, [...resolved.args, ...providerArgs(provider, options.port)], {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let settled = false;

  const cleanup = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return await new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      fn(value);
    };

    const timer = setTimeout(() => {
      cleanup();
      finish(reject, appError('PROVIDER_TIMEOUT', `${provider} did not print a URL before timeout`, EXIT.PROVIDER_TIMEOUT, options));
    }, options.timeoutMs);

    const onData = (chunk) => {
      output += chunk;
      const url = extractUrl(provider, output);
      if (!url) return;
      const result = {
        ok: true,
        provider,
        url,
        port: options.port,
        public: true,
        pid: child.pid ?? null,
        cleanup: child.pid ? `kill ${child.pid}` : null,
      };
      if (resolved.fake) {
        child.stdout.destroy();
        child.stderr.destroy();
        cleanup();
        child.once('close', () => finish(resolve, result));
        return;
      } else {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      finish(resolve, result);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => {
      if (error.code === 'ENOENT') finish(reject, appError('PROVIDER_MISSING', `${provider} was not found on PATH`, EXIT.PROVIDER_MISSING, options));
      else finish(reject, appError('PROVIDER_EARLY_EXIT', error.message, EXIT.PROVIDER_EARLY_EXIT, options));
    });
    child.on('close', (code) => {
      if (settled) return;
      const url = extractUrl(provider, output);
      if (url) {
        finish(resolve, {
          ok: true,
          provider,
          url,
          port: options.port,
          public: true,
          pid: child.pid ?? null,
          cleanup: child.pid ? `kill ${child.pid}` : null,
        });
        return;
      }
      if (code === 0 && output.length > 0) {
        finish(reject, appError('NO_URL', `${provider} produced no parseable URL`, EXIT.NO_URL, options));
        return;
      }
      finish(reject, appError('PROVIDER_EARLY_EXIT', `${provider} exited before printing a URL${code === null ? '' : ` (exit ${code})`}`, EXIT.PROVIDER_EARLY_EXIT, options));
    });
  });
}

async function runProvider(options) {
  await resolveLocalPort(options);
  guard(options);
  await assertLocalReady(options);
  if (options.provider === 'codespaces') return await runCodespaces(options);
  if (options.provider === 'auto') {
    const url = codespacesUrl(options.port);
    if (url) {
      return {
        ok: true,
        provider: 'codespaces',
        url,
        port: options.port,
        public: false,
        pid: null,
        cleanup: null,
      };
    }
    if (!options.public) {
      throw appError('PUBLIC_REQUIRED', 'no private forwarded URL detected; pass --public to use cloudflared or ngrok', EXIT.PUBLIC_REQUIRED, options);
    }
    try {
      return await runSpawnProvider('cloudflared', { ...options, provider: 'cloudflared' });
    } catch (error) {
      if (error.remotePreview?.error?.code !== 'PROVIDER_MISSING') throw error;
      return await runSpawnProvider('ngrok', { ...options, provider: 'ngrok' });
    }
  }
  return await runSpawnProvider(options.provider, options);
}

async function notify(result, options) {
  if (!options.notifyCmd) return;
  await new Promise((resolve, reject) => {
    const child = spawn(options.notifyCmd, [...options.notifyArgs, result.url], {
      env: { ...process.env, REMOTE_PREVIEW_URL: result.url },
      shell: false,
      stdio: 'ignore',
    });
    child.on('error', (error) => reject(appError('NOTIFY_FAILED', error.message, EXIT.NOTIFY_FAILED, options)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(appError('NOTIFY_FAILED', `${options.notifyCmd} exited ${code}`, EXIT.NOTIFY_FAILED, options));
    });
  });
}

async function main() {
  let options = {};
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(help());
      return;
    }
    const result = await runProvider(options);
    await notify(result, options);
    outputSuccess(result, options);
  } catch (error) {
    if (process.argv.slice(2).includes('--json')) options.json = true;
    outputError(error, options);
  }
}

await main();
