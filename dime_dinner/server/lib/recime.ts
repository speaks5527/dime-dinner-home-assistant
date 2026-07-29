/**
 * Reading a recipe *out of* ReciMe.
 *
 * ReciMe has no public sync or account API, so this file never talks to a
 * ReciMe service. It works with the two artefacts a ReciMe user can produce
 * and hand over themselves: a public share link, and a PDF exported from the
 * app. Both arrive through machinery that already exists — the SSRF-guarded
 * fetch for links, the poppler/OCR pipeline for PDFs — and this module only
 * adds the ReciMe-shaped knowledge those two paths lack.
 *
 * Two rules shape everything here. Nothing behind a login is ever worked
 * around: a page that asks the visitor to sign in is reported as private and
 * the import stops. And no field is invented: if a share page does not state a
 * cook time, the cook time comes back null rather than being guessed from the
 * method, because the user is going to trust what lands in their library.
 */
import { sanitizeText, sanitizeImageUrl, parseDuration, metaContent, type ParsedRecipe } from "./recipeParser";
import type { InstructionGroup } from "@shared/schema";

/** Hosts ReciMe serves public recipe pages from. */
const RECIME_HOSTS = ["recime.app", "recime.io", "recimeapp.com"];

/** True for a public ReciMe page, false for everything else. */
export function isRecimeUrl(raw: string | URL): boolean {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return RECIME_HOSTS.some((base) => host === base || host.endsWith(`.${base}`));
}

/**
 * A sign that the page is not public. ReciMe share links can be revoked, and a
 * revoked or app-only link renders a sign-in prompt rather than a 404, so the
 * body has to be looked at as well as the status code.
 */
const LOGIN_WALL =
  /(sign\s?in to (?:view|continue|see)|log\s?in to (?:view|continue|see)|create an account to view|this recipe is private|no longer (?:available|shared)|link has expired|not shared publicly)/i;

/**
 * The message to show instead of a generic HTTP error, or null when the page
 * looks fine. Kept separate from the parser so the same wording is used
 * whether the problem showed up as a status code or as page content.
 */
export function recimeAccessProblem(status: number, html: string): string | null {
  if (status === 401 || status === 403) {
    return "That ReciMe link is private or has been revoked. Open the recipe in ReciMe, share it again to get a public link, and paste the new link — Dime Dinner will not sign in to ReciMe on your behalf.";
  }
  if (status === 404 || status === 410) {
    return "That ReciMe recipe could not be found. The share link may have been deleted or may have expired.";
  }
  if (status >= 400) return `ReciMe responded with HTTP ${status}.`;
  if (LOGIN_WALL.test(stripTags(html).slice(0, 4000))) {
    return "That ReciMe page asks you to sign in, so it is not a public share link. In ReciMe, use Share → Copy link on the recipe and paste that link instead.";
  }
  return null;
}

/* ---------------------------- share page parsing --------------------------- */

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

/** Every embedded JSON payload a Next.js/Nuxt page hands to its client. */
function embeddedJson(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type\s*=\s*["'](?:application\/json|application\/ld\+json)["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    try {
      out.push(JSON.parse(match[1]));
    } catch {
      /* a broken block must not stop the others */
    }
  }
  const nextData = html.match(/<script[^>]*id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextData) {
    try {
      out.push(JSON.parse(nextData[1]));
    } catch {
      /* ignore */
    }
  }
  return out;
}

type Bag = Record<string, unknown>;

const INGREDIENT_KEYS = ["ingredients", "recipeIngredient", "ingredientList", "ingredientLines"];
const STEP_KEYS = ["instructions", "recipeInstructions", "steps", "directions", "method"];

function isBag(value: unknown): value is Bag {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstArray(node: Bag, keys: string[]): unknown[] | null {
  for (const key of keys) {
    const value = node[key];
    if (Array.isArray(value) && value.length) return value;
  }
  return null;
}

/**
 * Depth-first search for the object that actually holds the recipe. ReciMe
 * buries it at a different depth depending on the page, so the shape is what
 * is matched on — a name plus both an ingredient list and a method — rather
 * than any particular path that would break the next time the app is built.
 */
export function findRecimeRecipeNode(payloads: unknown[]): Bag | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [...payloads];
  let best: Bag | null = null;

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }

    const bag = node as Bag;
    const ingredients = firstArray(bag, INGREDIENT_KEYS);
    const steps = firstArray(bag, STEP_KEYS);
    const name = sanitizeText(bag.name ?? bag.title);
    if (name && ingredients && steps && !best) best = bag;

    queue.push(...Object.values(bag));
  }
  return best;
}

