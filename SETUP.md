# Claude Token Proxy - Server Setup & Integration Guide

## Prerequisites

- Ubuntu server with Node.js 22+ installed
- Claude CLI installed (`claude` command available)
- Caddy and Tailscale already configured
- Docker apps that need Anthropic API access

## Step 1: Clone and Build

```bash
mkdir -p ~/nexus/infra
cd ~/nexus/infra
git clone https://github.com/afxjzs/claude-token-proxy.git
cd claude-token-proxy
npm install
npm run build
```

## Step 2: Create Claude Credentials

If you haven't already, log in with the Claude CLI to create the credentials file:

```bash
claude auth login
```

This creates `~/.claude/.credentials.json` with your OAuth tokens. Verify it exists:

```bash
ls -la ~/.claude/.credentials.json
```

Lock down permissions:

```bash
chmod 600 ~/.claude/.credentials.json
```

## Step 3: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set your `PROXY_API_KEY`. Generate a random one:

```bash
openssl rand -hex 32
```

```bash
nano ~/nexus/infra/claude-token-proxy/.env
```

## Step 4: Install systemd User Service

No sudo required — this installs as a user-level systemd service:

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/claude-token-proxy.service <<'EOF'
[Unit]
Description=Claude Token Proxy Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/nexus/infra/claude-token-proxy
EnvironmentFile=%h/nexus/infra/claude-token-proxy/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable claude-token-proxy
systemctl --user start claude-token-proxy

# Enable linger so the service runs even when you're not logged in
loginctl enable-linger $USER
```

Check it's running:

```bash
systemctl --user status claude-token-proxy
journalctl --user -u claude-token-proxy -f
```

## Step 5: Verify the Service

```bash
# Health check
curl http://127.0.0.1:3456/health

# Get token (requires PROXY_API_KEY)
curl -H "Authorization: Bearer YOUR_PROXY_API_KEY" http://127.0.0.1:3456/token

# Test a real API call through the proxy
curl -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":50,"messages":[{"role":"user","content":"Say hello"}]}' \
  http://127.0.0.1:3456/v1/messages
```

## Step 6: Configure Caddy (Optional)

Add to your Caddyfile to expose via Tailscale:

```caddy
claude-proxy.YOUR_TAILNET.ts.net {
	reverse_proxy localhost:3456
}
```

Reload Caddy:

```bash
sudo systemctl reload caddy
```

---

## How Your Apps Use the Proxy

### Docker Compose

Add these environment variables and the host mapping to any service that uses the Anthropic SDK:

```yaml
services:
  my-app:
    environment:
      ANTHROPIC_BASE_URL: "http://host.docker.internal:3456"
      ANTHROPIC_API_KEY: "your-proxy-api-key-from-step-3"
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

That's it. The Anthropic SDK reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` automatically. Your app makes normal SDK calls and the proxy:

1. Intercepts the request
2. Replaces the API key with the current valid OAuth token
3. Injects the required `anthropic-beta: oauth-2025-04-20` header
4. Forwards to `api.anthropic.com`
5. Streams the response back (including SSE for streaming calls)
6. Automatically refreshes the OAuth token before it expires

### Node.js / TypeScript Example

```typescript
import Anthropic from "@anthropic-ai/sdk";

// These come from environment variables in Docker Compose
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL, // http://host.docker.internal:3456
  apiKey: process.env.ANTHROPIC_API_KEY,    // your proxy API key
});

const message = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Python Example

```python
from anthropic import Anthropic

# Reads ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY from env automatically
client = Anthropic()

message = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
```

### Raw curl (from inside a container)

```bash
curl -X POST http://host.docker.internal:3456/v1/messages \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hi"}]
  }'
```

### Getting Just the Token

If your app needs the raw OAuth token (e.g., for non-SDK usage):

```bash
curl -H "Authorization: Bearer YOUR_PROXY_API_KEY" http://host.docker.internal:3456/token
# Returns: {"accessToken":"sk-ant-oat01-..."}
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `/health` returns `"status":"error"` | Token expired and refresh failed. Run `claude auth login` again on the server to get a new refresh token. |
| 401 errors through proxy | Check that your `PROXY_API_KEY` matches what's in `~/nexus/infra/claude-token-proxy/.env`. |
| Docker container can't reach proxy | Ensure `extra_hosts: ["host.docker.internal:host-gateway"]` is in your compose file. Test with `curl http://host.docker.internal:3456/health` from inside the container. |
| Refresh token cascade failure | If both access and refresh tokens are dead, the only fix is `claude auth login` on the server. The `/health` endpoint will show this state. |
| Conflict with Claude CLI | Don't run interactive Claude CLI sessions on the same server. The refresh token is single-use — if the CLI consumes it, the proxy's next refresh will fail. |

## Updating

```bash
cd ~/nexus/infra/claude-token-proxy
git pull
npm install
npm run build
systemctl --user restart claude-token-proxy
```
