/**
 * The confirmation guard, exercised through the real HTTP route.
 *
 * Nothing may reach Kroger's cart without an explicit confirmation that names
 * the same number of items the user was shown, so this drives the actual Express
 * app rather than the helpers underneath it. The app is imported dynamically
 * because the route module opens the SQLite database at import time.
 *
 * The test client speaks node:http on purpose: `fetch` is stubbed to stand in
 * for Kroger, and using it here too would make the two indistinguishable.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KrogerProduct } from "@shared/schema";

let dir: string;
let server: http.Server;
let baseUrl: string;

let createReview: typeof import("../server/lib/krogerReview")["createReview"];
let getReview: typeof import("../server/lib/krogerReview")["getReview"];
let patchReviewItem: typeof import("../server/lib/krogerReview")["patchReviewItem"];
let resetReviews: typeof import("../server/lib/krogerReview")["resetReviews"];
let saveTokens: typeof import("../server/lib/krogerTokens")["saveTokens"];
let clearTokens: typeof import("../server/lib/krogerTokens")["clearTokens"];
let resetTokenCache: typeof import("../server/lib/krogerTokens")["resetTokenCache"];
let CUSTOMER_SCOPE_STRING: string;

type Reply = { status: number; body: any };

function request(method: string, url: string, payload?: unknown): Promise<Reply> {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${url}`,
      {
        method,
        headers: body
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
          : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed: any = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* a non-JSON body is reported as-is */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function product(overrides: Partial<KrogerProduct> & { upc: string; description: string }): KrogerProduct {
  return {
    productId: overrides.upc,
    brand: null,
    size: null,
    imageUrl: null,
    regularPrice: 5,
    promoPrice: null,
    aisle: null,
    fulfillment: ["curbside", "delivery"],
    stockLevel: null,
    soldBy: null,
    ...overrides,
  };
}

const CATALOG: Record<string, KrogerProduct[]> = {
  "ground beef": [product({ upc: "0001111041700", description: "Ground Beef" })],
  tortillas: [product({ upc: "0001111041701", description: "Tortillas", regularPrice: 2.5 })],
  saffron: [],
};

async function openReview(names: string[]) {
  return createReview({
    weekStart: "2026-07-27",
    locationId: "01400376",
    locationName: "Test Store",
    lines: names.map((name, i) => ({ key: `k${i}`, name, requestedDisplay: "1 lb" })),
    matcher: async (term) => CATALOG[term] ?? [],
    disclaimer: "Prices are estimates.",
  });
}

function connect(): void {
  saveTokens({
    accessToken: "access-token",
    accessExpiresAt: Date.now() + 30 * 60_000,
    refreshToken: "refresh-token",
    refreshExpiresAt: null,
    scope: CUSTOMER_SCOPE_STRING,
    connectedAt: Date.now(),
  });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dime-confirm-"));
  process.env.DIME_DINNER_DB = path.join(dir, "test.db");
  process.env.DIME_DINNER_KROGER_TOKENS = path.join(dir, "kroger-oauth.json");
  process.env.DIME_DINNER_OPTIONS = path.join(dir, "options.json");
  fs.writeFileSync(
    process.env.DIME_DINNER_OPTIONS,
    JSON.stringify({
      kroger_enabled: true,
      kroger_client_id: "test-client",
      kroger_client_secret: "test-secret",
      kroger_location_id: "01400376",
    }),
  );

  const { default: express } = await import("express");
  const { registerRoutes } = await import("../server/routes");
  const review = await import("../server/lib/krogerReview");
  createReview = review.createReview;
  getReview = review.getReview;
  patchReviewItem = review.patchReviewItem;
  resetReviews = review.resetReviews;
  const tokens = await import("../server/lib/krogerTokens");
  saveTokens = tokens.saveTokens;
  clearTokens = tokens.clearTokens;
  resetTokenCache = tokens.resetTokenCache;
  CUSTOMER_SCOPE_STRING = (await import("../server/lib/krogerAuth")).CUSTOMER_SCOPE_STRING;

  const app = express();
  app.use(express.json());
  server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.DIME_DINNER_DB;
  delete process.env.DIME_DINNER_KROGER_TOKENS;
  delete process.env.DIME_DINNER_OPTIONS;
});

