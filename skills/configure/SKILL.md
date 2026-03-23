---
name: configure
description: Authenticate with Stumpy — opens browser for OAuth sign-in, saves token. Use when the user asks to configure Stumpy, sign in, authenticate, or when join_team fails with "no token configured."
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(mkdir *)
  - Bash(chmod *)
  - Bash(open *)
  - Bash(bun *)
---

# /stumpy:configure — Stumpy Channel Setup

Authenticates with Stumpy via browser OAuth and saves the token. The server
reads `~/.claude/channels/stumpy/.env` at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and auth

1. **Check token** — read `~/.claude/channels/stumpy/.env` for `STUMPY_TOKEN`.

   - **If set**: show first 8 chars masked (`a1b2c3d4...`). Say "Token configured.
     If it's expired (90-day lifetime), run `/stumpy:configure login` to
     re-authenticate."
   - **If not set**: say "No token configured. Run `/stumpy:configure login` to
     authenticate with Stumpy."

### `login` — browser OAuth flow

Run the auth flow:

1. `mkdir -p ~/.claude/channels/stumpy`

2. Start a temporary HTTP server to receive the OAuth callback. Use this
   inline bun script:

   ```bash
   bun -e "
   const server = Bun.serve({
     port: 0,
     async fetch(req) {
       const url = new URL(req.url);
       if (url.pathname === '/callback') {
         const token = url.searchParams.get('token');
         if (token) {
           console.log('TOKEN:' + token);
           setTimeout(() => server.stop(), 100);
           return new Response('<html><body><h2>Authenticated with Stumpy!</h2><p>You can close this tab.</p></body></html>', { headers: { 'content-type': 'text/html' } });
         }
         return new Response('missing token', { status: 400 });
       }
       return new Response('not found', { status: 404 });
     }
   });
   console.log('PORT:' + server.port);
   "
   ```

   This prints `PORT:<number>` immediately, then `TOKEN:<hex>` when the
   callback arrives. Run it in the background.

3. Open the browser:
   ```bash
   open "https://stumpy.ai/auth/channel?callback_uri=http://localhost:PORT/callback"
   ```

4. Wait for the bun process to output `TOKEN:...` (it exits after receiving
   the callback). Parse the token from stdout.

5. Read existing `.env` if present; update/add the `STUMPY_TOKEN=` line,
   preserve other keys. Write back, no quotes around the value.

6. `chmod 600 ~/.claude/channels/stumpy/.env` — the token is a credential.

7. Confirm: "Authenticated! Token saved. The server will pick it up on next
   start — run `/reload-plugins` or restart the session."

### `<token>` — save token directly

If `$ARGUMENTS` looks like a hex string (32+ hex chars), treat it as a token:

1. `mkdir -p ~/.claude/channels/stumpy`
2. Read existing `.env` if present; update/add `STUMPY_TOKEN=` line.
3. Write back, `chmod 600`.
4. Confirm and show status.

### `clear` — remove the token

Delete the `STUMPY_TOKEN=` line (or the file if that's the only line).

---

## Implementation notes

- The channels dir might not exist yet. Missing file = not configured.
- The server reads `.env` once at boot. Token changes need `/reload-plugins`
  or a session restart.
- Tokens are 64 hex chars, valid for 90 days.
- The OAuth callback server must listen on localhost only (Stumpy validates
  the callback hostname).
