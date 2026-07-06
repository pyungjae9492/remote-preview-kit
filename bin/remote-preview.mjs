#!/usr/bin/env node

// allow: SIZE_OK - single-file zero-dependency CLI; split when adding another command.

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import http from 'node:http';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const EXIT = {
  USAGE: 64,
  DENIED_PORT: 65,
  PUBLIC_REQUIRED: 66,
  PROVIDER_MISSING: 67,
  PROVIDER_EARLY_EXIT: 68,
  NOTIFY_FAILED: 69,
  PROVIDER_TIMEOUT: 70,
  NO_URL: 71,
  START_FAILED: 72,
  SETUP_FAILED: 73,
  AUTH_PROXY_FAILED: 74,
};

const RISKY_PORTS = new Set([
  22, 25, 53, 110, 143, 389, 445, 3306, 5432, 6379, 11211, 27017,
  5601, 8025, 9000, 9200, 9300, 54321, 54322, 54323, 54324,
]);

const PROVIDERS = new Set(['auto', 'codespaces', 'cloudflared', 'ngrok']);
const INSTALLABLE_PROVIDERS = new Set(['cloudflared', 'ngrok']);
const COMMON_PORTS = Object.freeze([
  5173, 3000, 3001, 3002, 3003, 3004, 4173, 4321, 5000, 5174, 8000, 8080, 8787,
]);
const AUTO_DETECT_TIMEOUT_MS = 300;
const AUTH_QUERY = 'remote_preview_token';
const AUTH_COOKIE = 'remote_preview_token';

