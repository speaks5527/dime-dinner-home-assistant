/**
 * The Dime Dinner → ReciMe compatibility bridge.
 *
 * ReciMe publishes no sync or account API, so nothing here talks to ReciMe.
 * What it does instead is produce the two things ReciMe *documents* as import
 * inputs: pasted recipe text, and a printable single-recipe PDF. ReciMe reads
 * pasted text best when every ingredient and every instruction sits on its own
 * line, so the format below is line-oriented and completely deterministic —
 * the same recipe always produces byte-identical text, which is what makes it
 * testable and what stops an export from drifting between the clipboard, the
 * PDF and the share sheet.
 *
 * This module is shared by the client and the server so all three exports are
 * generated from one implementation.
 */
import type { InstructionGroup } from "./schema";

/** Shown wherever a ReciMe export is offered. Not an official integration. */
export const RECIME_DISCLAIMER =
  "Compatibility bridge, not an official ReciMe integration. Dime Dinner is independent and not " +
  "affiliated with ReciMe; nothing syncs automatically and no ReciMe account is used.";

/** The fields an export needs. A RecipeDTO satisfies this structurally. */
export type RecimeExportRecipe = {
  title: string;
  servings?: string | null;
  prepMinutes?: number | null;
  cookMinutes?: number | null;
  totalMinutes?: number | null;
  ingredients: string[];
  instructions: InstructionGroup[];
  /** Free text kept under a Notes heading, after the method. */
  description?: string | null;
  author?: string | null;
  siteName?: string | null;
  sourceUrl?: string | null;
};

/**
 * Query parameters that carry a session rather than identify a page. A recipe
 * URL never needs one, and a Home Assistant ingress link always does, so they
 * are dropped before a URL is written into an export.
 */
const SECRET_PARAMS = [
  "token",
  "access_token",
  "auth",
  "authorization",
  "key",
  "api_key",
  "apikey",
  "sig",
  "signature",
  "session",
  "session_id",
  "sessionid",
  "ingress",
  "password",
  "secret",
];

/** One line: no newlines, no control characters, no runs of whitespace. */
export function exportLine(input: unknown): string {
  if (input == null) return "";
  return String(input)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "homeassistant" || host === "hassio" || host === "supervisor") return true;
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  // A bare hostname with no dot is something on the local network.
  return !host.includes(".") && !ipv4;
}

/**
 * The only URL form allowed to leave the app in an export: a public http(s)
 * page, with no credentials, no session parameters and no ingress path. An
 * ebook import's `dime-dinner:` pseudo-URL and a Home Assistant ingress link
 * both come back as null rather than being handed to another app.
 */
export function sanitizeSourceUrl(raw: string | null | undefined): string | null {
  const text = exportLine(raw);
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (isPrivateHost(url.hostname)) return null;
  if (/\/api\/hassio_ingress\//.test(url.pathname)) return null;
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_PARAMS.includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

/** "1 hour 30 minutes" — spelled out, because that is what ReciMe reads back. */
export function formatDuration(minutes: number | null | undefined): string | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / 60);
  const mins = whole % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (mins) parts.push(`${mins} ${mins === 1 ? "minute" : "minutes"}`);
  return parts.join(" ");
}

/**
 * Instruction groups flattened to one numbered line each.
 *
 * ReciMe splits a pasted method on line breaks, so a group heading cannot have
 * a line of its own without becoming a phantom step. It is prefixed onto the
 * first step of its group instead, and numbering runs unbroken across groups.
 */
export function numberedInstructions(groups: InstructionGroup[]): string[] {
  const out: string[] = [];
  for (const group of groups ?? []) {
    const heading = exportLine(group?.heading);
    let first = true;
    for (const step of group?.steps ?? []) {
      const text = exportLine(step?.text);
      if (!text) continue;
      out.push(heading && first ? `${heading}: ${text}` : text);
      first = false;
    }
  }
  return out.map((text, index) => `${index + 1}. ${text}`);
}

/** Attribution line, e.g. "Carrie Barnard · eatingonadime.com". */
export function attributionLine(recipe: RecimeExportRecipe): string | null {
  const parts = [exportLine(recipe.author), exportLine(recipe.siteName)].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The clipboard format. Deterministic: same recipe in, same string out.
 *
 * Title, then the metadata ReciMe understands, then `Ingredients` with exactly
 * one ingredient per line, then `Instructions` with exactly one numbered step
 * per line, then any notes, then the attribution and the original URL.
 */
export function formatRecipeForRecime(recipe: RecimeExportRecipe): string {
  const blocks: string[][] = [];

  blocks.push([exportLine(recipe.title) || "Untitled recipe"]);

  const meta: string[] = [];
  const servings = exportLine(recipe.servings);
  if (servings) meta.push(`Servings: ${servings}`);
  const prep = formatDuration(recipe.prepMinutes);
  if (prep) meta.push(`Prep time: ${prep}`);
  const cook = formatDuration(recipe.cookMinutes);
  if (cook) meta.push(`Cook time: ${cook}`);
  const total = formatDuration(recipe.totalMinutes);
  if (total) meta.push(`Total time: ${total}`);
  if (meta.length) blocks.push(meta);

  const ingredients = (recipe.ingredients ?? []).map(exportLine).filter(Boolean);
  blocks.push(["Ingredients", ...ingredients]);

  const steps = numberedInstructions(recipe.instructions ?? []);
  blocks.push(["Instructions", ...steps]);

  const notes = exportLine(recipe.description);
  if (notes) blocks.push(["Notes", notes]);

  const attribution = attributionLine(recipe);
  const sourceUrl = sanitizeSourceUrl(recipe.sourceUrl);
  if (attribution || sourceUrl) {
    const tail: string[] = [];
    if (attribution) tail.push(`Source: ${attribution}`);
    if (sourceUrl) tail.push(sourceUrl);
    blocks.push(tail);
  }

  return blocks.map((lines) => lines.join("\n")).join("\n\n");
}

/** A safe, descriptive download name for one exported recipe. */
export function recimeFilename(title: string, extension = "pdf"): string {
  const slug = exportLine(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "recipe"}-recime.${extension}`;
}
