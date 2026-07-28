import { beforeEach, describe, expect, it, vi } from "vitest";
import { KrogerError } from "../server/lib/kroger";
import {
  classifyMatch,
  createReview,
  deleteReview,
  getReview,
  isReady,
  patchReviewItem,
  priceCentsFor,
  resetReviews,
  summarize,
} from "../server/lib/krogerReview";
import type { KrogerProduct } from "@shared/schema";

function product(overrides: Partial<KrogerProduct> & { upc: string; description: string }): KrogerProduct {
  return {
    productId: overrides.upc,
    brand: null,
    size: null,
    imageUrl: null,
    regularPrice: 4.99,
    promoPrice: null,
    aisle: null,
    fulfillment: ["curbside", "delivery"],
    stockLevel: null,
    soldBy: null,
    ...overrides,
  };
}

const DISCLAIMER = "Prices are estimates from Kroger.";

async function review(lines: { key: string; name: string }[], matches: Record<string, KrogerProduct[]>) {
  return createReview({
    weekStart: "2026-07-27",
    locationId: "01400376",
    locationName: "Test Store",
    lines: lines.map((l) => ({ ...l, requestedDisplay: "1 lb" })),
    matcher: async (term) => matches[term] ?? [],
    disclaimer: DISCLAIMER,
  });
}

beforeEach(() => {
  resetReviews();
});

describe("price extraction", () => {
  it("prefers a promo price and ignores unusable ones", () => {
    expect(priceCentsFor(product({ upc: "1", description: "x", regularPrice: 4.99, promoPrice: 3.5 }))).toBe(350);
    expect(priceCentsFor(product({ upc: "1", description: "x", regularPrice: 4.99 }))).toBe(499);
    expect(priceCentsFor(product({ upc: "1", description: "x", regularPrice: null }))).toBeNull();
    expect(priceCentsFor(product({ upc: "1", description: "x", regularPrice: 0 }))).toBeNull();
  });
});

describe("match classification", () => {
  it("pre-selects only a product that accounts for the whole line", () => {
    const beef = product({ upc: "0001111041700", description: "Ground Beef" });
    const kit = product({ upc: "0001111041701", description: "Ground Beef Taco Seasoning Kit" });
    const result = classifyMatch("ground beef", [kit, beef]);
    expect(result.status).toBe("matched");
    expect(result.selectedUpc).toBe(beef.upc);
    // The plainer description wins the ordering.
    expect(result.ordered[0].description).toBe("Ground Beef");
  });

  it("selects nothing when no candidate covers the line", () => {
    const result = classifyMatch("smoked paprika", [product({ upc: "0001", description: "Paprika Ground" })]);
    expect(result.status).toBe("ambiguous");
    expect(result.selectedUpc).toBeNull();
    expect(result.ordered).toHaveLength(1);
  });

  it("selects nothing when the best cover has no UPC the cart can use", () => {
    const result = classifyMatch("ground beef", [product({ upc: "", description: "Ground Beef" })]);
    expect(result.status).toBe("ambiguous");
    expect(result.selectedUpc).toBeNull();
  });

  it("reports no candidates as unmatched", () => {
    expect(classifyMatch("saffron", [])).toEqual({ status: "unmatched", ordered: [], selectedUpc: null });
  });
});

