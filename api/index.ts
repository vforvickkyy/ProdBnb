// Vercel entrypoint (Phase 13). This is the ONLY thing Vercel-specific in
// this repo -- src/app.ts's createApp() and every route/service underneath
// it are completely unmodified from how they already run on any other Node
// host (`npm run dev`/`npm start` via src/index.ts, unaffected by this
// file's existence).
//
// Deploying an Express app to Vercel works by exporting the app as a
// default export from a recognized entrypoint file -- Vercel wraps the
// whole thing as a single Vercel Function and forwards the raw Node
// (req, res) through to it, so every existing Express behavior (routing,
// middleware order, error handling) is unaffected. This specifically
// includes the raw-body Cashfree webhook route (express.raw() registered
// ahead of express.json() in app.ts) -- verified locally with `vercel dev
// --local` against a real HMAC-signed request before this was relied on.
//
// Not using the "zero-config" auto-detected src/index.ts entrypoint
// (app.listen() there): Vercel's own docs require the recognized file to
// import the `express` package directly, and src/index.ts only imports
// createApp() from ./app -- confirmed empirically ("Error: Can't detect way
// to handle request" from `vercel dev --local` before this file existed).
// src/index.ts is unchanged and still used for local dev / any future
// non-Vercel Node host.
import express from "express";
import { createApp } from "../src/app";

const app: express.Express = createApp();

export default app;
