import { createApp } from "./app";
import { env } from "./config/env";

// Local dev / any traditional persistent-process Node host only (`npm run
// dev`, `npm start`). NOT what runs on Vercel -- api/index.ts is Vercel's
// entrypoint, which imports createApp() directly and exports the app for
// Vercel's own Function wrapper to invoke; it never calls .listen() and
// this file's SIGTERM/SIGINT handling below never executes in that context.
// Kept exactly as-is here because it's still correct and useful for local
// dev (e.g. Ctrl-C exits cleanly) and for any non-Vercel Node host, and
// removing it would provide no benefit -- it simply isn't reachable code
// from Vercel's perspective, not code that would misbehave there.
const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`ProdBnb backend listening on port ${env.PORT} (${env.NODE_ENV})`);
});

// Graceful shutdown for a persistent process -- SIGTERM before stopping/
// replacing an instance, expecting the process to exit on its own shortly
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