function help() {
  return `remote-preview

Expose a localhost dev server through an existing preview provider.

Usage:
  remote-preview setup [--provider <cloudflared|ngrok>] [--yes]
  remote-preview [--port <port>|--url <http://localhost:port>] [options]

If --port and --url are omitted, common localhost dev ports are scanned and
the first HTTP-responsive server is exposed.
If no server responds, package.json's dev script is started when present.

Options:
  --provider <auto|codespaces|cloudflared|ngrok>  Provider to use
  --auth                                        Protect preview with a generated token
  --auth-token <token>                          Protect preview with this token
  --yes                                         Confirm setup install prompts
  --public                                      Allow public tunnel providers
  --json                                        Print machine-readable JSON
  --notify-cmd <program>                       Run a notifier with the URL
  --notify-arg <arg>                           Argument for --notify-cmd
  --start-cmd <command>                        Start this command if no server responds
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

  if (argv[0] === 'setup') {
    options.command = 'setup';
    argv = argv.slice(1);
  }

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
    else if (arg === '--auth') options.auth = true;
    else if (arg === '--auth-token') options.authToken = value();
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--public') options.public = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--notify-cmd') options.notifyCmd = value();
    else if (arg === '--notify-arg') options.notifyArgs.push(value());
    else if (arg === '--start-cmd') options.startCmd = value();
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

function parseProxyArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (arg === '--upstream-port') options.upstreamPort = parsePort(next());
    else if (arg === '--token') options.authToken = next();
  }
  options.authToken ??= process.env.REMOTE_PREVIEW_AUTH_PROXY_TOKEN;
  if (!options.upstreamPort || !options.authToken) throw usage('auth-proxy requires --upstream-port and --token');
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

  const startedPort = await startDevServerAndWait(options, ports);
  if (startedPort) {
    options.port = startedPort;
    return;
  }

  throw appError(
    'UPSTREAM_UNAVAILABLE',
    `no localhost dev server found; tried ${ports.join(', ')}; pass --port, --url, or --start-cmd`,
    EXIT.USAGE,
    options,
  );
}

async function startDevServerAndWait(options, ports) {
  const startCmd = await devServerStartCmd(options);
  if (!startCmd) return null;
  options.startedServer = startDevServer(startCmd);
  const detectedPort = await waitForLocalPort(ports, options);
  if (detectedPort) return detectedPort;
  cleanupStartedServer(options.startedServer);
  throw appError(
    'START_FAILED',
    `start command did not open a localhost dev server; tried ${ports.join(', ')}`,
    EXIT.START_FAILED,
    options,
  );
}

async function devServerStartCmd(options) {
  if (options.startCmd) return options.startCmd;
  try {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
    if (manifest?.scripts?.dev) return 'npm run dev';
  } catch {
    return null;
  }
  return null;
}

function startDevServer(command) {
  const child = spawn(command, {
    cwd: process.cwd(),
    env: process.env,
    shell: true,
    detached: true,
    stdio: 'ignore',
  });
  const started = { command, pid: child.pid ?? null, exited: false };
  child.once('exit', (code, signal) => {
    started.exited = true;
    started.exit = signal ?? code;
  });
  child.unref();
  return started;
}

async function waitForLocalPort(ports, options) {
  const deadline = Date.now() + options.timeoutMs;
  const timeoutMs = Math.min(options.timeoutMs, AUTO_DETECT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (options.startedServer?.exited) return null;
    for (const port of ports) {
      if (await probeLocalhost(port, timeoutMs)) return port;
    }
  }
  return null;
}

function cleanupStartedServer(startedServer) {
  if (!startedServer?.pid) return;
  try {
    process.kill(-startedServer.pid, 'SIGTERM');
  } catch {
    try {
      process.kill(startedServer.pid, 'SIGTERM');
    } catch {}
  }
}

function attachStartedServer(result, options) {
  const started = options.startedServer;
  if (!started?.pid) return result;
  const startCleanup = `kill -TERM -${started.pid}`;
  return {
    ...result,
    devServerPid: started.pid,
    cleanup: result.cleanup ? `${startCleanup}; ${result.cleanup}` : startCleanup,
  };
}

async function startAuthProxy(options) {
  const token = previewToken(options);
  if (!token) return;
  const child = spawn(process.execPath, [process.argv[1], 'auth-proxy', '--upstream-port', String(options.port)], {
    cwd: process.cwd(),
    detached: true,
    env: { ...process.env, REMOTE_PREVIEW_AUTH_PROXY_TOKEN: token },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const proxy = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(appError('AUTH_PROXY_FAILED', 'auth proxy did not start before timeout', EXIT.AUTH_PROXY_FAILED, options)), 2000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const line = output.split(/\r?\n/).find(Boolean);
      if (!line) return;
      clearTimeout(timer);
      try {
        const payload = JSON.parse(line);
        child.stdout.destroy();
        child.unref();
        resolve({ pid: child.pid, port: payload.port, token });
      } catch (error) {
        reject(appError('AUTH_PROXY_FAILED', error.message, EXIT.AUTH_PROXY_FAILED, options));
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(appError('AUTH_PROXY_FAILED', error.message, EXIT.AUTH_PROXY_FAILED, options));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(appError('AUTH_PROXY_FAILED', `auth proxy exited ${code}`, EXIT.AUTH_PROXY_FAILED, options));
    });
  });
  options.upstreamPort = options.port;
  options.port = proxy.port;
  options.authProxy = proxy;
}

function previewToken(options) {
  if (options.authToken) return options.authToken;
  if (process.env.REMOTE_PREVIEW_TOKEN) return process.env.REMOTE_PREVIEW_TOKEN;
  if (options.auth) return randomBytes(24).toString('base64url');
  return null;
}

function cleanupAuthProxy(authProxy) {
  if (!authProxy?.pid) return;
  try {
    process.kill(-authProxy.pid, 'SIGTERM');
  } catch {
    try {
      process.kill(authProxy.pid, 'SIGTERM');
    } catch {}
  }
}

function attachAuthProxy(result, options) {
  const proxy = options.authProxy;
  if (!proxy) return result;
  const url = new URL(result.url);
  url.searchParams.set(AUTH_QUERY, proxy.token);
  const authCleanup = `kill -TERM -${proxy.pid}`;
  return {
    ...result,
    url: url.toString(),
    auth: true,
    authProxyPid: proxy.pid,
    upstreamPort: options.upstreamPort,
    cleanup: result.cleanup ? `${authCleanup}; ${result.cleanup}` : authCleanup,
  };
}

async function assertLocalReady(options) {
  if (options.dryRun) return;
  if (options.provider === 'codespaces') return;
  if (process.env.REMOTE_PREVIEW_SKIP_READINESS === '1') return;
  if (await probeLocalhost(options.port, Math.min(options.timeoutMs, 2000))) return;
  if (await startDevServerAndWait(options, [options.port])) return;
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

async function resolveExecutable(command) {
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of paths) {
    const exact = join(dir, command);
    if (await canExecute(exact)) return exact;
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
  if (!resolved) throw appError('PROVIDER_MISSING', `${provider} was not found on PATH; run remote-preview setup --provider ${provider}`, EXIT.PROVIDER_MISSING, options);

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
      if (error.code === 'ENOENT') finish(reject, appError('PROVIDER_MISSING', `${provider} was not found on PATH; run remote-preview setup --provider ${provider}`, EXIT.PROVIDER_MISSING, options));
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
  try {
    guard(options);
    await assertLocalReady(options);
    await startAuthProxy(options);
    if (options.provider === 'codespaces') return attachAuthProxy(attachStartedServer(await runCodespaces(options), options), options);
    if (options.provider === 'auto') {
      const url = codespacesUrl(options.port);
      if (url) {
        return attachAuthProxy(attachStartedServer({
          ok: true,
          provider: 'codespaces',
          url,
          port: options.port,
          public: false,
          pid: null,
          cleanup: null,
        }, options), options);
      }
      if (!options.public) {
        throw appError('PUBLIC_REQUIRED', 'no private forwarded URL detected; pass --public to use cloudflared or ngrok', EXIT.PUBLIC_REQUIRED, options);
      }
      try {
        return attachAuthProxy(attachStartedServer(await runSpawnProvider('cloudflared', { ...options, provider: 'cloudflared' }), options), options);
      } catch (error) {
        if (error.remotePreview?.error?.code !== 'PROVIDER_MISSING') throw error;
        return attachAuthProxy(attachStartedServer(await runSpawnProvider('ngrok', { ...options, provider: 'ngrok' }), options), options);
      }
    }
    return attachAuthProxy(attachStartedServer(await runSpawnProvider(options.provider, options), options), options);
  } catch (error) {
    cleanupAuthProxy(options.authProxy);
    cleanupStartedServer(options.startedServer);
    throw error;
  }
}

function runAuthProxy(options) {
  const server = http.createServer((request, response) => {
    if (!authorized(request, options.authToken)) {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('missing or invalid preview token');
      return;
    }
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (requestUrl.searchParams.get(AUTH_QUERY)) {
      requestUrl.searchParams.delete(AUTH_QUERY);
      response.writeHead(302, {
        'set-cookie': `${AUTH_COOKIE}=${encodeURIComponent(options.authToken)}; HttpOnly; SameSite=Lax; Path=/`,
        location: `${requestUrl.pathname}${requestUrl.search}`,
      });
      response.end();
      return;
    }
    proxyHttp(request, response, options.upstreamPort);
  });
  server.on('upgrade', (request, socket, head) => {
    if (!authorized(request, options.authToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    proxyUpgrade(request, socket, head, options.upstreamPort);
  });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

function authorized(request, token) {
  const requestUrl = new URL(request.url, 'http://127.0.0.1');
  const supplied = requestUrl.searchParams.get(AUTH_QUERY)
    ?? request.headers['x-remote-preview-token']
    ?? cookieValue(request.headers.cookie, AUTH_COOKIE);
  return safeEqual(String(supplied ?? ''), token);
}

function cookieValue(header, name) {
  const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeEqual(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function proxyHttp(request, response, port) {
  const proxy = http.request({
    host: '127.0.0.1',
    port,
    path: request.url,
    method: request.method,
    headers: { ...request.headers, host: `127.0.0.1:${port}` },
  }, (upstream) => {
    response.writeHead(upstream.statusCode ?? 502, upstream.headers);
    upstream.pipe(response);
  });
  proxy.on('error', () => {
    response.writeHead(502, { 'content-type': 'text/plain' });
    response.end('upstream unavailable');
  });
  request.pipe(proxy);
}

function proxyUpgrade(request, socket, head, port) {
  const proxy = http.request({
    host: '127.0.0.1',
    port,
    path: request.url,
    method: request.method,
    headers: { ...request.headers, host: `127.0.0.1:${port}` },
  });
  proxy.on('upgrade', (response, proxySocket, proxyHead) => {
    socket.write(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n`);
    for (const [name, value] of Object.entries(response.headers)) socket.write(`${name}: ${value}\r\n`);
    socket.write('\r\n');
    if (proxyHead.length) socket.write(proxyHead);
    if (head.length) proxySocket.write(head);
    proxySocket.pipe(socket).pipe(proxySocket);
  });
  proxy.on('error', () => socket.destroy());
  proxy.end();
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

