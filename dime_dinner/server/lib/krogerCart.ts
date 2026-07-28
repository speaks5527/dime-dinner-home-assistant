/**
 * Kroger public Cart API client.
 *
 * `PUT /v1/cart/add` is the only cart endpoint on the public API. It answers
 * 204 with an empty body and reports nothing about individual items, so this
 * module sends one item per request: a grocery list is a few dozen items at
 * most, and the alternative — batching, then guessing which member of a failed
 * batch was at fault — would mean either reporting failures for items that were
 * added or re-sending items that already went through.
 */
import { KrogerError } from "./kroger";
import { KrogerAuthRequired } from "./krogerAuth";

const CART_ADD_URL = "https://api.kroger.com/v1/cart/add";

/**
 * The public Cart API accepts these two and nothing else. Ship-to-home appears
 * in the Products API's fulfillment flags but is not a cart modality.
 */
export const CART_MODALITIES = ["PICKUP", "DELIVERY"] as const;
export type CartModality = (typeof CART_MODALITIES)[number];

export const MAX_CART_QUANTITY = 99;
/** Kroger rejects a UPC that is not exactly 13 characters. */
const UPC_LENGTH = 13;

export type CartItemInput = {
  upc: string;
  quantity: number;
  modality: CartModality;
};

export type CartItemPayload = {
  upc: string;
  quantity: number;
  modality: CartModality;
};

export function isCartModality(value: unknown): value is CartModality {
  return typeof value === "string" && (CART_MODALITIES as readonly string[]).includes(value);
}

/** Left-pad to the 13 digits Kroger requires, rejecting anything that cannot be one. */
export function normalizeUpc(raw: string): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) throw new KrogerError("That product has no UPC, so it cannot be added to a cart.", 400);
  if (digits.length > UPC_LENGTH) {
    throw new KrogerError(`"${raw}" is not a valid Kroger UPC.`, 400);
  }
  return digits.padStart(UPC_LENGTH, "0");
}

/** Validate and normalize one item into exactly the shape Kroger documents. */
export function buildCartItem(input: CartItemInput): CartItemPayload {
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_CART_QUANTITY) {
    throw new KrogerError(`Quantity must be a whole number between 1 and ${MAX_CART_QUANTITY}.`, 400);
  }
  if (!isCartModality(input.modality)) {
    throw new KrogerError(`Modality must be one of ${CART_MODALITIES.join(" or ")}.`, 400);
  }
  return { upc: normalizeUpc(input.upc), quantity: input.quantity, modality: input.modality };
}

/** The exact request body for a single-item add. */
export function buildCartPayload(items: CartItemInput[]): { items: CartItemPayload[] } {
  if (!items.length) throw new KrogerError("There is nothing to add to the cart.", 400);
  return { items: items.map(buildCartItem) };
}

/**
 * Translate which fulfillment flags the Products API returned into the cart
 * modalities that are actually selectable for that product.
 */
export function modalitiesFor(fulfillment: string[]): CartModality[] {
  const flags = new Set(fulfillment.map((f) => f.toLowerCase()));
  const out: CartModality[] = [];
  if (flags.has("curbside") || flags.has("instore")) out.push("PICKUP");
  if (flags.has("delivery")) out.push("DELIVERY");
  // A product the API reported no fulfillment for still has to be addable
  // somehow; pickup is the Cart API's own default.
  return out.length ? out : ["PICKUP"];
}

export type CartAddResult = {
  /** grocery line key, echoed so the UI can attribute the outcome */
  key: string;
  name: string;
  upc: string;
  quantity: number;
  modality: CartModality;
  ok: boolean;
  /** present only when ok is false */
  error?: string;
};

export type CartAddOutcome = {
  results: CartAddResult[];
  addedCount: number;
  failedCount: number;
  /** true when the run stopped early because the customer grant became unusable */
  authExpired: boolean;
};

type AddRequest = CartItemInput & { key: string; name: string };

async function putCartAdd(accessToken: string, payload: { items: CartItemPayload[] }): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(CART_ADD_URL, {
      method: "PUT",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new KrogerError(`Could not reach Kroger: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 204 || res.status === 200) return;
  if (res.status === 401) throw new KrogerAuthRequired("Your Kroger sign-in expired mid-way through.");
  if (res.status === 403) {
    throw new KrogerError(
      "Kroger refused the cart write. Enable the Cart API on your Kroger application, then reconnect your account so the cart.basic:write scope is granted.",
      403,
    );
  }
  if (res.status === 400) throw new KrogerError("Kroger rejected this product for the cart.", 400);
  if (res.status === 404) throw new KrogerError("Kroger does not recognize that UPC.", 404);
  if (res.status === 429) throw new KrogerError("Kroger is rate limiting this account — try again shortly.", 429);
  throw new KrogerError(`Kroger cart request failed (HTTP ${res.status}).`);
}

/**
 * Add each item in turn, recording what Kroger actually confirmed. An expired
 * grant aborts the remainder — every later request would fail the same way —
 * and the untried items come back as failures so nothing is reported as added
 * that was not.
 */
export async function addItemsToCart(
  getAccessToken: () => Promise<string>,
  items: AddRequest[],
): Promise<CartAddOutcome> {
  const results: CartAddResult[] = [];
  let authExpired = false;

  for (const item of items) {
    if (authExpired) {
      results.push({
        key: item.key,
        name: item.name,
        upc: item.upc,
        quantity: item.quantity,
        modality: item.modality,
        ok: false,
        error: "Not attempted — the Kroger sign-in expired part-way through.",
      });
      continue;
    }

    let payload: { items: CartItemPayload[] };
    try {
      payload = buildCartPayload([item]);
    } catch (err) {
      results.push({
        key: item.key,
        name: item.name,
        upc: item.upc,
        quantity: item.quantity,
        modality: item.modality,
        ok: false,
        error: (err as Error).message,
      });
      continue;
    }

    try {
      await putCartAdd(await getAccessToken(), payload);
      results.push({
        key: item.key,
        name: item.name,
        upc: payload.items[0].upc,
        quantity: item.quantity,
        modality: item.modality,
        ok: true,
      });
    } catch (err) {
      if (err instanceof KrogerAuthRequired) authExpired = true;
      results.push({
        key: item.key,
        name: item.name,
        upc: payload.items[0].upc,
        quantity: item.quantity,
        modality: item.modality,
        ok: false,
        error: (err as Error).message,
      });
    }
  }

  return {
    results,
    addedCount: results.filter((r) => r.ok).length,
    failedCount: results.filter((r) => !r.ok).length,
    authExpired,
  };
}

/** Where the customer finishes the order. Kroger owns checkout entirely. */
export const KROGER_CART_URL = "https://www.kroger.com/cart";
