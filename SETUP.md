# Server Deployment Guide

Step-by-step instructions for deploying Claude Token Proxy as a systemd user service on a Linux server. No root/sudo required.

## Prerequisites

- Linux server (Ubuntu 22.04+ recommended)
- Node.js 22+
- Claude CLI installed and authenticated (`claude auth login` creates `~/.claude/.credentials.json`)

## 1. Clone and Build

```bash
git clone https://github.com/afxjzs/claude-token-proxy.git
cd claude-token-proxy
npm install
npm run build
```

## 2. Configure

```bash
cp .env.example .env
nano .env
```

Set `PROXY_API_KEY` to a random secret:

```bash
openssl rand -hex 32
```

## 3. Install systemd User Service

```bash
mkdir -p ~/.config/systemd/user

cp deploy/claude-token-proxy.service ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable claude-token-proxy
systemctl --user start claude-token-proxy

# Keep the service running even when you log out
loginctl enable-linger $USER
```

> The included service file uses `%h` (home directory) in its paths. If you cloned to a non-standard location, edit the `WorkingDirectory` and `EnvironmentFile` paths in the service file.

## 4. Verify

```bash
# Check service status
systemctl --user status claude-token-proxy

# Health check
curl http://127.0.0.1:3456/health

# Test proxied API call
curl http://127.0.0.1:3456/v1/messages \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":50,"messages":[{"role":"user","content":"Hello"}]}'
```

## 5. Reverse Proxy (Optional)

### Caddy + Tailscale

Add to your Caddyfile:

```caddy
claude-proxy.your-tailnet.ts.net {
    reverse_proxy localhost:3456
}
```

```bash
sudo systemctl reload caddy
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name claude-proxy.your-tailnet.ts.net;

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;              # required for SSE streaming
        proxy_cache off;
    }
}
```

## Docker Integration

Add to any service in your `docker-compose.yml`:

```yaml
services:
  my-app:
    environment:
      ANTHROPIC_BASE_URL: "http://host.docker.internal:3456"
      ANTHROPIC_API_KEY: "your-proxy-api-key"
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

The Anthropic SDK picks up both env vars automatically. No code changes needed.

## Updating

```bash
cd /path/to/claude-token-proxy
git pull
npm install
npm run build
systemctl --user restart claude-token-proxy
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `/health` returns `"status":"error"` | Token expired and refresh failed. Run `claude auth login` on the server to get new tokens. |
| 401 from proxy | Check `PROXY_API_KEY` matches between your `.env` and the client's `ANTHROPIC_API_KEY`. |
| 401 from Anthropic (through proxy) | OAuth token may be invalid. Check `/health`. May need to `claude auth login` again. |
| Docker can't reach proxy | Add `extra_hosts: ["host.docker.internal:host-gateway"]` to your compose file. |
| Refresh token cascade failure | Both tokens dead. Only fix: `claude auth login` on the server. |
| Conflict with Claude CLI | Avoid running interactive Claude CLI sessions on the same server. Refresh tokens are single-use. |
| Service doesn't survive reboot | Run `loginctl enable-linger $USER` to keep user services running without a login session. |
| Logs | `journalctl --user -u claude-token-proxy -f` |
