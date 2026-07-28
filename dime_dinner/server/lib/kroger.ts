/**
 * Optional Kroger integration.
 *
 * OAuth2 client-credentials (service-to-service) against api.kroger.com, using
 * only the public Locations and Products APIs. Results are cached briefly and
 * fetched on demand for a single ingredient at a time — this add-on never
 * builds or stores a Kroger product database.
 */
import { TtlCache } from "./cache";
import type { KrogerProduct } from "@shared/schema";

const API_ROOT = "https://api.kroger.com/v1";
const TOKEN_URL = `${API_ROOT}/connect/oauth2/token`;

export type KrogerConfig = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  zip: string;
  locationId: string;
};

export class KrogerError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "KrogerError";
    this.status = status;
  }
}

let token: { value: string; expiresAt: number } | null = null;
const productCache = new TtlCache<KrogerProduct[]>(5 * 60_000, 60);
const locationCache = new TtlCache<{ locationId: string; name: string }>(30 * 60_000, 20);

export function resetKrogerCaches(): void {
  token = null;
  productCache.clear();
  locationCache.clear();
}

async function getToken(config: KrogerConfig, scope = "product.compact"): Promise<string> {
  if (token && token.expiresAt > Date.now() + 30_000) return token.value;
  if (!config.clientId || !config.clientSecret) {
    throw new KrogerError("Kroger client ID and secret are required.", 400);
  }
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope }).toString(),
    });
  } catch (err) {
    clearTimeout(timer);
    throw new KrogerError(`Could not reach Kroger: ${(err as Error).message}`);
  }
  clearTimeout(timer);
  if (res.status === 401 || res.status === 400) {
    throw new KrogerError("Kroger rejected those credentials. Check the client ID and secret.", 401);
  }
  if (!res.ok) throw new KrogerError(`Kroger token request failed (HTTP ${res.status}).`);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new KrogerError("Kroger returned no access token.");
  token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 1800) * 1000 };
  return token.value;
}

async function krogerGet(config: KrogerConfig, path: string): Promise<any> {
  const accessToken = await getToken(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  let res: Response;
  try {
    res = await fetch(`${API_ROOT}${path}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
  } catch (err) {
    clearTimeout(timer);
    throw new KrogerError(`Could not reach Kroger: ${(err as Error).message}`);
  }
  clearTimeout(timer);
  if (res.status === 401) {
    token = null;
    throw new KrogerError("Kroger session expired — try again.", 401);
  }
  if (!res.ok) throw new KrogerError(`Kroger API error (HTTP ${res.status}).`);
  return res.json();
}

/** Resolve a ZIP code to a nearby store locationId. */
export async function resolveLocation(config: KrogerConfig): Promise<{ locationId: string; name: string } | null> {
  if (config.locationId) {
    const cached = locationCache.get(`id:${config.locationId}`);
    if (cached) return cached;
    try {
      const data = await krogerGet(config, `/locations/${encodeURIComponent(config.locationId)}`);
      const found = { locationId: String(data?.data?.locationId ?? config.locationId), name: String(data?.data?.name ?? "Selected store") };
      locationCache.set(`id:${config.locationId}`, found);
      return found;
    } catch {
      return { locationId: config.locationId, name: "Selected store" };
    }
  }
  if (!config.zip) return null;
  const cached = locationCache.get(`zip:${config.zip}`);
  if (cached) return cached;
  const data = await krogerGet(
    config,
    `/locations?filter.zipCode.near=${encodeURIComponent(config.zip)}&filter.limit=1`,
  );
  const first = data?.data?.[0];
  if (!first) return null;
  const found = { locationId: String(first.locationId), name: String(first.name ?? "Kroger store") };
  locationCache.set(`zip:${config.zip}`, found);
  return found;
}

function mapProduct(raw: any): KrogerProduct {
  const item = raw?.items?.[0] ?? {};
  const images: any[] = Array.isArray(raw?.images) ? raw.images : [];
  const front = images.find((i) => i?.perspective === "front") ?? images[0];
  const sizes: any[] = Array.isArray(front?.sizes) ? front.sizes : [];
  const preferred =
    sizes.find((s) => s?.size === "medium") ?? sizes.find((s) => s?.size === "large") ?? sizes[0];
  return {
    productId: String(raw?.productId ?? ""),
    // The Cart API keys on the UPC. It usually equals productId for a base
    // product, but the two are separate fields and only this one is documented
    // as the cart identifier, so it is carried through explicitly.
    upc: raw?.upc ? String(raw.upc) : String(raw?.productId ?? ""),
    description: String(raw?.description ?? ""),
    brand: raw?.brand ? String(raw.brand) : null,
    size: item?.size ? String(item.size) : null,
    imageUrl: preferred?.url ? String(preferred.url) : null,
    regularPrice: typeof item?.price?.regular === "number" ? item.price.regular : null,
    promoPrice: typeof item?.price?.promo === "number" && item.price.promo > 0 ? item.price.promo : null,
    aisle: raw?.aisleLocations?.[0]?.description
      ? String(raw.aisleLocations[0].description)
      : raw?.aisleLocations?.[0]?.number
        ? `Aisle ${raw.aisleLocations[0].number}`
        : null,
    fulfillment: Object.entries(raw?.items?.[0]?.fulfillment ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k),
    stockLevel: item?.inventory?.stockLevel ? String(item.inventory.stockLevel) : null,
    soldBy: item?.soldBy ? String(item.soldBy) : null,
  };
}

export const KROGER_DISCLAIMER =
  "Kroger reports what a store sells and how it can be fulfilled. That is not a live shelf count — availability can differ in the store unless a stock level is explicitly returned.";

/** On-demand product match for a single grocery term. */
export async function matchProducts(
  config: KrogerConfig,
  term: string,
  limit = 5,
): Promise<{ products: KrogerProduct[]; locationId: string | null }> {
  if (!config.enabled) throw new KrogerError("Kroger integration is turned off.", 400);
  const cleanTerm = term.trim().slice(0, 60);
  if (!cleanTerm) throw new KrogerError("Nothing to look up.", 400);

  const location = await resolveLocation(config);
  const cacheKey = `${location?.locationId ?? "none"}|${cleanTerm.toLowerCase()}|${limit}`;
  const cached = productCache.get(cacheKey);
  if (cached) return { products: cached, locationId: location?.locationId ?? null };

  const params = new URLSearchParams({ "filter.term": cleanTerm, "filter.limit": String(limit) });
  if (location?.locationId) params.set("filter.locationId", location.locationId);
  const data = await krogerGet(config, `/products?${params.toString()}`);
  const products = (Array.isArray(data?.data) ? data.data : []).map(mapProduct);
  productCache.set(cacheKey, products);
  return { products, locationId: location?.locationId ?? null };
}
