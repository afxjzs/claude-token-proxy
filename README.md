# Claude Token Proxy

A lightweight reverse proxy that lets you use your **Claude Pro/Max subscription** as an API, with automatic OAuth token management.

## The Problem

Claude Pro and Max subscriptions authenticate via OAuth tokens that expire every ~8 hours. If you're running apps that use the Anthropic SDK (bots, agents, internal tools), they break every time the token expires. You'd need to manually re-authenticate multiple times per day.

## The Solution

Claude Token Proxy sits between your apps and the Anthropic API. It:

1. Reads the OAuth credentials that Claude CLI stores at `~/.claude/.credentials.json`
2. Proactively refreshes tokens 10 minutes before they expire
3. Proxies all `/v1/*` requests to `api.anthropic.com` with valid auth injected
4. Handles the `anthropic-beta: oauth-2025-04-20` header required for OAuth
5. Streams SSE responses without buffering (critical for streaming completions)

Your apps just point the Anthropic SDK at the proxy. No code changes needed beyond setting a base URL.

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│   Your App   │────▶│  Claude Token Proxy  │────▶│  Anthropic API   │
│  (SDK/curl)  │◀────│  :3456               │◀────│  api.anthropic.  │
└──────────────┘     │                     │     │  com             │
                     │  - Token refresh    │     └──────────────────┘
                     │  - Auth injection   │
                     │  - SSE streaming    │     ┌──────────────────┐
                     │                     │────▶│  OAuth endpoint  │
                     └─────────────────────┘◀────│  console.        │
                                                  │  anthropic.com   │
                                                  └──────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 22+
- Claude CLI installed and authenticated (`claude auth login`)

### Install

```bash
git clone https://github.com/afxjzs/claude-token-proxy.git
cd claude-token-proxy
npm install
npm run build
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```bash
PORT=3456
HOST=127.0.0.1
PROXY_API_KEY=          # optional shared secret; generate with: openssl rand -hex 32
REFRESH_MARGIN_SECONDS=600
CHECK_INTERVAL_SECONDS=60
```

### Run

```bash
node dist/index.js
```

### Verify

```bash
# Health check (no auth required)
curl http://localhost:3456/health

# Test a proxied API call
curl http://localhost:3456/v1/messages \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Token status, expiry time, scopes |
| `GET` | `/token` | Yes | Returns the current valid access token |
| `ALL` | `/v1/*` | Yes | Proxies to Anthropic API with OAuth auth injected |

### `GET /health`

```json
{
  "status": "ok",
  "expiresAt": "2025-03-15T05:41:02.871Z",
  "expiresInSeconds": 10770,
  "scopes": ["user:inference", "user:profile"]
}
```

Status is `"ok"`, `"warning"` (token expiring soon, refresh imminent), or `"error"` (token expired, refresh failed).

### `GET /token`

Returns the raw access token for apps that need direct API access without the proxy:

```json
{
  "accessToken": "sk-ant-oat01-..."
}
```

### `ALL /v1/*`

Transparent proxy. Send requests exactly as you would to `api.anthropic.com`. The proxy:

- Strips your `Authorization` and `x-api-key` headers
- Injects `Authorization: Bearer <oauth-token>`
- Adds `anthropic-beta: oauth-2025-04-20` (preserves any existing beta flags)
- Streams the response body directly (no buffering)
- On 401, refreshes the token and retries once

## Connecting Your Apps

### Docker Compose

```yaml
services:
  my-app:
    environment:
      ANTHROPIC_BASE_URL: "http://host.docker.internal:3456"
      ANTHROPIC_API_KEY: "your-proxy-api-key"  # value of PROXY_API_KEY from .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

The Anthropic SDK reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` from the environment automatically. No code changes needed.

### Node.js / TypeScript

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:3456",
  apiKey: "your-proxy-api-key",
});

const message = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Python

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:3456",
    api_key="your-proxy-api-key",
)

message = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
```

## Production Deployment

See [SETUP.md](SETUP.md) for complete deployment instructions including:

- systemd user service (no root required)
- Caddy reverse proxy with Tailscale
- Docker integration details
- Troubleshooting guide

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CREDENTIALS_PATH` | `~/.claude/.credentials.json` | Path to Claude CLI credentials file |
| `PORT` | `3456` | HTTP server port |
| `HOST` | `127.0.0.1` | Bind address |
| `PROXY_API_KEY` | *(empty)* | Shared secret for client auth. If empty, no auth is required. |
| `REFRESH_MARGIN_SECONDS` | `600` | Seconds before expiry to trigger refresh |
| `CHECK_INTERVAL_SECONDS` | `60` | How often the background timer checks token expiry |

## How Token Refresh Works

Claude CLI stores OAuth credentials at `~/.claude/.credentials.json`:

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

The proxy:

1. Loads credentials from disk on startup
2. Runs a background timer every 60s (configurable)
3. When the token is within 10 minutes of expiry, acquires a file lock and refreshes via `POST https://console.anthropic.com/v1/oauth/token`
4. Writes the new tokens back to the credentials file atomically (write to temp file, then rename)
5. File locking (`proper-lockfile`) prevents race conditions if Claude CLI or another process also refreshes

Refresh tokens are **single-use** — once consumed, only the new refresh token is valid. The proxy handles this correctly, but be aware that running Claude CLI interactively on the same machine can cause conflicts.

## Security

- **Binds to localhost only** — not directly accessible from the network
- **Optional shared secret** (`PROXY_API_KEY`) for defense-in-depth
- **Credentials file** should be `chmod 600`
- **Never logs tokens** — only logs expiry times and refresh success/failure
- Designed to sit behind a reverse proxy (Caddy, nginx) with TLS termination
- For remote access, use a private network like Tailscale

## Tech Stack

- [Fastify](https://fastify.dev/) — HTTP server
- [undici](https://undici.nodejs.org/) — HTTP client with streaming support
- [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) — file locking for safe credential updates
- TypeScript, Node.js 22+

## License

MIT
