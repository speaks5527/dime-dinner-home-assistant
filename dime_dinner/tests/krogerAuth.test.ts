import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KrogerError } from "../server/lib/kroger";
import {
  authStatus,
  buildAuthorizeUrl,
  CALLBACK_PATH,
  consumeState,
  createState,
  CUSTOMER_SCOPE_STRING,
  DEFAULT_REDIRECT_URI,
  disconnect,
  exchangeCode,
  getCustomerAccessToken,
  KrogerAuthRequired,
  refreshAccessToken,
  resetStates,
  validateRedirectUri,
} from "../server/lib/krogerAuth";
import { loadTokens, resetTokenCache, saveTokens } from "../server/lib/krogerTokens";

const credentials = { clientId: "test-client", clientSecret: "test-secret" };
let tokenDir: string;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "dime-kroger-"));
  process.env.DIME_DINNER_KROGER_TOKENS = path.join(tokenDir, "kroger-oauth.json");
  resetTokenCache();
  resetStates();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tokenDir, { recursive: true, force: true });
  delete process.env.DIME_DINNER_KROGER_TOKENS;
});

describe("redirect URI validation", () => {
  it("accepts the documented default and normalizes an equivalent form", () => {
    expect(validateRedirectUri(DEFAULT_REDIRECT_URI)).toBe(DEFAULT_REDIRECT_URI);
    expect(validateRedirectUri(`  http://homeassistant.local:8099${CALLBACK_PATH}/  `)).toBe(DEFAULT_REDIRECT_URI);
    expect(validateRedirectUri(`https://ha.example.com${CALLBACK_PATH}`)).toBe(
      `https://ha.example.com${CALLBACK_PATH}`,
    );
    expect(validateRedirectUri(`http://192.168.1.50:8099${CALLBACK_PATH}`)).toBe(
      `http://192.168.1.50:8099${CALLBACK_PATH}`,
    );
  });

  it("rejects anything that could not be the registered callback", () => {
    for (const bad of [
      "",
      "   ",
      "not a url",
      `/api/kroger/oauth/callback`,
      `ftp://host:8099${CALLBACK_PATH}`,
      `javascript:alert(1)`,
      `http://user:pass@host:8099${CALLBACK_PATH}`,
      `http://host:8099/somewhere/else`,
      `http://host:8099${CALLBACK_PATH}?next=evil`,
      `http://host:8099${CALLBACK_PATH}#frag`,
    ]) {
      expect(() => validateRedirectUri(bad), JSON.stringify(bad)).toThrow(KrogerError);
    }
  });
});

