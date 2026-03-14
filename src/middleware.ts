import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from "fastify";
import { config } from "./config.js";

export function authMiddleware(
  req: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  if (!config.proxyApiKey) {
    return done();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    reply.status(401).send({ error: "Missing Authorization header" });
    return;
  }

  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (token !== config.proxyApiKey) {
    reply.status(403).send({ error: "Invalid API key" });
    return;
  }

  done();
}
