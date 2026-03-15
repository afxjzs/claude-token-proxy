# Claude Token Proxy — Agent Reference

## What This Is

HTTP proxy service that manages Claude OAuth token lifecycle and forwards requests to `api.anthropic.com`. Intended for apps using Claude Pro/Max subscriptions where OAuth tokens expire every ~8h.

## File Map

```
src/
  index.ts          — Fastify server entry point, startup, graceful shutdown
  config.ts         — All env var configuration (PORT, HOST, PROXY_API_KEY, CREDENTIALS_PATH, etc.)
  credentials.ts    — Read/write ~/.claude/.credentials.json with file locking (proper-lockfile), atomic writes
  refresh.ts        — OAuth token refresh logic, background timer, in-memory token cache
  proxy.ts          — Forwards /v1/* requests to api.anthropic.com, injects Bearer auth + anthropic-beta header, streams responses, retries on 401
  routes.ts         — Route definitions: GET /health, GET /token, ALL /v1/*
  middleware.ts     — Optional bearer token auth gate (PROXY_API_KEY)
deploy/
  claude-token-proxy.service  — systemd user service unit file
  Caddyfile.snippet           — Caddy reverse proxy example
```

## Key Implementation Details

- OAuth tokens are refreshed via `POST https://console.anthropic.com/v1/oauth/token` with `client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e` and `grant_type=refresh_token`.
- Refresh tokens are single-use. After refresh, the old refresh token is invalid.
- The proxy injects `anthropic-beta: oauth-2025-04-20` header on all proxied requests. Without this header, the Anthropic API rejects OAuth tokens with "OAuth authentication is currently not supported."
- Credentials file is locked with `proper-lockfile` during refresh to prevent race conditions with Claude CLI or other processes.
- Writes are atomic: write to temp file, `chmod 600`, rename over original.
- Body parsing is disabled for proxy routes — raw request streams are piped directly to undici for SSE compatibility.
- Background timer checks token expiry every `CHECK_INTERVAL_SECONDS` (default 60s). Refreshes when within `REFRESH_MARGIN_SECONDS` of expiry (default 600s / 10 min).

## API Endpoints

### GET /health (no auth)
Returns: `{ status: "ok"|"warning"|"error", expiresAt: ISO8601, expiresInSeconds: number, scopes: string[] }`

### GET /token (auth required if PROXY_API_KEY set)
Returns: `{ accessToken: "sk-ant-oat01-..." }`

### ALL /v1/* (auth required if PROXY_API_KEY set)
Transparent proxy to `api.anthropic.com`. Strips incoming auth headers, injects OAuth Bearer token and beta header. Streams response body directly.

## Environment Variables

| Variable | Default | Required |
|----------|---------|----------|
| `CREDENTIALS_PATH` | `~/.claude/.credentials.json` | No |
| `PORT` | `3456` | No |
| `HOST` | `127.0.0.1` | No |
| `PROXY_API_KEY` | *(empty = no auth)* | Recommended |
| `REFRESH_MARGIN_SECONDS` | `600` | No |
| `CHECK_INTERVAL_SECONDS` | `60` | No |

## Credentials File Format

Located at `~/.claude/.credentials.json` (created by `claude auth login`):

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1748276587173,
    "scopes": ["user:inference", "user:profile"]
  }
}
```

## Build & Run

```bash
npm install && npm run build && node dist/index.js
```

## Common Tasks

### Deploy as systemd user service
```bash
cp deploy/claude-token-proxy.service ~/.config/systemd/user/
# Edit WorkingDirectory and EnvironmentFile paths if not at ~/claude-token-proxy
systemctl --user daemon-reload && systemctl --user enable --now claude-token-proxy
loginctl enable-linger $USER
```

### Client integration (any Anthropic SDK)
Set two env vars:
```
ANTHROPIC_BASE_URL=http://localhost:3456
ANTHROPIC_API_KEY=<value-of-PROXY_API_KEY>
```

### Docker client integration
Add to docker-compose.yml service:
```yaml
environment:
  ANTHROPIC_BASE_URL: "http://host.docker.internal:3456"
  ANTHROPIC_API_KEY: "<PROXY_API_KEY>"
extra_hosts:
  - "host.docker.internal:host-gateway"
```

### Token refresh failed / dead tokens
Run `claude auth login` on the host to generate fresh credentials. The proxy picks them up automatically.

## Dependencies

- `fastify` — HTTP server
- `undici` — HTTP client (streaming support for SSE proxy)
- `proper-lockfile` — file locking for credential writes
- `pino` — logging (built into Fastify)
- Node.js 22+ (uses top-level await, ESM)