describe("totals", () => {
  it("multiplies each selected price by its quantity and flags gaps", async () => {
    const state = await review(
      [
        { key: "a", name: "ground beef" },
        { key: "b", name: "tortillas" },
      ],
      {
        "ground beef": [product({ upc: "0001111041700", description: "Ground Beef", regularPrice: 5 })],
        tortillas: [product({ upc: "0001111041701", description: "Tortillas", regularPrice: 2.5 })],
      },
    );
    expect(state.readyCount).toBe(2);
    expect(state.needsAttentionCount).toBe(0);
    expect(state.estimatedSubtotalCents).toBe(750);
    expect(state.estimateIncomplete).toBe(false);

    const bumped = patchReviewItem(state.id, "a", { quantity: 3 });
    expect(bumped.estimatedSubtotalCents).toBe(1750);
  });

  it("marks the estimate incomplete when a chosen product has no price", async () => {
    const state = await review([{ key: "a", name: "ground beef" }], {
      "ground beef": [product({ upc: "0001111041700", description: "Ground Beef", regularPrice: null })],
    });
    expect(state.readyCount).toBe(1);
    expect(state.estimateIncomplete).toBe(true);
    expect(state.estimatedSubtotalCents).toBe(0);
    expect(state.items[0].priceUnknown).toBe(true);
  });

  it("counts an undecided line as needing attention and a skipped one as neither", () => {
    const base = {
      key: "a",
      name: "saffron",
      requestedDisplay: "1 pinch",
      candidates: [],
      selectedUpc: null,
      quantity: 1,
      modality: "PICKUP" as const,
      availableModalities: ["PICKUP" as const],
      allowSubstitutes: true,
      priceUnknown: false,
    };
    expect(summarize([{ ...base, status: "unmatched" }])).toMatchObject({ readyCount: 0, needsAttentionCount: 1 });
    expect(summarize([{ ...base, status: "skipped" }])).toMatchObject({ readyCount: 0, needsAttentionCount: 0 });
    expect(isReady({ ...base, status: "unmatched" })).toBe(false);
  });
});

