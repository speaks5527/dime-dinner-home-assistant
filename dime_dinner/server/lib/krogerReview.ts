/**
 * The review step between "build a Kroger cart" and any cart write.
 *
 * A review is deliberately ephemeral: it lives in memory, expires on its own,
 * and is deleted the moment the user confirms or cancels. Nothing Kroger
 * returned about products or the customer's cart is written to disk, which keeps
 * the add-on inside Kroger's terms on caching and means an abandoned review
 * leaves nothing behind.
 */
import crypto from "node:crypto";
import { KrogerError } from "./kroger";
import { CART_MODALITIES, modalitiesFor, type CartModality } from "./krogerCart";
import type { KrogerProduct, KrogerReview, KrogerReviewItem } from "@shared/schema";

const REVIEW_TTL_MS = 30 * 60_000;
const MAX_REVIEWS = 8;
/** Product lookups run a few at a time — responsive without hammering Kroger. */
const MATCH_CONCURRENCY = 3;

/* ------------------------------- matching -------------------------------- */

const STOP_WORDS = new Set(["of", "and", "the", "a", "an", "or", "with", "for", "fresh"]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t));
}

export function priceCentsFor(product: KrogerProduct): number | null {
  const price = product.promoPrice ?? product.regularPrice;
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  return Math.round(price * 100);
}

/**
 * How well a Kroger product corresponds to a grocery line.
 *
 * `coverage` is the share of the grocery line's words the product description
 * accounts for, and it is what decides whether a match is trustworthy at all.
 * `score` only orders candidates that are already fully covered, preferring the
 * plainest description — "Ground Beef" over "Ground Beef Taco Seasoning Kit".
 */
export function scoreCandidate(name: string, product: KrogerProduct): { coverage: number; score: number } {
  const wanted = tokenize(name);
  if (!wanted.length) return { coverage: 0, score: 0 };
  const described = tokenize(`${product.description} ${product.brand ?? ""}`);
  if (!described.length) return { coverage: 0, score: 0 };

  const hits = wanted.filter((token) =>
    described.some((word) => word === token || word.startsWith(token) || token.startsWith(word)),
  );
  const coverage = hits.length / wanted.length;

  // Every word the product carries beyond the ones asked for is a step further
  // from the plain ingredient, so extra words cost score.
  const extras = Math.max(0, described.length - wanted.length);
  let score = coverage * 10 - Math.min(4, extras * 0.5);
  if (priceCentsFor(product) != null) score += 0.5;
  if (product.upc) score += 0.5;
  return { coverage, score };
}

export type Classification = {
  status: "matched" | "ambiguous" | "unmatched";
  ordered: KrogerProduct[];
  selectedUpc: string | null;
};

/**
 * Rank candidates and decide whether one may be pre-selected.
 *
 * A product is only pre-selected when it accounts for every word of the grocery
 * line and has a UPC the Cart API can use. Anything less is returned as
 * "ambiguous" with nothing selected, so a guess can never reach the cart just
 * because the user clicked through quickly.
 */
