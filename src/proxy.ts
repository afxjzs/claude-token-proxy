import { request } from "undici";
import type { FastifyRequest, FastifyReply } from "fastify";
import { config } from "./config.js";
import { ensureValidToken, refreshToken } from "./refresh.js";

export async function proxyRequest(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const url = req.url; // e.g. /v1/messages
  const targetUrl = `${config.anthropicApiBase}${url}`;

  const makeRequest = async (token: string) => {
    const headers: Record<string, string> = {};

    // Forward relevant headers
    for (const [key, value] of Object.entries(req.headers)) {
      if (
        key === "host" ||
        key === "connection" ||
        key === "authorization" ||
        key === "x-api-key" ||
        key === "transfer-encoding"
      ) {
        continue;
      }
      if (typeof value === "string") {
        headers[key] = value;
      }
    }

    // Inject auth
    headers["authorization"] = `Bearer ${token}`;
    headers["x-api-key"] = token;

    return request(targetUrl, {
      method: req.method as any,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.raw : undefined,
    });
  };

  let token = await ensureValidToken();
  let response = await makeRequest(token);

  // Retry once on 401 after refreshing
  if (response.statusCode === 401) {
    req.log.warn("Got 401 from Anthropic, refreshing token and retrying...");
    try {
      const newCreds = await refreshToken();
      token = newCreds.accessToken;
      response = await makeRequest(token);
    } catch (err) {
      req.log.error({ err }, "Token refresh on 401 retry failed");
    }
  }

  // Set response status and headers
  reply.status(response.statusCode);

  for (const [key, value] of Object.entries(response.headers)) {
    if (
      key === "transfer-encoding" ||
      key === "connection" ||
      key === "keep-alive"
    ) {
      continue;
    }
    if (value !== undefined) {
      reply.header(key, value);
    }
  }

  // Stream the response body directly (important for SSE)
  return reply.send(response.body);
}