beforeEach(() => {
  resetReviews();
  clearTokens();
  resetTokenCache();
  connect();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function cartOk() {
  return vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
}

describe("the confirmation guard", () => {
  it("refuses a request that does not carry the explicit confirmation", async () => {
    const review = await openReview(["ground beef"]);
    const fetchMock = cartOk();
    vi.stubGlobal("fetch", fetchMock);

    for (const payload of [{}, { itemCount: 1 }, { confirm: false, itemCount: 1 }, { confirm: "yes", itemCount: 1 }]) {
      const res = await request("POST", `/api/kroger/cart/review/${review.id}/confirm`, payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    // The review survives a refused confirmation, so the user can try again.
    expect(getReview(review.id).readyCount).toBe(1);
  });

  it("refuses when the count the user saw disagrees with the list", async () => {
    const review = await openReview(["ground beef", "tortillas"]);
    const fetchMock = cartOk();
    vi.stubGlobal("fetch", fetchMock);

    const res = await request("POST", `/api/kroger/cart/review/${review.id}/confirm`, { confirm: true, itemCount: 1 });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/changed since you reviewed it/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses while any item still needs a product chosen or skipped", async () => {
    const review = await openReview(["ground beef", "saffron"]);
    expect(review.needsAttentionCount).toBe(1);
    const fetchMock = cartOk();
    vi.stubGlobal("fetch", fetchMock);

    const res = await request("POST", `/api/kroger/cart/review/${review.id}/confirm`, { confirm: true, itemCount: 1 });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/needs a product chosen or skipped/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds nothing when everything was skipped", async () => {
    const review = await openReview(["ground beef"]);
    patchReviewItem(review.id, "k0", { skipped: true });
    const fetchMock = cartOk();
    vi.stubGlobal("fetch", fetchMock);

    const res = await request("POST", `/api/kroger/cart/review/${review.id}/confirm`, { confirm: true, itemCount: 1 });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds exactly the confirmed items once the count agrees", async () => {
    const review = await openReview(["ground beef", "tortillas"]);
    patchReviewItem(review.id, "k1", { quantity: 3, modality: "DELIVERY" });
    const fetchMock = cartOk();
    vi.stubGlobal("fetch", fetchMock);

    const res = await request("POST", `/api/kroger/cart/review/${review.id}/confirm`, { confirm: true, itemCount: 2 });

    expect(res.status).toBe(200);
    expect(res.body.addedCount).toBe(2);
    expect(res.body.failedCount).toBe(0);
    expect(res.body.cartUrl).toBe("https://www.kroger.com/cart");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sent = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string).items[0]);
    expect(sent).toEqual([
      { upc: "0001111041700", quantity: 1, modality: "PICKUP" },
      { upc: "0001111041701", quantity: 3, modality: "DELIVERY" },
    ]);
  });

  it("cannot be replayed once something reached the cart", async () => {
    const review = await openReview(["ground beef"]);
    const fetchMock = cartOk();
    vi.stubGlobal("fetch", fetchMock);

    expect((await request("POST", `/api/kroger/cart/review/${review.id}/confirm`, { confirm: true, itemCount: 1 })).status).toBe(200);
    const replay = await request("POST", `/api/kroger/cart/review/${review.id}/confirm`, { confirm: true, itemCount: 1 });

    expect(replay.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a partial failure honestly and keeps the review for a retry", async () => {
    const review = await openReview(["ground beef", "tortillas"]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response("", { status: 404 })),
    );

    const res = await request("POST", `/api/kroger/cart/review/${review.id}/confirm`, { confirm: true, itemCount: 2 });

    expect(res.status).toBe(200);
    expect(res.body.addedCount).toBe(1);
    expect(res.body.failedCount).toBe(1);
    expect(res.body.results[0]).toMatchObject({ key: "k0", ok: true });
    expect(res.body.results[1]).toMatchObject({ key: "k1", ok: false });
    expect(res.body.results[1].error).toMatch(/UPC/i);
  });

  it("leaves the review intact when the whole run failed", async () => {
    const review = await openReview(["ground beef"]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 429 })));

    const res = await request("POST", `/api/kroger/cart/review/${review.id}/confirm`, { confirm: true, itemCount: 1 });

    expect(res.body.addedCount).toBe(0);
    expect(res.body.failedCount).toBe(1);
    // Nothing was added, so retrying cannot double anything up.
    expect(getReview(review.id).readyCount).toBe(1);
  });

  it("passes an allow-substitutes preference on as a checkout reminder", async () => {
    const review = await openReview(["ground beef"]);
    patchReviewItem(review.id, "k0", { allowSubstitutes: false });
    vi.stubGlobal("fetch", cartOk());

    const res = await request("POST", `/api/kroger/cart/review/${review.id}/confirm`, { confirm: true, itemCount: 1 });

    expect(res.body.noSubstitutionReminders).toEqual(["ground beef"]);
  });

  it("refuses every cart route without a connected Kroger account", async () => {
    const review = await openReview(["ground beef"]);
    clearTokens();
    const fetchMock = cartOk();
    vi.stubGlobal("fetch", fetchMock);

    const confirm = await request("POST", `/api/kroger/cart/review/${review.id}/confirm`, {
      confirm: true,
      itemCount: 1,
    });
    expect(confirm.status).toBe(401);

    const build = await request("POST", "/api/kroger/cart/review", { weekStart: "2026-07-27" });
    expect(build.status).toBe(401);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to write a cart when the grant lacks the cart scope", async () => {
    const review = await openReview(["ground beef"]);
    saveTokens({
      accessToken: "access-token",
      accessExpiresAt: Date.now() + 30 * 60_000,
      refreshToken: null,
      refreshExpiresAt: null,
      scope: "product.compact",
      connectedAt: Date.now(),
    });
    const fetchMock = cartOk();
    vi.stubGlobal("fetch", fetchMock);

    const res = await request("POST", `/api/kroger/cart/review/${review.id}/confirm`, { confirm: true, itemCount: 1 });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Cart API/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("what the account routes expose", () => {
  it("reports connection status without ever returning a token", async () => {
    const res = await request("GET", "/api/kroger/auth/status");
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.hasCartScope).toBe(true);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("access-token");
    expect(serialized).not.toContain("refresh-token");
    expect(serialized).not.toContain("test-secret");
  });

  it("hands back a consent URL built entirely from server configuration", async () => {
    const res = await request("POST", "/api/kroger/auth/start");
    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizeUrl);
    expect(url.searchParams.get("redirect_uri")).toBe("http://homeassistant.local:8099/api/kroger/oauth/callback");
    expect(url.searchParams.get("scope")).toBe("product.compact cart.basic:write");
    expect(res.body.authorizeUrl).not.toContain("test-secret");
  });

  it("forgets the grant on disconnect", async () => {
    expect((await request("POST", "/api/kroger/auth/disconnect")).body.auth.connected).toBe(false);
    expect((await request("GET", "/api/kroger/auth/status")).body.connected).toBe(false);
  });

  it("does not let a request choose where the token exchange goes", async () => {
    // The consent URL is server-built; a caller-supplied redirect is simply not
    // part of the contract, and the URL comes back unchanged.
    const res = await request("POST", "/api/kroger/auth/start", { redirectUri: "https://evil.example.com/steal" });
    expect(new URL(res.body.authorizeUrl).searchParams.get("redirect_uri")).toBe(
      "http://homeassistant.local:8099/api/kroger/oauth/callback",
    );
  });
});