/** One ingredient line, however ReciMe happened to model it. */
function ingredientText(entry: unknown): string {
  if (typeof entry === "string") return sanitizeText(entry);
  if (!isBag(entry)) return "";
  const direct = sanitizeText(entry.text ?? entry.raw ?? entry.original ?? entry.line ?? entry.description);
  if (direct) return direct;
  const parts = [entry.quantity ?? entry.amount, entry.unit, entry.name ?? entry.ingredient]
    .map((part) => sanitizeText(part))
    .filter(Boolean);
  return parts.join(" ");
}

function stepText(entry: unknown): string {
  if (typeof entry === "string") return sanitizeText(entry);
  if (!isBag(entry)) return "";
  return sanitizeText(entry.text ?? entry.instruction ?? entry.description ?? entry.step ?? entry.name);
}

/** Steps grouped the way ReciMe groups them, or one unnamed group. */
function groupSteps(entries: unknown[]): InstructionGroup[] {
  const groups: InstructionGroup[] = [];
  let plain: { text: string }[] = [];

  for (const entry of entries) {
    const nested = isBag(entry) ? firstArray(entry, ["steps", "itemListElement", "items"]) : null;
    if (nested) {
      if (plain.length) {
        groups.push({ steps: plain });
        plain = [];
      }
      const steps = nested.map(stepText).filter(Boolean).map((text) => ({ text }));
      if (!steps.length) continue;
      const heading = isBag(entry) ? sanitizeText(entry.name ?? entry.title ?? entry.heading) : "";
      groups.push(heading ? { heading, steps } : { steps });
      continue;
    }
    const text = stepText(entry);
    if (text) plain.push({ text });
  }
  if (plain.length) groups.push({ steps: plain });
  return groups;
}

/** Minutes from whatever a field holds: a number, "25", or "PT25M". */
function minutes(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  return parseDuration(value);
}

function pick(node: Bag, keys: string[]): unknown {
  for (const key of keys) {
    if (node[key] != null && node[key] !== "") return node[key];
  }
  return null;
}

function servingsText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? String(Math.round(value)) : null;
  if (isBag(value)) return servingsText(pick(value, ["value", "amount", "text"]));
  const text = sanitizeText(value);
  return text || null;
}

function authorText(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return sanitizeText(value) || null;
  if (Array.isArray(value)) return authorText(value[0]);
  if (isBag(value)) return sanitizeText(pick(value, ["name", "displayName", "username", "fullName"])) || null;
  return null;
}

/**
 * Headings on the rendered page, used when the embedded state is missing or
 * has been restructured. Only the two sections that can be identified beyond
 * doubt are read; anything else on the page is left alone.
 */
