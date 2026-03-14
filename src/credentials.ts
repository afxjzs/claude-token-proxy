import { readFile, writeFile, rename, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { config } from "./config.js";

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

interface CredentialsFile {
  claudeAiOauth: OAuthCredentials;
}

let cachedToken: OAuthCredentials | null = null;

export function getCachedToken(): OAuthCredentials | null {
  return cachedToken;
}

export function setCachedToken(token: OAuthCredentials): void {
  cachedToken = token;
}

export async function readCredentials(): Promise<OAuthCredentials> {
  const raw = await readFile(config.credentialsPath, "utf-8");
  const data: CredentialsFile = JSON.parse(raw);
  if (!data.claudeAiOauth) {
    throw new Error("Missing claudeAiOauth in credentials file");
  }
  return data.claudeAiOauth;
}

export async function writeCredentials(
  creds: OAuthCredentials
): Promise<void> {
  const dir = dirname(config.credentialsPath);
  const tmpPath = join(dir, `.credentials.tmp.${randomBytes(4).toString("hex")}`);

  // Read existing file to preserve any other keys
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(config.credentialsPath, "utf-8");
    existing = JSON.parse(raw);
  } catch {
    // File may not exist yet
  }

  existing.claudeAiOauth = creds;

  await writeFile(tmpPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, config.credentialsPath);
}

export async function withCredentialsLock<T>(
  fn: () => Promise<T>
): Promise<T> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(config.credentialsPath, {
      retries: { retries: 3, minTimeout: 200, maxTimeout: 1000 },
      stale: 10000,
    });
    return await fn();
  } finally {
    if (release) {
      await release();
    }
  }
}
