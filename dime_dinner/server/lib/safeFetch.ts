/**
 * SSRF-safe outbound HTTP for user-supplied recipe URLs.
 *
 * Rules enforced here:
 *  - http(s) only, no credentials in URL, no non-standard ports
 *  - every DNS result (and every redirect hop) must resolve to a public
 *    unicast address — loopback, private, link-local, CGNAT, multicast,
 *    reserved and cloud metadata addresses are rejected
 *  - manual redirect handling with a hop cap
 *  - request timeout + response size cap
 *  - descriptive User-Agent, single request per import (no crawling)
 */
import dns from "node:dns/promises";
import net from "node:net";

export const USER_AGENT =
  "DimeDinner/1.0 (Home Assistant add-on; personal meal planner; +https://github.com/dime-dinner)";

export const MAX_BYTES = 2_500_000;
export const MAX_REDIRECTS = 3;
export const TIMEOUT_MS = 12_000;

export class FetchRejected extends Error {
  /** What this add-on answers its own client with. */
  status: number;
  /**
   * What the remote site actually said, when the failure came from a response
   * rather than from the guard. Most callers only need `status`, but one that
   * wants to explain a 403 differently from a 500 cannot recover it otherwise.
   */
  upstreamStatus?: number;
  constructor(message: string, status = 400, upstreamStatus?: number) {
    super(message);
    this.name = "FetchRejected";
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data",
  "supervisor",
  "homeassistant",
  "hassio",
]);

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

/** True when the literal IP address must never be contacted. */
export function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const n = ipv4ToInt(ip);
    const inRange = (cidr: string, bits: number) => n >>> (32 - bits) === ipv4ToInt(cidr) >>> (32 - bits);
    return (
      inRange("0.0.0.0", 8) || // "this network"
      inRange("10.0.0.0", 8) ||
      inRange("100.64.0.0", 10) || // CGNAT
      inRange("127.0.0.0", 8) ||
      inRange("169.254.0.0", 16) || // link-local incl. 169.254.169.254 metadata
      inRange("172.16.0.0", 12) ||
      inRange("192.0.0.0", 24) ||
      inRange("192.0.2.0", 24) ||
      inRange("192.168.0.0", 16) ||
      inRange("198.18.0.0", 15) ||
      inRange("198.51.100.0", 24) ||
      inRange("203.0.113.0", 24) ||
      n >>> 28 === 0xe || // 224.0.0.0/4 multicast
      n >>> 28 === 0xf // 240.0.0.0/4 reserved + broadcast
    );
  }
  if (version === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true; // link-local, ULA
    if (lower.startsWith("ff")) return true; // multicast
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (lower.startsWith("64:ff9b::")) return true; // NAT64
    return false;
  }
  return true;
}

/** Validate the shape of a user-supplied URL (no DNS). Throws FetchRejected. */
export function validateUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new FetchRejected("That does not look like a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchRejected("Only http:// and https:// recipe links are supported.");
  }
  if (url.username || url.password) {
    throw new FetchRejected("URLs containing credentials are not allowed.");
  }
  if (url.port && !["", "80", "443"].includes(url.port)) {
    throw new FetchRejected("Only the standard web ports (80/443) are allowed.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    throw new FetchRejected("That host is on the internal network and cannot be fetched.");
  }
  if (net.isIP(host) && isBlockedAddress(host)) {
    throw new FetchRejected("That address is private or reserved and cannot be fetched.");
  }
  if (!net.isIP(host) && !host.includes(".")) {
    throw new FetchRejected("That host is not a public internet domain.");
  }
  return url;
}

/** Resolve the hostname and reject if any answer is a non-public address. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new FetchRejected("That address is private or reserved and cannot be fetched.");
    return;
  }
  let records: { address: string }[];
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new FetchRejected(`Could not resolve ${host}.`, 502);
  }
  if (!records.length) throw new FetchRejected(`Could not resolve ${host}.`, 502);
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new FetchRejected("That hostname resolves to a private or reserved address.");
    }
  }
}

export type SafeFetchResult = { url: string; status: number; contentType: string; body: string };

/**
 * Follow a user-supplied URL to its final response, validating the shape and
 * resolved addresses of every hop. The body is left unread so callers can
 * decide between capped text and a streamed download.
 */
export async function safeRequest(
  rawUrl: string,
  options: { accept?: string; timeoutMs?: number; maxRedirects?: number; signal?: AbortSignal } = {},
): Promise<{ response: Response; url: string }> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  let current = validateUrlShape(rawUrl);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicHost(current.hostname);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: options.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } catch (err) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) throw new FetchRejected("Cancelled.", 499);
      if ((err as Error).name === "AbortError") throw new FetchRejected("The site took too long to respond.", 504);
      throw new FetchRejected(`Could not reach ${current.hostname}.`, 502);
    }
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new FetchRejected("The site returned a redirect without a target.", 502);
      if (hop === maxRedirects) throw new FetchRejected("Too many redirects.", 502);
      // Re-validating here is what stops an open redirect from walking us onto
      // the Home Assistant host or a metadata endpoint.
      current = validateUrlShape(new URL(location, current).toString());
      await response.body?.cancel().catch(() => {});
      continue;
    }

    if (!response.ok) {
      throw new FetchRejected(
        `The site responded with HTTP ${response.status}.`,
        response.status === 404 ? 404 : 502,
        response.status,
      );
    }
    return { response, url: current.toString() };
  }
  throw new FetchRejected("Too many redirects.", 502);
}

/**
 * Fetch a single public document with redirect validation, timeout and a size cap.
 * `accept` defaults to HTML.
 */
export async function safeFetch(
  rawUrl: string,
  options: { accept?: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const { response, url } = await safeRequest(rawUrl, options);

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared && declared > maxBytes) throw new FetchRejected("That page is too large to parse.", 413);

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const body = await readCapped(response, maxBytes);
  return { url, status: response.status, contentType, body };
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FetchRejected("That page is too large to parse.", 413);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
}