async function runSetup(options) {
  const provider = await setupProvider(options);
  const installedPath = await resolveExecutable(provider);
  const install = await providerInstall(provider);
  if (installedPath) {
    return { ok: true, provider, installed: true, path: installedPath, installCommand: install?.display ?? null };
  }
  if (!install) {
    throw appError('SETUP_UNSUPPORTED', `automatic install for ${provider} is only supported on macOS with Homebrew`, EXIT.SETUP_FAILED, options);
  }
  if (options.dryRun) {
    return { ok: true, provider, installed: false, installCommand: install.display, dryRun: true };
  }
  await confirmInstall(provider, install.display, options);
  await runInstall(install, options);
  return { ok: true, provider, installed: true, installCommand: install.display };
}

async function setupProvider(options) {
  if (options.provider !== 'auto') {
    if (!INSTALLABLE_PROVIDERS.has(options.provider)) throw usage('setup provider must be cloudflared or ngrok');
    return options.provider;
  }
  if (!process.stdin.isTTY) throw usage('setup requires --provider in non-interactive shells');
  process.stdout.write('Choose provider:\n1) cloudflared\n2) ngrok\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Provider [1]: ')).trim();
    return answer === '2' || answer.toLowerCase() === 'ngrok' ? 'ngrok' : 'cloudflared';
  } finally {
    rl.close();
  }
}