export function classifyMatch(name: string, candidates: KrogerProduct[]): Classification {
  if (!candidates.length) return { status: "unmatched", ordered: [], selectedUpc: null };

  const scored = candidates
    .map((product) => ({ product, ...scoreCandidate(name, product) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.product.description.length - b.product.description.length ||
        a.product.upc.localeCompare(b.product.upc),
    );

  const ordered = scored.map((s) => s.product);
  const best = scored[0];
  if (best.coverage >= 1 && best.product.upc) {
    return { status: "matched", ordered, selectedUpc: best.product.upc };
  }
  return { status: "ambiguous", ordered, selectedUpc: null };
}

/* -------------------------------- totals --------------------------------- */

function candidateByUpc(item: KrogerReviewItem, upc: string | null): KrogerProduct | null {
  if (!upc) return null;
  return item.candidates.find((c) => c.upc === upc) ?? null;
}

export function selectedProduct(item: KrogerReviewItem): KrogerProduct | null {
  return candidateByUpc(item, item.selectedUpc);
}

/** An item is ready when the user has landed on a product the Cart API can take. */
export function isReady(item: KrogerReviewItem): boolean {
  if (item.status === "skipped") return false;
  const product = selectedProduct(item);
  return !!product?.upc;
}

export function summarize(items: KrogerReviewItem[]): {
  readyCount: number;
  needsAttentionCount: number;
  estimatedSubtotalCents: number;
  estimateIncomplete: boolean;
} {
  let readyCount = 0;
  let needsAttentionCount = 0;
  let estimatedSubtotalCents = 0;
  let estimateIncomplete = false;

  for (const item of items) {
    if (item.status === "skipped") continue;
    if (!isReady(item)) {
      needsAttentionCount += 1;
      continue;
    }
    readyCount += 1;
    const cents = priceCentsFor(selectedProduct(item)!);
    if (cents == null) estimateIncomplete = true;
    else estimatedSubtotalCents += cents * item.quantity;
  }

  return { readyCount, needsAttentionCount, estimatedSubtotalCents, estimateIncomplete };
}

/* ------------------------------- sessions -------------------------------- */

export type ReviewLine = { key: string; name: string; requestedDisplay: string };
export type ProductMatcher = (term: string) => Promise<KrogerProduct[]>;

type Session = Omit<KrogerReview, "readyCount" | "needsAttentionCount" | "estimatedSubtotalCents" | "estimateIncomplete">;

const sessions = new Map<string, Session>();

function prune(now = Date.now()): void {
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

function project(session: Session): KrogerReview {
  return { ...session, items: session.items.map((i) => ({ ...i })), ...summarize(session.items) };
}

function defaultQuantity(): number {
  // Grocery amounts ("3 lb", "2 cups") do not translate into a count of retail
  // packages, so guessing a number would quietly overbuy. One unit each, and
  // the user adjusts what needs adjusting.
  return 1;
}

export async function createReview(input: {
  weekStart: string;
  locationId: string | null;
  locationName: string | null;
  lines: ReviewLine[];
  matcher: ProductMatcher;
  disclaimer: string;
}): Promise<KrogerReview> {
  prune();
  if (!input.lines.length) {
    throw new KrogerError("Every item on this list is either checked off or covered by your pantry.", 400);
  }
  while (sessions.size >= MAX_REVIEWS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }

  const items: KrogerReviewItem[] = new Array(input.lines.length);
  const notices: string[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < input.lines.length) {
      const index = cursor++;
      const line = input.lines[index];
      let candidates: KrogerProduct[] = [];
      try {
        candidates = await input.matcher(line.name);
      } catch (err) {
        notices.push(`${line.name}: ${(err as Error).message}`);
      }
      const { status, ordered, selectedUpc } = classifyMatch(line.name, candidates);
      const chosen = ordered.find((c) => c.upc === selectedUpc) ?? null;
      const availableModalities = chosen ? modalitiesFor(chosen.fulfillment) : [...CART_MODALITIES];
      items[index] = {
        key: line.key,
        name: line.name,
        requestedDisplay: line.requestedDisplay,
        status,
        candidates: ordered,
        selectedUpc,
        quantity: defaultQuantity(),
        modality: availableModalities[0],
        availableModalities,
        allowSubstitutes: true,
        priceUnknown: chosen ? priceCentsFor(chosen) == null : false,
      };
    }
  };

  await Promise.all(Array.from({ length: Math.min(MATCH_CONCURRENCY, input.lines.length) }, worker));

  const session: Session = {
    id: crypto.randomBytes(18).toString("base64url"),
    weekStart: input.weekStart,
    locationId: input.locationId,
    locationName: input.locationName,
    expiresAt: Date.now() + REVIEW_TTL_MS,
    items,
    notices,
    disclaimer: input.disclaimer,
  };
  sessions.set(session.id, session);
  return project(session);
}

function requireSession(id: string): Session {
  prune();
  const session = sessions.get(id);
  if (!session) {
    throw new KrogerError("That cart review has expired. Start a new one from the grocery list.", 404);
  }
  return session;
}

export function getReview(id: string): KrogerReview {
  return project(requireSession(id));
}

export type ItemPatch = {
  selectedUpc?: string | null;
  quantity?: number;
  modality?: CartModality;
  allowSubstitutes?: boolean;
  skipped?: boolean;
  /** extra candidates fetched by an explicit "choose alternative" search */
  addCandidates?: KrogerProduct[];
};

export function patchReviewItem(id: string, key: string, patch: ItemPatch): KrogerReview {
  const session = requireSession(id);
  const item = session.items.find((i) => i.key === key);
  if (!item) throw new KrogerError("That item is not part of this review.", 404);

  if (patch.addCandidates?.length) {
    const known = new Set(item.candidates.map((c) => c.upc));
    for (const candidate of patch.addCandidates) {
      if (candidate.upc && !known.has(candidate.upc)) {
        item.candidates.push(candidate);
        known.add(candidate.upc);
      }
    }
  }

  if (patch.skipped !== undefined) {
    // Un-skipping restores the row to whatever the original match warranted, so
    // a previously ambiguous line goes back to demanding a decision.
    item.status = patch.skipped
      ? "skipped"
      : item.selectedUpc
        ? "matched"
        : item.candidates.length
          ? "ambiguous"
          : "unmatched";
  }

  if (patch.selectedUpc !== undefined) {
    if (patch.selectedUpc === null) {
      item.selectedUpc = null;
      if (item.status !== "skipped") item.status = item.candidates.length ? "ambiguous" : "unmatched";
    } else {
      const product = item.candidates.find((c) => c.upc === patch.selectedUpc);
      if (!product) throw new KrogerError("That product is not one of the options for this item.", 400);
      item.selectedUpc = product.upc;
      if (item.status !== "skipped") item.status = "matched";
      item.availableModalities = modalitiesFor(product.fulfillment);
      if (!item.availableModalities.includes(item.modality)) item.modality = item.availableModalities[0];
      item.priceUnknown = priceCentsFor(product) == null;
    }
  }

  if (patch.quantity !== undefined) item.quantity = patch.quantity;

  if (patch.modality !== undefined) {
    if (!item.availableModalities.includes(patch.modality)) {
      throw new KrogerError(`Kroger does not offer ${patch.modality.toLowerCase()} for that product.`, 400);
    }
    item.modality = patch.modality;
  }

  if (patch.allowSubstitutes !== undefined) item.allowSubstitutes = patch.allowSubstitutes;

  return project(session);
}

export function deleteReview(id: string): void {
  sessions.delete(id);
}

export function resetReviews(): void {
  sessions.clear();
}
