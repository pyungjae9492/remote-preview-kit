# remote-preview-kit

`remote-preview-kit` is a small agent-friendly CLI for sharing a running
localhost dev server through an existing preview provider.

It does not run a tunnel service, does not store secrets, and does not replace
Cloudflare Tunnel, ngrok, Codespaces, or any other provider. It only wraps the
provider binary or platform URL so a coding agent can return one clean preview
URL to a user on mobile.

## Install

Run the one-time provider setup from any app directory:

```sh
npx github:pyungjae9492/remote-preview-kit setup
```

It lets you choose `cloudflared` or `ngrok` and installs the selected provider
with Homebrew on macOS. For non-interactive setup:

```sh
npx github:pyungjae9492/remote-preview-kit setup --provider cloudflared --yes
```

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

From your app directory:

```sh
remote-preview --provider cloudflared --public --auth
```

The first non-empty line is the URL:

```txt
https://example.trycloudflare.com
```

If you do not install the binary, run the same command through Node:

```sh
node bin/remote-preview.mjs --provider cloudflared --public --auth
```

When `--port` and `--url` are omitted, the CLI scans common HTTP dev-server
ports such as `5173`, `3000`, `3001`, `4173`, `4321`, `8000`, and `8080`. If no
server responds and the current project has `scripts.dev`, it starts
`npm run dev`, waits for a port to respond, then exposes it. If more than one
dev server is running, pass `--port` or `--url` explicitly.

To customize the scan order:

```sh
REMOTE_PREVIEW_PORTS=3000,5173 remote-preview --provider cloudflared --public
```

For projects without an npm `dev` script, pass the command to start:

```sh
remote-preview --start-cmd "python3 -m http.server 8000" --provider cloudflared --public
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
- Optional token proxy with `--auth` or `--auth-token`.
- Common database and admin ports are blocked by default.
- Codespaces support is read-only and never changes port visibility.

## Usage

Set up a provider:

```sh
remote-preview setup
remote-preview setup --provider ngrok --yes
```

Machine-readable output:

```sh
remote-preview --provider cloudflared --public --auth --json
```

Use a localhost URL instead of a port:

```sh
remote-preview --url http://127.0.0.1:5173 --provider cloudflared --public
```

Protect the public preview with a token:

```sh
remote-preview --provider cloudflared --public --auth
remote-preview --provider cloudflared --public --auth-token "$REMOTE_PREVIEW_TOKEN"
```

`--auth` generates a token and appends it to the returned URL. The first request
sets an HttpOnly cookie and redirects to the same URL without the token query.
Requests without the token or cookie receive `401`. This is link-token access
control, not identity auth; anyone who gets the token URL can use it until you
restart the preview with a new token.

Notify another process:

```sh
remote-preview --provider cloudflared --public \
  --notify-cmd node --notify-arg ./scripts/send-preview.mjs
```

The notifier receives the preview URL in `REMOTE_PREVIEW_URL` and as the final
argv item. The command runs without shell interpolation.

Start a custom dev server when nothing is already running:

```sh
remote-preview --start-cmd "npm run preview" --provider cloudflared --public
```

If the CLI starts the dev server, the JSON output includes `devServerPid` and
the cleanup command includes that process group.

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
remote-preview setup --provider cloudflared --yes
remote-preview --provider cloudflared --public
```

`cloudflared` creates a public Quick Tunnel, so `--public` is required.

### ngrok

```sh
remote-preview setup --provider ngrok --yes
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

1. Run `remote-preview` from the app directory.
2. Pass `--port` when multiple servers are running, or `--start-cmd` when the
   project does not have an npm `dev` script.
3. Prefer `--auth` for public tunnels and return the tokenized `url` field or
   the first stdout line only to the intended reviewer.
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
