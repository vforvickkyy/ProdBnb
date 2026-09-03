import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

const app = createApp();

describe("authentication", () => {
  it("allows unauthenticated access to /health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: "ok" } });
  });

  it("rejects /v1/me with no Authorization header", async () => {
    const res = await request(app).get("/v1/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects /v1/me with a malformed Authorization header", async () => {
    const res = await request(app).get("/v1/me").set("Authorization", "not-a-bearer-token");
    expect(res.status).toBe(401);
  });

  it("rejects /v1/me with a garbage bearer token", async () => {
    const res = await request(app).get("/v1/me").set("Authorization", "Bearer garbage.token.value");
    expect(res.status).toBe(401);
  });

  it("returns a JSON 404 envelope for unknown routes", async () => {
    const res = await request(app).get("/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
