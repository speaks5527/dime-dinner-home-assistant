/**
 * Kroger customer OAuth2 (authorization code) flow.
 *
 * The Cart API acts on a signed-in customer's cart, so it needs a customer
 * context. Client-credentials tokens — which the Products/Locations lookups in
 * ./kroger.ts still use — cannot reach it. This module owns the interactive
 * half: building the consent URL, guarding the round trip with one-time state,
 * exchanging the code server-side, and keeping the access token fresh.
 *
 * Nothing here is reachable without a redirect URI that the user registered in
 * their own Kroger developer application, and the redirect URI used for the
 * token exchange is always the server's own configured value — never a value
 * echoed back from the request.
 */
import crypto from "node:crypto";
import { KrogerError } from "./kroger";
import { clearTokens, loadTokens, saveTokens, type StoredTokens } from "./krogerTokens";

const API_ROOT = "https://api.kroger.com/v1";
const AUTHORIZE_URL = `${API_ROOT}/connect/oauth2/authorize`;
const TOKEN_URL = `${API_ROOT}/connect/oauth2/token`;

/**
 * `cart.basic:write` is the only scope the cart feature needs; `product.compact`
 * is requested alongside it so the same grant can resolve the UPCs being added.
 * Nothing broader is asked for.
 */
export const CUSTOMER_SCOPES = ["product.compact", "cart.basic:write"] as const;
export const CUSTOMER_SCOPE_STRING = CUSTOMER_SCOPES.join(" ");

/** The one path the callback listener answers, and the only legal redirect path. */
export const CALLBACK_PATH = "/api/kroger/oauth/callback";
export const DEFAULT_CALLBACK_PORT = 8099;
export const DEFAULT_REDIRECT_URI = `http://homeassistant.local:${DEFAULT_CALLBACK_PORT}${CALLBACK_PATH}`;

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 20;

/** Raised when the caller must send the user through consent again. */
export class KrogerAuthRequired extends KrogerError {
  constructor(message = "Connect your Kroger account first.") {
    super(message, 401);
    this.name = "KrogerAuthRequired";
  }
}

export type AuthCredentials = { clientId: string; clientSecret: string };

/* ------------------------------ redirect URI ------------------------------ */

/**
 * Accept only a URI that could plausibly be the registered callback: an
 * absolute http(s) URL, no credentials, no query or fragment, and exactly the
 * callback path. Anything else is a configuration mistake that would otherwise
 * surface as an opaque `redirect_uri_mismatch` from Kroger.
 */
export function validateRedirectUri(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new KrogerError("Set the Kroger redirect URI first.", 400);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new KrogerError("The Kroger redirect URI must be a full URL, including http:// or https://.", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new KrogerError("The Kroger redirect URI must use http:// or https://.", 400);
  }
  if (url.username || url.password) {
    throw new KrogerError("The Kroger redirect URI must not contain a username or password.", 400);
  }
  if (!url.hostname) {
    throw new KrogerError("The Kroger redirect URI needs a hostname.", 400);
  }
  if (url.search || url.hash) {
    throw new KrogerError("The Kroger redirect URI must not include a query string or fragment.", 400);
  }
  if (url.pathname.replace(/\/+$/, "") !== CALLBACK_PATH) {
    throw new KrogerError(`The Kroger redirect URI path must be exactly ${CALLBACK_PATH}.`, 400);
  }
  // Rebuild from parts so the stored value is byte-identical to what is sent to
  // Kroger — the registered URI has to match exactly.
  return `${url.protocol}//${url.host}${CALLBACK_PATH}`;
}

/* -------------------------------- state ---------------------------------- */

type PendingState = { expiresAt: number };
const pendingStates = new Map<string, PendingState>();

function prunePendingStates(now = Date.now()): void {
  for (const [value, entry] of pendingStates) {
    if (entry.expiresAt <= now) pendingStates.delete(value);
  }
}

/** Mint a single-use, expiring CSRF state token for one consent round trip. */
export function createState(now = Date.now()): string {
  prunePendingStates(now);
  // A stale tab left on the consent screen should never be able to evict a
  // freshly minted state, so drop the oldest instead of refusing.
  while (pendingStates.size >= MAX_PENDING_STATES) {
    const oldest = pendingStates.keys().next().value;
    if (oldest === undefined) break;
    pendingStates.delete(oldest);
  }
  const value = crypto.randomBytes(32).toString("base64url");
  pendingStates.set(value, { expiresAt: now + STATE_TTL_MS });
  return value;
}

/**
 * Consume a state token. Returns true at most once per token: a replayed or
 * expired value is rejected, as is one this process never issued.
 */
export function consumeState(value: string, now = Date.now()): boolean {
  prunePendingStates(now);
  if (!value) return false;
  const entry = pendingStates.get(value);
  if (!entry) return false;
  pendingStates.delete(value);
  return entry.expiresAt > now;
}

export function resetStates(): void {
  pendingStates.clear();
}

/* ----------------------------- authorize URL ------------------------------ */

export function buildAuthorizeUrl(
  credentials: AuthCredentials,
  redirectUri: string,
): { url: string; state: string } {
  if (!credentials.clientId || !credentials.clientSecret) {
    throw new KrogerError("Add your Kroger client ID and secret before connecting an account.", 400);
  }
  const validated = validateRedirectUri(redirectUri);
  const state = createState();
  const params = new URLSearchParams({
    scope: CUSTOMER_SCOPE_STRING,
    client_id: credentials.clientId,
    redirect_uri: validated,
    response_type: "code",
    state,
  });
  return { url: `${AUTHORIZE_URL}?${params.toString()}`, state };
}

