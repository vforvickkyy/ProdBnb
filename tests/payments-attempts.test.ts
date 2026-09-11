import { afterEach, describe, expect, it, vi } from "vitest";

// Phase 26-H.9D -- attempt-level enrichment, exercised against the REAL CashfreeProvider.
//
// `fetch` is stubbed rather than the adapter mocked, so the actual mapping, ordering, selection
// and fallback code runs. No network, no Cashfree call, no order created.
//
// The invariant every test here defends: an order the provider still reports as ACTIVE must never
// become a terminal ProdBnb status because one *attempt* against it failed. `failed` is terminal,
// and Cashfree explicitly allows another attempt inside the same order -- so the naive mapping
// would permanently lock out a later success on that order.

import { CashfreeProvider } from "../src/modules/payments/providers/CashfreeProvider";

const ORDER_ID = "pb_attempttest0000000000000000000";

interface StubCall {
  url: string;
  method: string;
}

/** Records every outbound call and replies from a scripted map of path-suffix -> response. */
function stubFetch(routes: { order: unknown; orderStatus?: number; attempts?: unknown; attemptsStatus?: number }) {
  const calls: StubCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method ?? "GET") });
    const isAttempts = String(url).endsWith("/payments");
    if (isAttempts) {
      return {
        ok: (routes.attemptsStatus ?? 200) < 400,
        status: routes.attemptsStatus ?? 200,
        json: async () => {
          if (routes.attempts === "MALFORMED") throw new SyntaxError("Unexpected token");
          return routes.attempts;
        },
      } as unknown as Response;
    }
    return {
      ok: (routes.orderStatus ?? 200) < 400,
      status: routes.orderStatus ?? 200,
      json: async () => routes.order,
    } as unknown as Response;
  });
  return calls;
}

function order(order_status: string, extra: Record<string, unknown> = {}) {
  return {
    order_id: ORDER_ID,
    cf_order_id: "cf_order_1",
    order_status,
    order_amount: 75.0, // 7500 minor units
    order_currency: "INR",
    payment_session_id: "session_token",
    ...extra,
  };
}

