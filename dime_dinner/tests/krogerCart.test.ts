import { afterEach, describe, expect, it, vi } from "vitest";
import { KrogerError } from "../server/lib/kroger";
import { KrogerAuthRequired } from "../server/lib/krogerAuth";
import {
  addItemsToCart,
  buildCartItem,
  buildCartPayload,
  KROGER_CART_URL,
  MAX_CART_QUANTITY,
  modalitiesFor,
  normalizeUpc,
} from "../server/lib/krogerCart";

const token = async () => "access-token";

function ok(status = 204): Response {
  return new Response(null, { status });
}

function err(status: number): Response {
  return new Response("", { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UPC normalization", () => {
  it("left-pads to the 13 digits Kroger requires", () => {
    expect(normalizeUpc("1234567890")).toBe("0001234567890");
    expect(normalizeUpc("0001111041700")).toBe("0001111041700");
    expect(normalizeUpc("1")).toBe("0000000000001");
  });

  it("strips separators a product feed might carry", () => {
    expect(normalizeUpc("0001111-041700")).toBe("0001111041700");
  });

  it("refuses a value that could not be a UPC", () => {
    for (const bad of ["", "   ", "abc", "12345678901234"]) {
      expect(() => normalizeUpc(bad), JSON.stringify(bad)).toThrow(KrogerError);
    }
  });
});

describe("cart item payload", () => {
  it("sends exactly the three documented fields and nothing else", () => {
    const item = buildCartItem({ upc: "1111041700", quantity: 2, modality: "PICKUP" });
    expect(item).toEqual({ upc: "0001111041700", quantity: 2, modality: "PICKUP" });
    expect(Object.keys(item).sort()).toEqual(["modality", "quantity", "upc"]);
  });

  it("rejects quantities that are not whole numbers in range", () => {
    for (const quantity of [0, -1, 1.5, Number.NaN, MAX_CART_QUANTITY + 1]) {
      expect(() => buildCartItem({ upc: "1111041700", quantity, modality: "PICKUP" }), String(quantity)).toThrow(
        KrogerError,
      );
    }
    expect(buildCartItem({ upc: "1111041700", quantity: MAX_CART_QUANTITY, modality: "PICKUP" }).quantity).toBe(
      MAX_CART_QUANTITY,
    );
  });

  it("rejects a modality the Cart API does not accept", () => {
    for (const modality of ["SHIP", "pickup", "", "ANY"]) {
      expect(
        () => buildCartItem({ upc: "1111041700", quantity: 1, modality: modality as never }),
        modality,
      ).toThrow(KrogerError);
    }
  });

  it("wraps items under an items key and refuses an empty add", () => {
    expect(buildCartPayload([{ upc: "1111041700", quantity: 1, modality: "DELIVERY" }])).toEqual({
      items: [{ upc: "0001111041700", quantity: 1, modality: "DELIVERY" }],
    });
    expect(() => buildCartPayload([])).toThrow(KrogerError);
  });
});

describe("modality availability", () => {
  it("maps the Products API fulfillment flags onto cart modalities", () => {
    expect(modalitiesFor(["curbside", "delivery"])).toEqual(["PICKUP", "DELIVERY"]);
    expect(modalitiesFor(["instore"])).toEqual(["PICKUP"]);
    expect(modalitiesFor(["DELIVERY"])).toEqual(["DELIVERY"]);
    // Ship-to-home is not a cart modality, so it contributes nothing.
    expect(modalitiesFor(["ship"])).toEqual(["PICKUP"]);
    expect(modalitiesFor([])).toEqual(["PICKUP"]);
  });
});

describe("adding items", () => {
  const items = [
    { key: "a", name: "Ground Beef", upc: "1111041700", quantity: 1, modality: "PICKUP" as const },
    { key: "b", name: "Tortillas", upc: "1111041701", quantity: 2, modality: "PICKUP" as const },
  ];

  it("sends one authenticated PUT per item and reports each as confirmed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await addItemsToCart(token, items);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.kroger.com/v1/cart/add");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer access-token");
    expect(JSON.parse(init.body as string)).toEqual({
      items: [{ upc: "0001111041700", quantity: 1, modality: "PICKUP" }],
    });

    expect(outcome.addedCount).toBe(2);
    expect(outcome.failedCount).toBe(0);
    expect(outcome.authExpired).toBe(false);
    expect(outcome.results.map((r) => r.ok)).toEqual([true, true]);
  });

  it("reports a partial failure without claiming the failed item was added", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(err(404)));

    const outcome = await addItemsToCart(token, items);

    expect(outcome.addedCount).toBe(1);
    expect(outcome.failedCount).toBe(1);
    expect(outcome.results[0]).toMatchObject({ key: "a", ok: true });
    expect(outcome.results[1].ok).toBe(false);
    expect(outcome.results[1].error).toMatch(/UPC/i);
    expect(outcome.authExpired).toBe(false);
  });

  it("stops after the grant expires and marks the remainder unattempted", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(err(401));
    vi.stubGlobal("fetch", fetchMock);

    const three = [...items, { key: "c", name: "Cheese", upc: "1111041702", quantity: 1, modality: "PICKUP" as const }];
    const outcome = await addItemsToCart(token, three);

    // The third item is never sent — every later request would fail identically.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.authExpired).toBe(true);
    expect(outcome.addedCount).toBe(1);
    expect(outcome.failedCount).toBe(2);
    expect(outcome.results[2]).toMatchObject({ key: "c", ok: false });
    expect(outcome.results[2].error).toMatch(/not attempted/i);
  });

  it("explains a 403 as a missing Cart API grant", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(err(403)));
    const outcome = await addItemsToCart(token, [items[0]]);
    expect(outcome.addedCount).toBe(0);
    expect(outcome.results[0].error).toMatch(/Cart API/);
    expect(outcome.results[0].error).toMatch(/reconnect/i);
  });

  it("fails just the offending item when its own payload is invalid", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await addItemsToCart(token, [
      { key: "bad", name: "Mystery", upc: "", quantity: 1, modality: "PICKUP" },
      items[0],
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.results[0]).toMatchObject({ key: "bad", ok: false });
    expect(outcome.addedCount).toBe(1);
  });

  it("never sends a token in the URL and points checkout at Kroger", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    await addItemsToCart(token, [items[0]]);
    expect(fetchMock.mock.calls[0][0]).not.toContain("access-token");
    expect(KROGER_CART_URL).toBe("https://www.kroger.com/cart");
  });

  it("surfaces a transport failure as a per-item error rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));
    const outcome = await addItemsToCart(token, [items[0]]);
    expect(outcome.results[0].ok).toBe(false);
    expect(outcome.results[0].error).toMatch(/socket hang up/);
  });

  it("treats a refresh failure while adding as an expired grant", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok()));
    const failing = vi.fn().mockRejectedValue(new KrogerAuthRequired("gone"));
    const outcome = await addItemsToCart(failing, items);
    expect(outcome.authExpired).toBe(true);
    expect(outcome.addedCount).toBe(0);
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
