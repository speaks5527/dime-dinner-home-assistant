/**
 * The callback listener pulls in the add-on's effective configuration, which
 * opens the SQLite database at import time. Everything is therefore imported
 * dynamically, after the environment points at a throwaway directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let handleCallback: typeof import("../server/callbackServer")["handleCallback"];
let renderResultPage: typeof import("../server/callbackServer")["renderResultPage"];
let createState: typeof import("../server/lib/krogerAuth")["createState"];
let resetStates: typeof import("../server/lib/krogerAuth")["resetStates"];
let CALLBACK_PATH: string;
let DEFAULT_REDIRECT_URI: string;
let loadTokens: typeof import("../server/lib/krogerTokens")["loadTokens"];
let resetTokenCache: typeof import("../server/lib/krogerTokens")["resetTokenCache"];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dime-callback-"));
  process.env.DIME_DINNER_DB = path.join(dir, "test.db");
  process.env.DIME_DINNER_KROGER_TOKENS = path.join(dir, "kroger-oauth.json");
  process.env.DIME_DINNER_OPTIONS = path.join(dir, "options.json");
  fs.writeFileSync(
    process.env.DIME_DINNER_OPTIONS,
    JSON.stringify({
      kroger_enabled: true,
      kroger_client_id: "test-client",
      kroger_client_secret: "test-secret",
    }),
  );

  const callbackServer = await import("../server/callbackServer");
  handleCallback = callbackServer.handleCallback;
  renderResultPage = callbackServer.renderResultPage;
  const auth = await import("../server/lib/krogerAuth");
  createState = auth.createState;
  resetStates = auth.resetStates;
  CALLBACK_PATH = auth.CALLBACK_PATH;
  DEFAULT_REDIRECT_URI = auth.DEFAULT_REDIRECT_URI;
  const tokens = await import("../server/lib/krogerTokens");
  loadTokens = tokens.loadTokens;
  resetTokenCache = tokens.resetTokenCache;
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.DIME_DINNER_DB;
  delete process.env.DIME_DINNER_KROGER_TOKENS;
  delete process.env.DIME_DINNER_OPTIONS;
});

beforeEach(() => {
  fs.rmSync(process.env.DIME_DINNER_KROGER_TOKENS!, { force: true });
  resetTokenCache();
  resetStates();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 1800,
      scope: "product.compact cart.basic:write",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("the result page", () => {
  it("carries no script, no remote reference and escapes what Kroger said", () => {
    const html = renderResultPage({ ok: false, title: "Failed", detail: `<img src=x onerror="alert(1)">` });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("tells the user where to go next", () => {
    expect(renderResultPage({ ok: true, title: "Connected", detail: "done" })).toContain("return to Dime Dinner");
  });
});

describe("what the listener refuses to serve", () => {
  it("serves nothing on any path but the callback", async () => {
    vi.stubGlobal("fetch", vi.fn());
    for (const url of ["/", "/api/grocery", "/index.html", "/api/kroger/oauth", "/api/settings"]) {
      const res = await handleCallback(url);
      expect(res.status, url).toBe(404);
      expect(res.html, url).toContain("Nothing is served here");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not leak app data through a query string on a wrong path", async () => {
    const res = await handleCallback("/api/recipes?id=1");
    expect(res.status).toBe(404);
    expect(res.html).not.toContain("id=1");
  });
});

describe("a declined or failed consent", () => {
  it("reports a cancellation as a cancellation and connects nothing", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await handleCallback(`${CALLBACK_PATH}?error=access_denied&state=whatever`);
    expect(res.status).toBe(400);
    expect(res.html).toMatch(/cancelled/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(loadTokens()).toBeNull();
  });

  it("passes on any other Kroger error without attempting an exchange", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await handleCallback(`${CALLBACK_PATH}?error=server_error&error_description=Upstream%20problem`);
    expect(res.status).toBe(400);
    expect(res.html).toContain("Upstream problem");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("state validation", () => {
  it("refuses a callback with no state at all", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await handleCallback(`${CALLBACK_PATH}?code=abc`);
    expect(res.status).toBe(400);
    expect(res.html).toMatch(/no longer valid/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a state this add-on never issued", async () => {
    createState();
    vi.stubGlobal("fetch", vi.fn());
    const res = await handleCallback(`${CALLBACK_PATH}?code=abc&state=forged-value`);
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(loadTokens()).toBeNull();
  });

  it("refuses the second delivery of a state that already worked", async () => {
    const state = createState();
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse());
    vi.stubGlobal("fetch", fetchMock);

    expect((await handleCallback(`${CALLBACK_PATH}?code=abc&state=${state}`)).status).toBe(200);
    const replay = await handleCallback(`${CALLBACK_PATH}?code=abc&state=${state}`);

    expect(replay.status).toBe(400);
    expect(replay.html).toMatch(/already used/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("a successful callback", () => {
  it("exchanges the code server-side and stores the grant", async () => {
    const state = createState();
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse());
    vi.stubGlobal("fetch", fetchMock);

    const res = await handleCallback(`${CALLBACK_PATH}?code=auth-code-9&state=${state}`);

    expect(res.status).toBe(200);
    expect(res.html).toMatch(/connected/i);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.kroger.com/v1/connect/oauth2/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("code")).toBe("auth-code-9");
    // The redirect URI sent for the exchange is the add-on's own, never anything
    // that arrived in the request.
    expect(body.get("redirect_uri")).toBe(DEFAULT_REDIRECT_URI);

    expect(loadTokens()?.accessToken).toBe("access-1");
  });

  it("never echoes the authorization code or the token into the page", async () => {
    const state = createState();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()));
    const res = await handleCallback(`${CALLBACK_PATH}?code=secret-code&state=${state}`);
    expect(res.html).not.toContain("secret-code");
    expect(res.html).not.toContain("access-1");
    expect(res.html).not.toContain("refresh-1");
    expect(res.html).not.toContain("test-secret");
  });

  it("tolerates the trailing slash a browser or proxy may add", async () => {
    const state = createState();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()));
    expect((await handleCallback(`${CALLBACK_PATH}/?code=abc&state=${state}`)).status).toBe(200);
  });
});

describe("a failed exchange", () => {
  it("explains a redirect URI mismatch and stores nothing", async () => {
    const state = createState();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_request", error_description: "Invalid redirect_uri" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const res = await handleCallback(`${CALLBACK_PATH}?code=abc&state=${state}`);
    expect(res.status).toBe(400);
    expect(res.html).toMatch(/registered/i);
    expect(loadTokens()).toBeNull();
  });

  it("does not leave the state usable for a retry", async () => {
    const state = createState();
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await handleCallback(`${CALLBACK_PATH}?code=abc&state=${state}`)).status).toBe(400);
    const retry = await handleCallback(`${CALLBACK_PATH}?code=abc&state=${state}`);
    expect(retry.html).toMatch(/no longer valid/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
