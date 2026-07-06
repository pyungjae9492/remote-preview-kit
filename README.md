# remote-preview-kit

`remote-preview-kit` is a small agent-friendly CLI for sharing a running
localhost dev server through an existing preview provider.

It does not run a tunnel service, does not store secrets, and does not replace
Cloudflare Tunnel, ngrok, Codespaces, or any other provider. It only wraps the
provider binary or platform URL so a coding agent can return one clean preview
URL to a user on mobile.

## Install

Install directly from GitHub:

```sh
npm install -g github:pyungjae9492/remote-preview-kit
```

Or clone and run from source:

```sh
git clone https://github.com/pyungjae9492/remote-preview-kit.git
cd remote-preview-kit
node bin/remote-preview.mjs --help
```

For local development, link the binary:

```sh
npm link
remote-preview --help
```

## Quick start

Start your app first:

```sh
npm run dev
```

Then expose the dev server:

```sh
remote-preview --provider cloudflared --public
```

The first non-empty line is the URL:

```txt
https://example.trycloudflare.com
```

If you do not install the binary, run the same command through Node:

```sh
node bin/remote-preview.mjs --provider cloudflared --public
```

When `--port` and `--url` are omitted, the CLI scans common HTTP dev-server
ports such as `5173`, `3000`, `3001`, `4173`, `4321`, `8000`, and `8080`, then
exposes the first responsive localhost server. If more than one dev server is
running, pass `--port` or `--url` explicitly.

To customize the scan order:

```sh
REMOTE_PREVIEW_PORTS=3000,5173 remote-preview --provider cloudflared --public
```

## Overview

`remote-preview-kit` is built for remote coding sessions where the developer,
agent, or reviewer cannot open the agent's `localhost` directly. It gives
Codex mobile, Claude mobile, Telegram Hermes, and similar workflows a clean way
to turn a running local dev server into a shareable preview URL.

It is intentionally small:

- Node.js standard library only.
- No hosted service.
- No provider SDKs.
- Public tunnels require explicit `--public`.
- Common database and admin ports are blocked by default.
- Codespaces support is read-only and never changes port visibility.

## Usage

Machine-readable output:

```sh
remote-preview --provider cloudflared --public --json
```

Use a localhost URL instead of a port:

```sh
remote-preview --url http://127.0.0.1:5173 --provider cloudflared --public
```

Notify another process:

```sh
remote-preview --provider cloudflared --public \
  --notify-cmd node --notify-arg ./scripts/send-preview.mjs
```

The notifier receives the preview URL in `REMOTE_PREVIEW_URL` and as the final
argv item. The command runs without shell interpolation.

## Providers

### Codespaces

```sh
remote-preview --provider codespaces
```

Codespaces support is read-only. The CLI derives the forwarded URL from
environment variables and never changes port visibility. If you pass
`--public`, it prints the `gh codespace ports visibility` command to run
yourself.

### cloudflared

```sh
remote-preview --provider cloudflared --public
```

`cloudflared` creates a public Quick Tunnel, so `--public` is required.

### ngrok

```sh
remote-preview --provider ngrok --public
```

`ngrok` creates a public endpoint, so `--public` is required.

## Safety

Public providers require `--public`. Common database and admin ports are denied
by default, including Postgres, MySQL, Redis, MongoDB, Elasticsearch, and local
Supabase ports. Use `--allow-risky-port` only when you intentionally want to
share one of those ports.

`--allow-risky-port` does not bypass `--public`.

Only local upstream URLs are accepted:

```sh
remote-preview --url http://127.0.0.1:5173 --provider cloudflared --public
```

Remote upstream URLs are rejected.

## Agent Workflow

For Codex mobile, Claude mobile, or Telegram Hermes-style agents:

1. Confirm the dev server is already running.
2. Run `remote-preview` without a port for common dev servers, or pass `--port`
   when multiple servers are running.
3. Return the `url` field or the first stdout line to the user.
4. Keep the cleanup command/PID in the task notes.

Most dev-server live reload and WebSocket-based HMR continue to work because the
tunnel forwards to the existing localhost server. Provider limitations still
apply; for example, some quick tunnel products may not support SSE.

## Non-goals

- No hosted tunnel service.
- No custom tunnel protocol.
- No provider SDK.
- No GUI, dashboard, or browser extension.
- No storage of provider tokens, Telegram bot tokens, `.env` files, cookies, or
  application secrets.