function sectionItems(html: string, heading: RegExp): string[] {
  const text = html.replace(/\s+/g, " ");
  const match = text.match(heading);
  if (!match || match.index == null) return [];
  const after = text.slice(match.index + match[0].length);
  // Stop at the next section heading so a method is never read as ingredients.
  const end = after.search(/<h[1-6][^>]*>/i);
  const block = end > 0 ? after.slice(0, end) : after.slice(0, 20_000);

  const items: string[] = [];
  for (const item of block.matchAll(/<(li|p)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const line = sanitizeText(item[2]);
    if (line && line.length <= 400) items.push(line);
  }
  return items;
}

const INGREDIENTS_H = /<h[1-6][^>]*>\s*ingredients?\s*<\/h[1-6]>/i;
const INSTRUCTIONS_H = /<h[1-6][^>]*>\s*(?:instructions?|directions?|method|steps)\s*<\/h[1-6]>/i;

/**
 * A ReciMe share page turned into the same shape the JSON-LD parser produces.
 * Returns null unless the page really carries both an ingredient list and a
 * method, so a marketing page or an empty shell can never become a recipe.
 */
export function parseRecimeSharePage(html: string, pageUrl: string): ParsedRecipe | null {
  const node = findRecimeRecipeNode(embeddedJson(html));

  let ingredients: string[] = [];
  let instructions: InstructionGroup[] = [];
  let title = "";
  let description: string | null = null;
  let imageUrl: string | null = null;
  let author: string | null = null;
  let servings: string | null = null;
  let prepMinutes: number | null = null;
  let cookMinutes: number | null = null;
  let totalMinutes: number | null = null;
  let categories: string[] = [];

  if (node) {
    ingredients = (firstArray(node, INGREDIENT_KEYS) ?? []).map(ingredientText).filter(Boolean);
    instructions = groupSteps(firstArray(node, STEP_KEYS) ?? []);
    title = sanitizeText(node.name ?? node.title);
    description = sanitizeText(pick(node, ["description", "summary", "notes"])) || null;
    imageUrl = sanitizeImageUrl(pick(node, ["image", "imageUrl", "photo", "coverImage", "thumbnail"]), pageUrl);
    author = authorText(pick(node, ["author", "creator", "user", "owner"]));
    servings = servingsText(pick(node, ["servings", "recipeYield", "yield", "serves", "portions"]));
    prepMinutes = minutes(pick(node, ["prepTime", "prepTimeMinutes", "prepMinutes"]));
    cookMinutes = minutes(pick(node, ["cookTime", "cookTimeMinutes", "cookMinutes"]));
    totalMinutes = minutes(pick(node, ["totalTime", "totalTimeMinutes", "totalMinutes"]));
    const tags = pick(node, ["recipeCategory", "categories", "tags", "course"]);
    categories = (Array.isArray(tags) ? tags : [tags]).map((t) => sanitizeText(isBag(t) ? t.name : t)).filter(Boolean);
  }

  if (!ingredients.length) ingredients = sectionItems(html, INGREDIENTS_H);
  if (!instructions.length) {
    const steps = sectionItems(html, INSTRUCTIONS_H).map((text) => ({ text }));
    if (steps.length) instructions = [{ steps }];
  }
  if (!title) title = metaContent(html, "og:title") ?? sanitizeText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  if (!description) description = metaContent(html, "og:description");
  if (!imageUrl) imageUrl = sanitizeImageUrl(metaContent(html, "og:image"), pageUrl);
  if (!author) author = metaContent(html, "author") ?? metaContent(html, "article:author");

  // ReciMe titles its share pages "<Recipe> | ReciMe"; the suffix is chrome.
  title = title.replace(/\s*[|·—–-]\s*ReciMe.*$/i, "").trim();

  if (!title || !ingredients.length || !instructions.length) return null;
  if (totalMinutes == null && (prepMinutes != null || cookMinutes != null)) {
    totalMinutes = (prepMinutes ?? 0) + (cookMinutes ?? 0) || null;
  }

  return {
    title,
    description,
    imageUrl,
    author,
    prepMinutes,
    cookMinutes,
    totalMinutes,
    servings,
    categories: categories.slice(0, 6),
    cuisines: [],
    ingredients: ingredients.slice(0, 80),
    instructions,
    nutrition: null,
    siteName: "ReciMe",
  };
}

/* ------------------------------ exported PDFs ------------------------------ */

/**
 * Whether a PDF came out of ReciMe. The producer string is the reliable
 * signal; the footer ReciMe stamps on its exports is the fallback for a PDF
 * that has been through a print-to-PDF step and lost its metadata.
 */
export function looksLikeRecimePdf(
  meta: { title?: string | null; author?: string | null; creator?: string | null; producer?: string | null },
  pageTexts: string[] = [],
): boolean {
  const fields = [meta.creator, meta.producer, meta.title, meta.author].filter(Boolean).join(" ");
  if (/recime/i.test(fields)) return true;
  const head = pageTexts.slice(0, 3).join("\n");
  return /(?:made|created|saved)\s+(?:with|in|from)\s+recime|recime\.app|^\s*recime\s*$/im.test(head);
}

/**
 * The link a ReciMe export prints in its footer, so the imported recipe can
 * keep pointing back at the original. Only a public ReciMe URL is taken.
 */
export function recimeFooterUrl(pageTexts: string[]): string | null {
  for (const match of pageTexts.join("\n").matchAll(/https?:\/\/[^\s<>"')]+/gi)) {
    const candidate = match[0].replace(/[.,;]+$/, "");
    if (isRecimeUrl(candidate)) return candidate;
  }
  return null;
}
