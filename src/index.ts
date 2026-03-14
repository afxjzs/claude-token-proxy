import Fastify from "fastify";
import { config } from "./config.js";
import { registerRoutes } from "./routes.js";
import {
  setLogger,
  loadInitialToken,
  startRefreshTimer,
  stopRefreshTimer,
} from "./refresh.js";

const app = Fastify({
  logger: {
    level: "info",
  },
  // Disable body parsing for proxy routes - we stream raw bodies
  bodyLimit: 10 * 1024 * 1024,
});

setLogger(app.log);

// Disable default body parsing for /v1/* routes so we can stream
app.removeAllContentTypeParsers();
app.addContentTypeParser("*", function (_req, payload, done) {
  done(null, payload);
});

await registerRoutes(app);

// Graceful shutdown
const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down...");
  stopRefreshTimer();
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

try {
  await loadInitialToken();
  startRefreshTimer();
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Claude Token Proxy listening on ${config.host}:${config.port}`
  );
} catch (err) {
  app.log.fatal(err);
  process.exit(1);
}
