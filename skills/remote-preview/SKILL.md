---
name: remote-preview
description: Use when a remote coding session needs to expose a running localhost dev server so a user can review it from mobile Codex, Claude, Telegram Hermes, or another external browser without a production deployment. Wraps existing providers such as Codespaces forwarded ports, cloudflared, and ngrok while enforcing public-preview safety checks.
---

# Remote Preview

Use this skill when the user needs to view a local dev server from outside the
remote coding environment.

## Workflow

1. Confirm the app's dev server is already running. The CLI auto-detects common
   HTTP dev-server ports when `--port` and `--url` are omitted.
2. Prefer private platform forwarding when available:
   ```sh
   remote-preview --provider codespaces --json
   ```
3. For public review URLs, require explicit public intent:
   ```sh
   remote-preview --provider cloudflared --public --json
   ```
4. If multiple dev servers are running, pass the intended `--port` or `--url`.
5. Return only the preview URL to the user unless they need diagnostics.
6. Record the cleanup command or PID in your task notes.

## Safety Rules

- Do not expose database, admin, Supabase Studio, mailhog, or service ports
  unless the user explicitly requests it and `--allow-risky-port` is required.
- Do not add `--public` silently. Public tunnels are visible to anyone with the
  URL.
- Do not read or store provider tokens, Telegram bot tokens, `.env` files,
  cookies, or application secrets.
- Codespaces support is read-only. Do not run `gh codespace ports visibility`
  automatically.

## Agent Output

Use `--json` for automation. The success object includes:

```json
{"ok":true,"provider":"cloudflared","url":"https://example.trycloudflare.com","port":5173,"public":true,"pid":1234,"cleanup":"kill 1234"}
```

For Telegram Hermes-style notification hooks, pass the URL through
`REMOTE_PREVIEW_URL`:

```sh
remote-preview --provider cloudflared --public \
  --notify-cmd node --notify-arg ./scripts/send-preview.mjs
```

The command runs without shell interpolation.
