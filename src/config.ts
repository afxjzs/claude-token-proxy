import { homedir } from "node:os";
import { resolve } from "node:path";

export const config = {
  credentialsPath: resolve(
    (process.env.CREDENTIALS_PATH || "~/.claude/.credentials.json").replace(
      /^~/,
      homedir()
    )
  ),
  port: parseInt(process.env.PORT || "3456", 10),
  host: process.env.HOST || "127.0.0.1",
  proxyApiKey: process.env.PROXY_API_KEY || "",
  refreshMarginMs:
    parseInt(process.env.REFRESH_MARGIN_SECONDS || "600", 10) * 1000,
  checkIntervalMs:
    parseInt(process.env.CHECK_INTERVAL_SECONDS || "60", 10) * 1000,
  anthropicApiBase: "https://api.anthropic.com",
  oauthTokenUrl: "https://console.anthropic.com/v1/oauth/token",
  oauthClientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
} as const;