function attempt(
  payment_status: string,
  opts: { id?: string; time?: string | null; amount?: number | null; currency?: string | null } = {}
) {
  return {
    cf_payment_id: opts.id ?? `cf_pay_${payment_status}`,
    payment_status,
    payment_amount: opts.amount === undefined ? 75.0 : opts.amount,
    payment_currency: opts.currency === undefined ? "INR" : opts.currency,
    payment_time: opts.time === undefined ? "2026-09-11T09:34:02+05:30" : opts.time,
    payment_group: "debit_card",
    // Instrument/gateway detail the provider really returns -- must never survive the projection.
    payment_method: { card: { card_number: "411111XXXXXX1111", card_bank_name: "HDFC" } },
    payment_gateway_details: { gateway_name: "SOMEBANK", gateway_payment_id: "gw_1" },
    authorization: { action: "CAPTURE" },
    bank_reference: "BANKREF123",
    auth_id: "AUTH123",
    error_details: { error_code: "CARD_DECLINED", error_description: "Issuer declined" },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Phase 26-H.9D: attempt-level enrichment", () => {
  describe("when the attempts endpoint is consulted", () => {
    it("is NOT called for an order whose status already answers the question", async () => {
      for (const status of ["PAID", "EXPIRED", "TERMINATED", "TERMINATION_REQUESTED"]) {
        const calls = stubFetch({ order: order(status), attempts: [] });
        await new CashfreeProvider().fetchOrder(ORDER_ID);
        expect(calls.filter((c) => c.url.endsWith("/payments"))).toHaveLength(0);
        vi.unstubAllGlobals();
      }
    });

    it("IS called for an ACTIVE order, which is the only ambiguous case", async () => {
      const calls = stubFetch({ order: order("ACTIVE"), attempts: [] });
      await new CashfreeProvider().fetchOrder(ORDER_ID);
      expect(calls.filter((c) => c.url.endsWith("/payments"))).toHaveLength(1);
    });
  });

  describe("order-level mapping is unchanged", () => {
    it.each([
      ["PAID", "success"],
      ["EXPIRED", "failed"],
      ["TERMINATED", "cancelled"],
      ["TERMINATION_REQUESTED", "cancelled"],
    ])("%s stays %s", async (orderStatus, expected) => {
      stubFetch({ order: order(orderStatus) });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);
      expect(result.status).toBe(expected);
    });
  });

  describe("ACTIVE order + one attempt", () => {
    it("SUCCESS is surfaced as a settling attempt", async () => {
      stubFetch({ order: order("ACTIVE"), attempts: [attempt("SUCCESS")] });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);

      expect(result.status).toBe("pending"); // order level is untouched
      expect(result.settledAttempt?.status).toBe("success");
      expect(result.settledAttempt?.amountMinorUnits).toBe(7500);
      expect(result.settledAttempt?.currency).toBe("INR");
    });

    it.each([
      ["FAILED", "failed"],
      ["USER_DROPPED", "dropped"],
      ["CANCELLED", "cancelled"],
      ["VOID", "void"],
    ])("%s is advisory ONLY and never settles or terminates", async (raw, mapped) => {
      stubFetch({ order: order("ACTIVE"), attempts: [attempt(raw)] });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);

      // The whole point of 9D: still pending, still resumable.
      expect(result.status).toBe("pending");
      expect(result.settledAttempt ?? null).toBeNull();
      expect(result.lastAttempt?.status).toBe(mapped);
    });

    it("PENDING is advisory and stays pending", async () => {
      stubFetch({ order: order("ACTIVE"), attempts: [attempt("PENDING")] });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);
      expect(result.status).toBe("pending");
      expect(result.settledAttempt ?? null).toBeNull();
      expect(result.lastAttempt?.status).toBe("pending");
    });

    it("NOT_ATTEMPTED yields no misleading advisory", async () => {
      stubFetch({ order: order("ACTIVE"), attempts: [attempt("NOT_ATTEMPTED")] });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);
      expect(result.status).toBe("pending");
      expect(result.lastAttempt ?? null).toBeNull();
    });

    it("an undocumented status maps to unknown and settles nothing", async () => {
      stubFetch({ order: order("ACTIVE"), attempts: [attempt("SOME_FUTURE_STATUS")] });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);
      expect(result.status).toBe("pending");
      expect(result.settledAttempt ?? null).toBeNull();
      expect(result.lastAttempt ?? null).toBeNull(); // no advisory invented from a value we don't know
    });

    it("an empty attempts array is just pending", async () => {
      stubFetch({ order: order("ACTIVE"), attempts: [] });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);
      expect(result.status).toBe("pending");
      expect(result.settledAttempt ?? null).toBeNull();
      expect(result.lastAttempt ?? null).toBeNull();
    });
  });

  describe("multiple attempts", () => {
    const older = "2026-09-11T09:00:00+05:30";
    const newer = "2026-09-11T10:00:00+05:30";

    it("old FAILED + new SUCCESS -> success", async () => {
      stubFetch({
        order: order("ACTIVE"),
        attempts: [attempt("FAILED", { id: "a", time: older }), attempt("SUCCESS", { id: "b", time: newer })],
      });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);
      expect(result.settledAttempt?.id).toBe("b");
    });

    it("old SUCCESS + newer PENDING -> still success (money already moved)", async () => {
      stubFetch({
        order: order("ACTIVE"),
        attempts: [attempt("SUCCESS", { id: "paid", time: older }), attempt("PENDING", { id: "later", time: newer })],
      });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);
      expect(result.settledAttempt?.id).toBe("paid");
    });

    it("old SUCCESS + newer FAILED -> still success", async () => {
      stubFetch({
        order: order("ACTIVE"),
        attempts: [attempt("SUCCESS", { id: "paid", time: older }), attempt("FAILED", { id: "later", time: newer })],
      });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);
      expect(result.settledAttempt?.id).toBe("paid");
    });

    it("FAILED + PENDING -> pending, advised by the pending attempt", async () => {
      stubFetch({
        order: order("ACTIVE"),
        attempts: [attempt("FAILED", { id: "f", time: older }), attempt("PENDING", { id: "p", time: newer })],
      });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);
      expect(result.settledAttempt ?? null).toBeNull();
      expect(result.lastAttempt?.id).toBe("p");
    });

    it("several FAILED -> advised by the newest", async () => {
      stubFetch({
        order: order("ACTIVE"),
        attempts: [attempt("FAILED", { id: "old", time: older }), attempt("FAILED", { id: "new", time: newer })],
      });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);
      expect(result.lastAttempt?.id).toBe("new");
    });

    it("several PENDING -> advised by the newest", async () => {
      stubFetch({
        order: order("ACTIVE"),
        attempts: [attempt("PENDING", { id: "old", time: older }), attempt("PENDING", { id: "new", time: newer })],
      });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);
      expect(result.lastAttempt?.id).toBe("new");
    });

    it("the result is identical however the provider ordered the array", async () => {
      // Cashfree does not document the array's ordering, so nothing may depend on it.
      const a = attempt("FAILED", { id: "f", time: older });
      const b = attempt("SUCCESS", { id: "s", time: "2026-09-11T09:30:00+05:30" });
      const c = attempt("PENDING", { id: "p", time: newer });

      const results: (string | null | undefined)[] = [];
      for (const arrangement of [
        [a, b, c],
        [c, a, b],
        [b, c, a],
        [c, b, a],
      ]) {
        stubFetch({ order: order("ACTIVE"), attempts: arrangement });
        const result = await new CashfreeProvider().fetchOrder(ORDER_ID);
        results.push(result.settledAttempt?.id);
        vi.unstubAllGlobals();
      }
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe("s");
    });

    it("equal timestamps resolve deterministically rather than by array position", async () => {
      const same = "2026-09-11T09:34:02+05:30";
      const forward = [attempt("FAILED", { id: "aaa", time: same }), attempt("FAILED", { id: "zzz", time: same })];

      stubFetch({ order: order("ACTIVE"), attempts: forward });
      const first = await new CashfreeProvider().fetchOrder(ORDER_ID);
      vi.unstubAllGlobals();

      stubFetch({ order: order("ACTIVE"), attempts: [...forward].reverse() });
      const second = await new CashfreeProvider().fetchOrder(ORDER_ID);

      expect(first.lastAttempt?.id).toBe(second.lastAttempt?.id);
    });

    it("attempts with missing timestamps never outrank dated ones", async () => {
      stubFetch({
        order: order("ACTIVE"),
        attempts: [attempt("FAILED", { id: "undated", time: null }), attempt("FAILED", { id: "dated", time: newer })],
      });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);
      expect(result.lastAttempt?.id).toBe("dated");
    });
  });

  describe("attempts endpoint failure is best-effort", () => {
    it.each([
      ["a 5xx", { attempts: { message: "boom" }, attemptsStatus: 500 }],
      ["malformed JSON", { attempts: "MALFORMED" as const }],
      ["a non-array body", { attempts: { not: "an array" } }],
    ])("falls back to order-level state on %s", async (_label, routes) => {
      stubFetch({ order: order("ACTIVE"), ...routes });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);

      // Exactly the pre-9D behaviour: the verification still succeeds, and the optional
      // enrichment fields are simply absent.
      expect(result.status).toBe("pending");
      expect(result.settledAttempt).toBeUndefined();
      expect(result.lastAttempt).toBeUndefined();
      expect(result.checkout).toMatchObject({ order_id: ORDER_ID });
    });

    it("a failing ORDER read still throws, as before", async () => {
      stubFetch({ order: { message: "nope" }, orderStatus: 500 });
      await expect(new CashfreeProvider().fetchOrder(ORDER_ID)).rejects.toThrow(/Cashfree API error/);
    });
  });

  describe("data minimisation", () => {
    it("keeps only the reduced projection -- no instrument, gateway or banking detail", async () => {
      stubFetch({ order: order("ACTIVE"), attempts: [attempt("FAILED")] });
      const result = await new CashfreeProvider().fetchOrder(ORDER_ID);

      const serialized = JSON.stringify(result.lastAttempt);
      for (const forbidden of [
        "card_number",
        "411111",
        "card_bank_name",
        "payment_method",
        "payment_gateway_details",
        "gateway_payment_id",
        "authorization",
        "BANKREF123",
        "AUTH123",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }

      // ...while keeping what reconciliation genuinely needs.
      expect(result.lastAttempt).toMatchObject({
        id: "cf_pay_FAILED",
        status: "failed",
        rawStatus: "FAILED",
        amountMinorUnits: 7500,
        currency: "INR",
        method: "debit_card",
        errorCode: "CARD_DECLINED",
      });
    });
  });
});
