/**
 * Persistence for the Kroger customer OAuth grant.
 *
 * Tokens are the only Kroger-account-derived value this add-on keeps. They live
 * in a single owner-only file inside /data, never in the SQLite database that
 * backs the rest of the app and never in a response body or a log line.
 */
import fs from "node:fs";
import path from "node:path";

export type StoredTokens = {
  accessToken: string;
  /** epoch ms after which the access token must be refreshed */
  accessExpiresAt: number;
  /** absent when Kroger did not return one */
  refreshToken: string | null;
  /** epoch ms; refresh tokens are short-lived and rotate on use */
  refreshExpiresAt: number | null;
  scope: string;
  connectedAt: number;
};

function resolveTokenPath(): string {
  const explicit = process.env.DIME_DINNER_KROGER_TOKENS;
  if (explicit) return explicit;
  try {
    fs.accessSync("/data", fs.constants.W_OK);
    return "/data/kroger-oauth.json";
  } catch {
    const local = path.resolve(process.cwd(), "data");
    fs.mkdirSync(local, { recursive: true });
    return path.join(local, "kroger-oauth.json");
  }
}

let cached: StoredTokens | null = null;
let loaded = false;

export function loadTokens(): StoredTokens | null {
  if (loaded) return cached;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(resolveTokenPath(), "utf-8")) as Partial<StoredTokens>;
    cached =
      typeof raw.accessToken === "string" && typeof raw.accessExpiresAt === "number"
        ? {
            accessToken: raw.accessToken,
            accessExpiresAt: raw.accessExpiresAt,
            refreshToken: typeof raw.refreshToken === "string" ? raw.refreshToken : null,
            refreshExpiresAt: typeof raw.refreshExpiresAt === "number" ? raw.refreshExpiresAt : null,
            scope: typeof raw.scope === "string" ? raw.scope : "",
            connectedAt: typeof raw.connectedAt === "number" ? raw.connectedAt : Date.now(),
          }
        : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function saveTokens(tokens: StoredTokens): void {
  const target = resolveTokenPath();
  const temp = `${target}.tmp`;
  // Create with owner-only permissions rather than chmod-ing afterwards, so the
  // secret is never briefly world-readable on disk.
  fs.writeFileSync(temp, JSON.stringify(tokens), { mode: 0o600 });
  fs.renameSync(temp, target);
  cached = tokens;
  loaded = true;
}

export function clearTokens(): void {
  try {
    fs.rmSync(resolveTokenPath(), { force: true });
  } catch {
    /* nothing to remove */
  }
  cached = null;
  loaded = true;
}

/** Drop the in-process copy so the next read comes from disk. */
export function resetTokenCache(): void {
  cached = null;
  loaded = false;
}