/* ------------------------------ token calls ------------------------------ */

const ACCESS_TOKEN_FALLBACK_SECONDS = 1800;
/** Kroger does not report refresh lifetime; its docs describe roughly a day. */
const REFRESH_TOKEN_ASSUMED_SECONDS = 24 * 60 * 60;

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

async function postToken(credentials: AuthCredentials, body: URLSearchParams): Promise<StoredTokens> {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new KrogerError(`Could not reach Kroger: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 400 || res.status === 401) {
    // Kroger's error body is the only place the real cause appears, and the two
    // it returns most often are worth translating.
    let detail = "";
    try {
      const parsed = (await res.json()) as { error?: string; error_description?: string };
      detail = parsed.error_description || parsed.error || "";
    } catch {
      /* body was not JSON */
    }
    if (/redirect/i.test(detail)) {
      throw new KrogerError(
        "Kroger rejected the redirect URI. It must match the one registered in your Kroger application exactly, character for character.",
        400,
      );
    }
    if (/scope/i.test(detail)) {
      throw new KrogerError(
        "Kroger rejected the requested scopes. Enable the Cart API on your Kroger application and try again.",
        400,
      );
    }
    throw new KrogerError(
      detail
        ? `Kroger rejected the request: ${detail}`
        : "Kroger rejected the request. Check the client ID, secret and redirect URI.",
      401,
    );
  }
  if (!res.ok) throw new KrogerError(`Kroger token request failed (HTTP ${res.status}).`);

  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) throw new KrogerError("Kroger returned no access token.");

  const now = Date.now();
  return {
    accessToken: data.access_token,
    accessExpiresAt: now + (data.expires_in ?? ACCESS_TOKEN_FALLBACK_SECONDS) * 1000,
    refreshToken: data.refresh_token ?? null,
    refreshExpiresAt: data.refresh_token ? now + REFRESH_TOKEN_ASSUMED_SECONDS * 1000 : null,
    scope: data.scope ?? CUSTOMER_SCOPE_STRING,
    connectedAt: now,
  };
}

/** Exchange an authorization code for tokens and persist them. */
export async function exchangeCode(
  credentials: AuthCredentials,
  code: string,
  redirectUri: string,
): Promise<StoredTokens> {
  if (!code) throw new KrogerError("Kroger did not return an authorization code.", 400);
  const validated = validateRedirectUri(redirectUri);
  const tokens = await postToken(
    credentials,
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: validated }),
  );
  saveTokens(tokens);
  return tokens;
}

/**
 * Trade a refresh token for a new access token. Kroger rotates refresh tokens,
 * so a response without one means the old one is spent and the grant is over.
 */
export async function refreshAccessToken(
  credentials: AuthCredentials,
  refreshToken: string,
): Promise<StoredTokens> {
  const previous = loadTokens();
  let tokens: StoredTokens;
  try {
    tokens = await postToken(
      credentials,
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    );
  } catch (err) {
    if (err instanceof KrogerError && (err.status === 400 || err.status === 401)) {
      clearTokens();
      throw new KrogerAuthRequired("Your Kroger sign-in expired. Connect your Kroger account again.");
    }
    throw err;
  }
  const merged: StoredTokens = {
    ...tokens,
    refreshToken: tokens.refreshToken ?? null,
    connectedAt: previous?.connectedAt ?? tokens.connectedAt,
  };
  saveTokens(merged);
  return merged;
}

const REFRESH_MARGIN_MS = 60_000;

/**
 * A valid customer access token, refreshed if it is close to expiry.
 * Throws KrogerAuthRequired when the user has to sign in again.
 */
export async function getCustomerAccessToken(credentials: AuthCredentials): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new KrogerAuthRequired();
  if (tokens.accessExpiresAt > Date.now() + REFRESH_MARGIN_MS) return tokens.accessToken;
  if (!tokens.refreshToken) {
    clearTokens();
    throw new KrogerAuthRequired("Your Kroger sign-in expired. Connect your Kroger account again.");
  }
  const refreshed = await refreshAccessToken(credentials, tokens.refreshToken);
  return refreshed.accessToken;
}

/* -------------------------------- status --------------------------------- */

export type KrogerAuthStatus = {
  connected: boolean;
  /** true once the access token is stale and only a refresh can save it */
  needsRefresh: boolean;
  canRefresh: boolean;
  connectedAt: number | null;
  scopes: string[];
  hasCartScope: boolean;
};

export function authStatus(): KrogerAuthStatus {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      connected: false,
      needsRefresh: false,
      canRefresh: false,
      connectedAt: null,
      scopes: [],
      hasCartScope: false,
    };
  }
  const scopes = tokens.scope.split(/\s+/).filter(Boolean);
  return {
    connected: true,
    needsRefresh: tokens.accessExpiresAt <= Date.now() + REFRESH_MARGIN_MS,
    canRefresh: !!tokens.refreshToken,
    connectedAt: tokens.connectedAt,
    scopes,
    hasCartScope: scopes.includes("cart.basic:write"),
  };
}

/** Forget the local grant. Kroger publishes no public token revocation endpoint. */
export function disconnect(): void {
  clearTokens();
  resetStates();
}
