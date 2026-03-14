# Claude Token Proxy - Server Setup & Integration Guide

## Prerequisites

- Ubuntu server with Node.js 22+ installed
- Claude CLI installed (`claude` command available)
- Caddy and Tailscale already configured
- Docker apps that need Anthropic API access

## Step 1: Clone and Build

```bash
cd /opt
sudo git clone https://github.com/afxjzs/anthropic-oauth-token-manager.git claude-token-proxy
sudo chown -R $USER:$USER /opt/claude-token-proxy
cd /opt/claude-token-proxy
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
cp .env.example /etc/claude-token-proxy/env
sudo mkdir -p /etc/claude-token-proxy
sudo tee /etc/claude-token-proxy/env > /dev/null <<'EOF'
PORT=3456
HOST=127.0.0.1
PROXY_API_KEY=CHANGE_ME_TO_A_RANDOM_SECRET
REFRESH_MARGIN_SECONDS=600
CHECK_INTERVAL_SECONDS=60
EOF
```

Generate a random key for `PROXY_API_KEY`:

```bash
openssl rand -hex 32
```

Edit the file and paste the key:

```bash
sudo nano /etc/claude-token-proxy/env
```

## Step 4: Install systemd Service

```bash
# Copy the service file, replacing %i with your username
sudo cp /opt/claude-token-proxy/deploy/claude-token-proxy.service /etc/systemd/system/claude-token-proxy.service

# Edit the service file to set your actual username and add the env file
sudo tee /etc/systemd/system/claude-token-proxy.service > /dev/null <<EOF
[Unit]
Description=Claude Token Proxy Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
EnvironmentFile=/etc/claude-token-proxy/env
WorkingDirectory=/opt/claude-token-proxy
ExecStart=$(which node) dist/index.js
Restart=always
RestartSec=5

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$HOME/.claude
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable claude-token-proxy
sudo systemctl start claude-token-proxy
```

Check it's running:

```bash
sudo systemctl status claude-token-proxy
journalctl -u claude-token-proxy -f
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
3. Forwards to `api.anthropic.com`
4. Streams the response back (including SSE for streaming calls)
5. Automatically refreshes the OAuth token before it expires

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
| 401 errors through proxy | Check that your `PROXY_API_KEY` matches what's in `/etc/claude-token-proxy/env`. |
| Docker container can't reach proxy | Ensure `extra_hosts: ["host.docker.internal:host-gateway"]` is in your compose file. Test with `curl http://host.docker.internal:3456/health` from inside the container. |
| Refresh token cascade failure | If both access and refresh tokens are dead, the only fix is `claude auth login` on the server. The `/health` endpoint will show this state. |
| Conflict with Claude CLI | Don't run interactive Claude CLI sessions on the same server. The refresh token is single-use — if the CLI consumes it, the proxy's next refresh will fail. |

## Updating

```bash
cd /opt/claude-token-proxy
git pull
npm install
npm run build
sudo systemctl restart claude-token-proxy
```
