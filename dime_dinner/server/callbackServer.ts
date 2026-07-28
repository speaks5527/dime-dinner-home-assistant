/**
 * A separate, deliberately tiny HTTP listener whose only job is to receive
 * Kroger's OAuth redirect.
 *
 * Home Assistant ingress URLs embed a rotating session token, so an ingress URL
 * cannot be registered as a static OAuth callback — it would stop matching. The
 * main UI therefore stays ingress-only and this listener is the one thing
 * published on a host port.
 *
 * It answers exactly one path with GET. Every other path, method and host header
 * gets a 404 with no body of consequence: none of the application, its API or
 * its data is reachable here. The authorization code is exchanged server-side
 * and never echoed back into the page, and `Referrer-Policy: no-referrer` keeps
 * the code in the URL from leaking onward.
 */
import http from "node:http";
import { CALLBACK_PATH, consumeState, exchangeCode, validateRedirectUri } from "./lib/krogerAuth";
import { callbackPort, krogerConfig, krogerRedirectUri } from "./lib/config";
import { log } from "./log";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  // The page is fully self-contained: no scripts, no images, no fetches.
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
  "Cache-Control": "no-store, max-age=0",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Self-contained result page — the user's next step is to go back to the app. */
export function renderResultPage(input: { ok: boolean; title: string; detail: string }): string {
  const accent = input.ok ? "#2f6f4f" : "#8c2f2f";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(input.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 24px;
         background: #f6f5f1; color: #23201c; }
  main { max-width: 34rem; width: 100%; background: #fff; border: 1px solid #e2ddd4; border-radius: 14px;
         padding: 28px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  h1 { margin: 0 0 12px; font-size: 1.35rem; color: ${accent}; }
  p { margin: 0 0 12px; }
  .hint { font-size: .875rem; color: #6b645b; margin-bottom: 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #171614; color: #ece8e1; }
    main { background: #201f1c; border-color: #35322d; box-shadow: none; }
    .hint { color: #a29a90; }
  }
</style>
</head>
<body>
<main role="main">
  <h1>${escapeHtml(input.title)}</h1>
  <p>${escapeHtml(input.detail)}</p>
  <p class="hint">You can close this tab and return to Dime Dinner in Home Assistant.</p>
</main>
</body>
</html>
`;
}

function send(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, SECURITY_HEADERS);
  res.end(html);
}

/**
 * Turn a callback request into a rendered page. Exported so the flow can be
 * exercised without binding a socket.
 */
export async function handleCallback(rawUrl: string): Promise<{ status: number; html: string }> {
  // The host is irrelevant here — only the path and query are read — but URL
  // needs an absolute input.
  const url = new URL(rawUrl, "http://callback.invalid");
  if (url.pathname.replace(/\/+$/, "") !== CALLBACK_PATH) {
    return { status: 404, html: renderResultPage({ ok: false, title: "Not found", detail: "Nothing is served here." }) };
  }

  const error = url.searchParams.get("error");
  if (error) {
    const denied = error === "access_denied";
    return {
      status: 400,
      html: renderResultPage({
        ok: false,
        title: denied ? "Kroger sign-in cancelled" : "Kroger sign-in failed",
        detail: denied
          ? "You declined to give Dime Dinner access to your Kroger cart. Nothing was connected and nothing was changed."
          : `Kroger reported: ${url.searchParams.get("error_description") || error}`,
      }),
    };
  }

  // State is consumed before anything else so a replayed or forged callback
  // cannot even reach the token exchange.
  if (!consumeState(url.searchParams.get("state") ?? "")) {
    return {
      status: 400,
      html: renderResultPage({
        ok: false,
        title: "This sign-in link is no longer valid",
        detail:
          "It was already used, it expired, or it did not come from this add-on. Open Dime Dinner and press Connect Kroger account again.",
      }),
    };
  }

  const code = url.searchParams.get("code") ?? "";
  const config = krogerConfig();
  try {
    const redirectUri = validateRedirectUri(krogerRedirectUri().value);
    await exchangeCode({ clientId: config.clientId, clientSecret: config.clientSecret }, code, redirectUri);
  } catch (err) {
    log(`kroger oauth callback failed: ${(err as Error).message}`, "kroger");
    return {
      status: 400,
      html: renderResultPage({
        ok: false,
        title: "Could not finish connecting",
        detail: (err as Error).message,
      }),
    };
  }

  log("kroger customer account connected", "kroger");
  return {
    status: 200,
    html: renderResultPage({
      ok: true,
      title: "Kroger account connected",
      detail: "Dime Dinner can now build a cart for you to review before anything is added.",
    }),
  };
}

/**
 * Start the callback listener. Returns null when the port cannot be bound, which
 * is not fatal: everything except connecting a Kroger account still works.
 */
export function startCallbackServer(): http.Server | null {
  const port = callbackPort();
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...SECURITY_HEADERS, Allow: "GET" });
      return res.end(renderResultPage({ ok: false, title: "Not allowed", detail: "Only GET is served here." }));
    }
    handleCallback(req.url ?? "/")
      .then(({ status, html }) => send(res, status, req.method === "HEAD" ? "" : html))
      .catch(() =>
        send(res, 500, renderResultPage({ ok: false, title: "Something went wrong", detail: "Please try again." })),
      );
  });

  server.on("error", (err) => {
    log(`kroger callback listener could not start on port ${port}: ${err.message}`, "kroger");
  });
  // Bound on all interfaces because the Supervisor publishes this port to the
  // host; the handler above is the entire attack surface.
  server.listen(port, "0.0.0.0", () => {
    log(`kroger oauth callback listening on port ${port}${CALLBACK_PATH}`, "kroger");
  });
  return server;
}