describe("oauth state", () => {
  it("issues opaque high-entropy values", () => {
    const a = createState();
    const b = createState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("accepts a state exactly once and rejects the replay", () => {
    const state = createState();
    expect(consumeState(state)).toBe(true);
    expect(consumeState(state)).toBe(false);
  });

  it("rejects a state it never issued, and an empty one", () => {
    createState();
    expect(consumeState("fabricated-state-value")).toBe(false);
    expect(consumeState("")).toBe(false);
  });

  it("rejects a state that has expired", () => {
    const now = Date.now();
    const state = createState(now);
    expect(consumeState(state, now + 11 * 60_000)).toBe(false);
  });

  it("still accepts a state just inside its window", () => {
    const now = Date.now();
    const state = createState(now);
    expect(consumeState(state, now + 9 * 60_000)).toBe(true);
  });
});

describe("authorize URL", () => {
  it("asks only for the scopes the cart feature needs", () => {
    const { url, state } = buildAuthorizeUrl(credentials, DEFAULT_REDIRECT_URI);
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://api.kroger.com/v1/connect/oauth2/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("test-client");
    expect(parsed.searchParams.get("redirect_uri")).toBe(DEFAULT_REDIRECT_URI);
    expect(parsed.searchParams.get("scope")).toBe(CUSTOMER_SCOPE_STRING);
    expect(parsed.searchParams.get("scope")).toBe("product.compact cart.basic:write");
    expect(parsed.searchParams.get("state")).toBe(state);
  });

  it("never leaks the client secret into the URL", () => {
    const { url } = buildAuthorizeUrl(credentials, DEFAULT_REDIRECT_URI);
    expect(url).not.toContain("test-secret");
  });

  it("mints a state that the callback will accept once", () => {
    const { state } = buildAuthorizeUrl(credentials, DEFAULT_REDIRECT_URI);
    expect(consumeState(state)).toBe(true);
    expect(consumeState(state)).toBe(false);
  });

  it("refuses to build a URL without credentials or with a bad redirect URI", () => {
    expect(() => buildAuthorizeUrl({ clientId: "", clientSecret: "" }, DEFAULT_REDIRECT_URI)).toThrow(KrogerError);
    expect(() => buildAuthorizeUrl(credentials, "http://host:8099/wrong")).toThrow(KrogerError);
  });
});

describe("code exchange", () => {
  it("posts the documented form with HTTP Basic auth and stores the tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 1800,
        scope: "product.compact cart.basic:write",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await exchangeCode(credentials, "auth-code-1", DEFAULT_REDIRECT_URI);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.kroger.com/v1/connect/oauth2/token");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("test-client:test-secret").toString("base64")}`);
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-1");
    expect(body.get("redirect_uri")).toBe(DEFAULT_REDIRECT_URI);

    expect(tokens.accessToken).toBe("access-1");
    expect(tokens.refreshToken).toBe("refresh-1");
    expect(loadTokens()?.accessToken).toBe("access-1");
  });

  it("writes the token file so only the owner can read it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { access_token: "a", expires_in: 1800 })));
    await exchangeCode(credentials, "code", DEFAULT_REDIRECT_URI);
    const mode = fs.statSync(process.env.DIME_DINNER_KROGER_TOKENS!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("uses the server's redirect URI, never a caller-supplied destination", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(exchangeCode(credentials, "code", "https://evil.example.com/steal")).rejects.toThrow(KrogerError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains a redirect URI mismatch in Kroger's own terms", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(400, { error: "invalid_request", error_description: "Invalid redirect_uri" }),
      ),
    );
    await expect(exchangeCode(credentials, "code", DEFAULT_REDIRECT_URI)).rejects.toThrow(/registered.*exactly/i);
  });

  it("explains a missing scope as a Cart API application setting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(400, { error: "invalid_scope", error_description: "bad scope" })),
    );
    await expect(exchangeCode(credentials, "code", DEFAULT_REDIRECT_URI)).rejects.toThrow(/Cart API/i);
  });

  it("rejects a callback that arrived without a code", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(exchangeCode(credentials, "", DEFAULT_REDIRECT_URI)).rejects.toThrow(KrogerError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("refresh", () => {
  it("exchanges a refresh token and keeps the rotated one", async () => {
    saveTokens({
      accessToken: "old-access",
      accessExpiresAt: Date.now() - 1,
      refreshToken: "refresh-1",
      refreshExpiresAt: Date.now() + 60_000,
      scope: CUSTOMER_SCOPE_STRING,
      connectedAt: 1000,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { access_token: "new-access", refresh_token: "refresh-2", expires_in: 1800 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await refreshAccessToken(credentials, "refresh-1");

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-1");
    expect(tokens.accessToken).toBe("new-access");
    expect(tokens.refreshToken).toBe("refresh-2");
    // The original connection time survives a refresh.
    expect(tokens.connectedAt).toBe(1000);
  });

  it("forgets the grant when Kroger rejects the refresh token", async () => {
    saveTokens({
      accessToken: "old",
      accessExpiresAt: Date.now() - 1,
      refreshToken: "spent",
      refreshExpiresAt: null,
      scope: CUSTOMER_SCOPE_STRING,
      connectedAt: Date.now(),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "invalid_grant" })));

    await expect(refreshAccessToken(credentials, "spent")).rejects.toBeInstanceOf(KrogerAuthRequired);
    expect(loadTokens()).toBeNull();
    expect(authStatus().connected).toBe(false);
  });
});

describe("access token lifecycle", () => {
  it("requires a connection before any cart call", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(getCustomerAccessToken(credentials)).rejects.toBeInstanceOf(KrogerAuthRequired);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reuses a token that is still comfortably valid", async () => {
    saveTokens({
      accessToken: "fresh",
      accessExpiresAt: Date.now() + 20 * 60_000,
      refreshToken: "r",
      refreshExpiresAt: null,
      scope: CUSTOMER_SCOPE_STRING,
      connectedAt: Date.now(),
    });
    vi.stubGlobal("fetch", vi.fn());
    expect(await getCustomerAccessToken(credentials)).toBe("fresh");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes a token that is about to expire", async () => {
    saveTokens({
      accessToken: "stale",
      accessExpiresAt: Date.now() + 5_000,
      refreshToken: "r1",
      refreshExpiresAt: null,
      scope: CUSTOMER_SCOPE_STRING,
      connectedAt: Date.now(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { access_token: "rotated", refresh_token: "r2", expires_in: 1800 })),
    );
    expect(await getCustomerAccessToken(credentials)).toBe("rotated");
  });

  it("asks for a new sign-in when an expired token has no refresh token", async () => {
    saveTokens({
      accessToken: "stale",
      accessExpiresAt: Date.now() - 1,
      refreshToken: null,
      refreshExpiresAt: null,
      scope: CUSTOMER_SCOPE_STRING,
      connectedAt: Date.now(),
    });
    vi.stubGlobal("fetch", vi.fn());
    await expect(getCustomerAccessToken(credentials)).rejects.toBeInstanceOf(KrogerAuthRequired);
    expect(loadTokens()).toBeNull();
  });
});

describe("status and disconnect", () => {
  it("reports the granted scopes and whether cart access is among them", () => {
    saveTokens({
      accessToken: "a",
      accessExpiresAt: Date.now() + 60 * 60_000,
      refreshToken: "r",
      refreshExpiresAt: null,
      scope: "product.compact",
      connectedAt: 42,
    });
    const withoutCart = authStatus();
    expect(withoutCart.connected).toBe(true);
    expect(withoutCart.hasCartScope).toBe(false);
    expect(withoutCart.connectedAt).toBe(42);

    saveTokens({
      accessToken: "a",
      accessExpiresAt: Date.now() + 60 * 60_000,
      refreshToken: "r",
      refreshExpiresAt: null,
      scope: CUSTOMER_SCOPE_STRING,
      connectedAt: 42,
    });
    expect(authStatus().hasCartScope).toBe(true);
  });

  it("removes the stored grant and invalidates pending states", () => {
    saveTokens({
      accessToken: "a",
      accessExpiresAt: Date.now() + 60_000,
      refreshToken: "r",
      refreshExpiresAt: null,
      scope: CUSTOMER_SCOPE_STRING,
      connectedAt: Date.now(),
    });
    const state = createState();
    disconnect();
    expect(fs.existsSync(process.env.DIME_DINNER_KROGER_TOKENS!)).toBe(false);
    expect(authStatus().connected).toBe(false);
    expect(consumeState(state)).toBe(false);
  });
});
