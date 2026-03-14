import type { FastifyInstance } from "fastify";
import { getCachedToken } from "./credentials.js";
import { ensureValidToken, isTokenExpired, isTokenExpiringSoon } from "./refresh.js";
import { proxyRequest } from "./proxy.js";
import { authMiddleware } from "./middleware.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_req, reply) => {
    const token = getCachedToken();
    const now = Date.now();

    if (!token) {
      return reply.status(503).send({
        status: "error",
        message: "No token loaded",
      });
    }

    const expired = isTokenExpired();
    const expiringSoon = isTokenExpiringSoon();

    return reply.send({
      status: expired ? "error" : expiringSoon ? "warning" : "ok",
      expiresAt: new Date(token.expiresAt).toISOString(),
      expiresInSeconds: Math.max(0, Math.round((token.expiresAt - now) / 1000)),
      scopes: token.scopes,
    });
  });

  app.get("/token", { preHandler: authMiddleware }, async (_req, reply) => {
    const accessToken = await ensureValidToken();
    return reply.send({ accessToken });
  });

  // Proxy all /v1/* requests to Anthropic
  app.all("/v1/*", { preHandler: authMiddleware }, proxyRequest);
}
