import { createApp } from "./app";
import { env } from "./config/env";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`ProdBnb backend listening on port ${env.PORT} (${env.NODE_ENV})`);
});

// Platforms like Render send SIGTERM before stopping/replacing an instance
// (e.g. during a deploy) and expect the process to exit on its own shortly
// after -- without this, in-flight requests at that exact moment get cut.
// server.close() stops accepting NEW connections immediately but lets
// already-open ones finish; the 10s cap is a backstop against a request
// that never finishes (e.g. a hung upstream call) blocking shutdown
// forever, not a normal-case timeout.
const SHUTDOWN_TIMEOUT_MS = 10_000;

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log("All connections closed, exiting.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error(`Shutdown did not complete within ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
