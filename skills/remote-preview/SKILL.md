---
name: remote-preview
description: Use when a remote coding session needs to expose a running localhost dev server so a user can review it from mobile Codex, Claude, Telegram Hermes, or another external browser without a production deployment. Wraps existing providers such as Codespaces forwarded ports, cloudflared, and ngrok while enforcing public-preview safety checks.
---

# Remote Preview

Use this skill when the user needs to view a local dev server from outside the
remote coding environment.

## Workflow

1. If the provider is missing, run `remote-preview setup` or
   `remote-preview setup --provider cloudflared --yes`.
2. Run from the app directory. The CLI auto-detects common HTTP dev-server
   ports when `--port` and `--url` are omitted. If no server responds and
   `package.json` has `scripts.dev`, it starts the package manager's dev
   script (`pnpm run dev`, `npm run dev`, `yarn run dev`, or `bun run dev`).
3. Prefer the default one-command path:
   ```sh
   remote-preview --json
   ```
4. If a public tunnel is not acceptable, refuse public fallback:
   ```sh
   remote-preview --private --json
   ```
5. If multiple dev servers are running, pass the intended `--port` or `--url`.
   If the project has no package `dev` script, pass `--start-cmd`.
6. Token protection is on by default with one token redemption. Use
   `--auth-uses <count>` for multiple reviewers, or `--auth-token` for a
   caller-supplied token.
7. Record the cleanup command or PID in your task notes.

## Safety Rules

- Do not expose database, admin, Supabase Studio, mailhog, or service ports
  unless the user explicitly requests it and `--allow-risky-port` is required.
- Public tunnels are visible to anyone who can redeem the URL. Keep the
  tokenized URL scoped to the intended reviewer.
- Token auth is link-token access control, not identity auth. Anyone who
  redeems the token before the usage limit is exhausted can use that browser
  session until the preview is restarted.
- Do not read or store provider tokens, Telegram bot tokens, `.env` files,
  cookies, or application secrets.
- Codespaces support is read-only. Do not run `gh codespace ports visibility`
  automatically.

## Agent Output

Use `--json` for automation. The success object includes:

```json
{"ok":true,"provider":"cloudflared","url":"https://example.trycloudflare.com/?remote_preview_token=secret","port":5173,"public":true,"auth":true,"authUses":1,"pid":1234,"cleanup":"kill 1234"}
```

For Telegram Hermes-style notification hooks, pass the URL through
`REMOTE_PREVIEW_URL`:

```sh
remote-preview --notify-cmd node --notify-arg ./scripts/send-preview.mjs
```

The command runs without shell interpolation.

For custom dev-server commands:

```sh
remote-preview --start-cmd "npm run preview" --json
```