describe("review sessions", () => {
  it("matches every line, defaults each to one unit, and keeps nothing on disk", async () => {
    const state = await review(
      [
        { key: "a", name: "ground beef" },
        { key: "manual:7", name: "paper towels" },
      ],
      {
        "ground beef": [product({ upc: "0001111041700", description: "Ground Beef" })],
        "paper towels": [product({ upc: "0001111041702", description: "Paper Towels" })],
      },
    );

    expect(state.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(state.items.map((i) => i.key)).toEqual(["a", "manual:7"]);
    expect(state.items.every((i) => i.quantity === 1)).toBe(true);
    expect(state.locationName).toBe("Test Store");
    expect(state.disclaimer).toBe(DISCLAIMER);
    expect(state.expiresAt).toBeGreaterThan(Date.now());
  });

  it("records a lookup failure as a notice instead of failing the whole review", async () => {
    const state = await createReview({
      weekStart: "2026-07-27",
      locationId: null,
      locationName: null,
      lines: [{ key: "a", name: "ground beef", requestedDisplay: "1 lb" }],
      matcher: async () => {
        throw new Error("Kroger is rate limiting this account");
      },
      disclaimer: DISCLAIMER,
    });
    expect(state.notices[0]).toMatch(/rate limiting/);
    expect(state.items[0].status).toBe("unmatched");
    expect(state.needsAttentionCount).toBe(1);
  });

  it("refuses to open a review with nothing to buy", async () => {
    await expect(review([], {})).rejects.toThrow(KrogerError);
  });

  it("limits an item's modalities to what its product offers", async () => {
    const state = await review([{ key: "a", name: "ground beef" }], {
      "ground beef": [product({ upc: "0001111041700", description: "Ground Beef", fulfillment: ["instore"] })],
    });
    expect(state.items[0].availableModalities).toEqual(["PICKUP"]);
    expect(() => patchReviewItem(state.id, "a", { modality: "DELIVERY" })).toThrow(KrogerError);
    expect(patchReviewItem(state.id, "a", { modality: "PICKUP" }).items[0].modality).toBe("PICKUP");
  });
});

describe("editing a review", () => {
  it("accepts an alternative that is one of the item's own candidates", async () => {
    const state = await review([{ key: "a", name: "ground beef" }], {
      "ground beef": [
        product({ upc: "0001111041700", description: "Ground Beef" }),
        product({ upc: "0001111041701", description: "Ground Beef Chuck 80/20", regularPrice: 7.99 }),
      ],
    });

    const patched = patchReviewItem(state.id, "a", { selectedUpc: "0001111041701" });
    expect(patched.items[0].selectedUpc).toBe("0001111041701");
    expect(patched.estimatedSubtotalCents).toBe(799);
  });

  it("refuses a product the user was never shown", async () => {
    const state = await review([{ key: "a", name: "ground beef" }], {
      "ground beef": [product({ upc: "0001111041700", description: "Ground Beef" })],
    });
    expect(() => patchReviewItem(state.id, "a", { selectedUpc: "0009999999999" })).toThrow(KrogerError);
    expect(getReview(state.id).items[0].selectedUpc).toBe("0001111041700");
  });

  it("adds candidates from an explicit alternative search without duplicating them", async () => {
    const state = await review([{ key: "a", name: "smoked paprika" }], {
      "smoked paprika": [product({ upc: "0001", description: "Paprika Ground" })],
    });
    const extra = product({ upc: "0002", description: "Smoked Paprika Spice" });
    const first = patchReviewItem(state.id, "a", { addCandidates: [extra] });
    expect(first.items[0].candidates).toHaveLength(2);
    const second = patchReviewItem(state.id, "a", { addCandidates: [extra] });
    expect(second.items[0].candidates).toHaveLength(2);
    // Newly offered candidates are still not selected for the user.
    expect(second.items[0].selectedUpc).toBeNull();
    expect(second.needsAttentionCount).toBe(1);
  });

  it("clearing a selection puts the line back to needing a decision", async () => {
    const state = await review([{ key: "a", name: "ground beef" }], {
      "ground beef": [product({ upc: "0001111041700", description: "Ground Beef" })],
    });
    const cleared = patchReviewItem(state.id, "a", { selectedUpc: null });
    expect(cleared.items[0].status).toBe("ambiguous");
    expect(cleared.readyCount).toBe(0);
    expect(cleared.needsAttentionCount).toBe(1);
  });

  it("skipping removes a line from both counts and un-skipping restores its state", async () => {
    const state = await review([{ key: "a", name: "saffron" }], { saffron: [] });
    expect(state.needsAttentionCount).toBe(1);

    const skipped = patchReviewItem(state.id, "a", { skipped: true });
    expect(skipped.items[0].status).toBe("skipped");
    expect(skipped.needsAttentionCount).toBe(0);
    expect(skipped.readyCount).toBe(0);

    const restored = patchReviewItem(state.id, "a", { skipped: false });
    expect(restored.items[0].status).toBe("unmatched");
    expect(restored.needsAttentionCount).toBe(1);
  });

  it("keeps the allow-substitutes preference on the item", async () => {
    const state = await review([{ key: "a", name: "ground beef" }], {
      "ground beef": [product({ upc: "0001111041700", description: "Ground Beef" })],
    });
    expect(state.items[0].allowSubstitutes).toBe(true);
    expect(patchReviewItem(state.id, "a", { allowSubstitutes: false }).items[0].allowSubstitutes).toBe(false);
  });

  it("rejects an item key that is not part of the review", async () => {
    const state = await review([{ key: "a", name: "ground beef" }], {
      "ground beef": [product({ upc: "0001111041700", description: "Ground Beef" })],
    });
    expect(() => patchReviewItem(state.id, "nope", { quantity: 2 })).toThrow(KrogerError);
  });
});

describe("review lifetime", () => {
  it("is gone once deleted, so a confirmed cart cannot be replayed", async () => {
    const state = await review([{ key: "a", name: "ground beef" }], {
      "ground beef": [product({ upc: "0001111041700", description: "Ground Beef" })],
    });
    deleteReview(state.id);
    expect(() => getReview(state.id)).toThrow(KrogerError);
  });

  it("expires on its own so abandoned reviews leave nothing behind", async () => {
    const state = await review([{ key: "a", name: "ground beef" }], {
      "ground beef": [product({ upc: "0001111041700", description: "Ground Beef" })],
    });
    vi.setSystemTime(new Date(Date.now() + 31 * 60_000));
    try {
      expect(() => getReview(state.id)).toThrow(/expired/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an id it never issued", () => {
    expect(() => getReview("fabricated")).toThrow(KrogerError);
  });
});