async function providerInstall(provider) {
  if (process.platform !== 'darwin') return null;
  const brew = await resolveExecutable('brew');
  if (!brew) return null;
  return { command: brew, args: ['install', provider], display: `brew install ${provider}` };
}

async function confirmInstall(provider, command, options) {
  if (options.yes) return;
  if (!process.stdin.isTTY) {
    throw appError('SETUP_CONFIRM_REQUIRED', `pass --yes to install ${provider} with ${command}`, EXIT.SETUP_FAILED, options);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`Install ${provider} with "${command}"? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') throw appError('SETUP_CANCELLED', 'setup cancelled', EXIT.SETUP_FAILED, options);
  } finally {
    rl.close();
  }
}

async function runInstall(install, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(install.command, install.args, { stdio: 'inherit', shell: false });
    child.on('error', (error) => reject(appError('SETUP_FAILED', error.message, EXIT.SETUP_FAILED, options)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(appError('SETUP_FAILED', `${install.display} exited ${code}`, EXIT.SETUP_FAILED, options));
    });
  });
}

function outputSetup(result, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.installed && result.path) process.stdout.write(`${result.provider} already installed: ${result.path}\n`);
  else if (result.dryRun) process.stdout.write(`${result.installCommand}\n`);
  else process.stdout.write(`${result.provider} installed\n`);
}

async function main() {
  let options = {};
  try {
    if (process.argv[2] === 'auth-proxy') {
      runAuthProxy(parseProxyArgs(process.argv.slice(3)));
      return;
    }
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(help());
      return;
    }
    if (options.command === 'setup') {
      outputSetup(await runSetup(options), options);
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
