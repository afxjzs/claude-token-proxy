import { request } from "undici";
import { config } from "./config.js";
import {
  readCredentials,
  writeCredentials,
  withCredentialsLock,
  setCachedToken,
  getCachedToken,
  type OAuthCredentials,
} from "./credentials.js";
import type { FastifyBaseLogger } from "fastify";

let logger: FastifyBaseLogger;

export function setLogger(log: FastifyBaseLogger): void {
  logger = log;
}

export function isTokenExpiringSoon(): boolean {
  const token = getCachedToken();
  if (!token) return true;
  return Date.now() >= token.expiresAt - config.refreshMarginMs;
}

export function isTokenExpired(): boolean {
  const token = getCachedToken();
  if (!token) return true;
  return Date.now() >= token.expiresAt;
}

async function doRefresh(refreshToken: string): Promise<OAuthCredentials> {
  const { statusCode, body } = await request(config.oauthTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.oauthClientId,
    }),
  });

  const responseText = await body.text();

  if (statusCode !== 200) {
    throw new Error(
      `OAuth refresh failed (${statusCode}): ${responseText}`
    );
  }

  const data = JSON.parse(responseText);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope ? data.scope.split(" ") : ["user:inference", "user:profile"],
  };
}

export async function refreshToken(): Promise<OAuthCredentials> {
  return withCredentialsLock(async () => {
    // Re-read from disk in case another process refreshed
    const current = await readCredentials();

    // If token on disk is still fresh, just use it
    if (Date.now() < current.expiresAt - config.refreshMarginMs) {
      logger?.info(
        { expiresAt: new Date(current.expiresAt).toISOString() },
        "Token on disk is still fresh after lock acquisition"
      );
      setCachedToken(current);
      return current;
    }

    logger?.info("Refreshing OAuth token...");
    const newCreds = await doRefresh(current.refreshToken);

    await writeCredentials(newCreds);
    setCachedToken(newCreds);

    logger?.info(
      { expiresAt: new Date(newCreds.expiresAt).toISOString() },
      "Token refreshed successfully"
    );

    return newCreds;
  });
}

export async function ensureValidToken(): Promise<string> {
  let token = getCachedToken();

  if (!token) {
    // First load from disk
    const creds = await readCredentials();
    setCachedToken(creds);
    token = creds;
  }

  if (isTokenExpiringSoon()) {
    token = await refreshToken();
  }

  return token.accessToken;
}

export async function loadInitialToken(): Promise<void> {
  const creds = await readCredentials();
  setCachedToken(creds);
  logger?.info(
    { expiresAt: new Date(creds.expiresAt).toISOString() },
    "Loaded credentials from disk"
  );

  if (isTokenExpiringSoon()) {
    await refreshToken();
  }
}

let refreshInterval: ReturnType<typeof setInterval> | null = null;

export function startRefreshTimer(): void {
  refreshInterval = setInterval(async () => {
    try {
      if (isTokenExpiringSoon()) {
        await refreshToken();
      }
    } catch (err) {
      logger?.error({ err }, "Background token refresh failed");
    }
  }, config.checkIntervalMs);
}

export function stopRefreshTimer(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
