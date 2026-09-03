import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 15000,
    // Integration tests hit a real local Supabase stack; run them serially to
    // avoid churning the local Postgres instance with concurrent auth admin calls.
    fileParallelism: false,
  },
});
