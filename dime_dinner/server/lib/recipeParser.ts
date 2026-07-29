/**
 * schema.org Recipe extraction from an HTML document.
 *
 * Handles the JSON-LD shapes real recipe sites publish:
 *  - a bare Recipe object
 *  - an array of objects, one of which is a Recipe
 *  - `@graph` containers (Yoast, RankMath, WP Recipe Maker, Tasty Recipes…)
 *  - `@type` given as a string or an array (`["Recipe","NewsArticle"]`)
 *  - instructions as strings, HowToStep objects, or HowToSection groups
 *  - images as string, array, ImageObject, or {url}
 *
 * All extracted text is stripped of HTML and control characters before it is
 * returned, so nothing user-fetched is ever stored or rendered as markup.
 */
import type { InstructionGroup, InstructionStep } from "@shared/schema";

export type ParsedRecipe = {
  title: string;
  description: string | null;
  imageUrl: string | null;
  author: string | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  servings: string | null;
  categories: string[];
  cuisines: string[];
  ingredients: string[];
  instructions: InstructionGroup[];
  nutrition: Record<string, string> | null;
  siteName: string | null;
};

/* ----------------------------- sanitizing ----------------------------- */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  deg: "°",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z0-9]+);/gi, (m, name) => ENTITIES[String(name).toLowerCase()] ?? m);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Strip tags/entities/control chars — the only text form we ever persist. */
export function sanitizeText(input: unknown): string {
  if (input == null) return "";
  const raw = typeof input === "string" ? input : String(input);
  return decodeEntities(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|li|div|h[1-6])>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Only keep http(s) image URLs — blocks javascript:/data: image injection. */
export function sanitizeImageUrl(value: unknown, base?: string): string | null {
  const candidate = pickImageCandidate(value);
  if (!candidate) return null;
  try {
    const url = new URL(sanitizeText(candidate), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function pickImageCandidate(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = pickImageCandidate(entry);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return pickImageCandidate(obj.url ?? obj.contentUrl ?? obj["@id"] ?? null);
  }
  return null;
}

/* ------------------------------ JSON-LD ------------------------------- */

export function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const text = match[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
    if (!text) continue;
    try {
      blocks.push(JSON.parse(text));
    } catch {
      // Some sites emit raw newlines inside strings; retry after a light repair.
      try {
        blocks.push(JSON.parse(text.replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f]/g, " ")));
      } catch {
        /* ignore this block */
      }
    }
  }
  return blocks;
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

function* walkNodes(value: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const entry of value) yield* walkNodes(entry, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  yield node;
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "hasPart", "subjectOf"]) {
    if (node[key]) yield* walkNodes(node[key], depth + 1);
  }
}

export function findRecipeNode(blocks: unknown[]): Record<string, unknown> | null {
  for (const block of blocks) {
    for (const node of walkNodes(block)) {
      const types = typesOf(node).map((t) => t.toLowerCase().replace(/^https?:\/\/schema\.org\//, ""));
      if (types.includes("recipe")) return node;
    }
  }
  // Last resort: a node that quacks like a recipe even without @type.
  for (const block of blocks) {
    for (const node of walkNodes(block)) {
      if (Array.isArray(node.recipeIngredient) && node.recipeInstructions) return node;
    }
  }
  return null;
}

/* --------------------------- field decoding --------------------------- */

/** ISO-8601 duration → minutes. Supports days/hours/minutes and "PT1H30M". */
export function parseDuration(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  const text = sanitizeText(value);
  if (!text) return null;
  const iso = text.match(/^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (iso) {
    const days = Number(iso[1] ?? 0);
    const hours = Number(iso[2] ?? 0);
    const minutes = Number(iso[3] ?? 0);
    const seconds = Number(iso[4] ?? 0);
    const total = days * 1440 + hours * 60 + minutes + seconds / 60;
    return total > 0 ? Math.round(total) : null;
  }
  const human = text.match(/(\d+)\s*(hours?|hrs?|h)\b|(\d+)\s*(minutes?|mins?|m)\b/gi);
  if (human) {
    let total = 0;
    for (const part of human) {
      const n = Number(part.match(/\d+/)?.[0] ?? 0);
      total += /h/i.test(part) ? n * 60 : n;
    }
    return total > 0 ? total : null;
  }
  const bare = Number(text);
  return Number.isFinite(bare) && bare > 0 ? Math.round(bare) : null;
}

function toStringList(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => sanitizeText(s))
      .filter(Boolean);
  }
  if (Array.isArray(value)) return value.map((v) => sanitizeText(typeof v === "object" ? (v as any)?.name : v)).filter(Boolean);
  if (typeof value === "object") return [sanitizeText((value as any).name)].filter(Boolean);
  return [];
}

function parseAuthor(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return sanitizeText(value) || null;
  if (Array.isArray(value)) return parseAuthor(value[0]);
  if (typeof value === "object") return sanitizeText((value as any).name) || null;
  return null;
}

function parseServings(value: unknown): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const readable = value.map((v) => sanitizeText(v)).filter(Boolean);
    // prefer the descriptive entry ("6 -8 servings") over the bare number
    const descriptive = readable.find((v) => /[a-z]/i.test(v));
    return descriptive ?? readable[0] ?? null;
  }
  if (typeof value === "object") return sanitizeText((value as any).value ?? (value as any).name) || null;
  return sanitizeText(value) || null;
}

/**
 * Instructions → grouped steps. Per-step images are preserved ONLY when the
 * source actually supplies one; we never invent step imagery.
 */
export function parseInstructions(value: unknown, base?: string): InstructionGroup[] {
  const groups: InstructionGroup[] = [];

  const stepFrom = (node: unknown): InstructionStep | null => {
    if (node == null) return null;
    if (typeof node === "string") {
      const text = sanitizeText(node);
      return text ? { text } : null;
    }
    if (typeof node !== "object") return null;
    const obj = node as Record<string, unknown>;
    const text = sanitizeText(obj.text ?? obj.name ?? obj.description ?? "");
    if (!text) return null;
    const image = sanitizeImageUrl(obj.image ?? obj.thumbnailUrl ?? null, base);
    return image ? { text, image } : { text };
  };

  const pushGroup = (heading: string | undefined, steps: InstructionStep[]) => {
    if (steps.length) groups.push(heading ? { heading, steps } : { steps });
  };

  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  let loose: InstructionStep[] = [];

  for (const node of list) {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const obj = node as Record<string, unknown>;
      const types = typesOf(obj).map((t) => t.toLowerCase());
      if (types.includes("howtosection") || Array.isArray(obj.itemListElement)) {
        pushGroup(undefined, loose);
        loose = [];
        const steps = (Array.isArray(obj.itemListElement) ? obj.itemListElement : [obj.itemListElement])
          .map(stepFrom)
          .filter((s): s is InstructionStep => !!s);
        pushGroup(sanitizeText(obj.name) || undefined, steps);
        continue;
      }
    }
    if (typeof node === "string" && /<(p|li|br|ol|ul)\b/i.test(node)) {
      // A single HTML blob of instructions — split it into steps.
      const pieces = node
        .split(/<\/li>|<\/p>|<br\s*\/?>/i)
        .map((p) => sanitizeText(p))
        .filter((p) => p.length > 2);
      for (const piece of pieces) loose.push({ text: piece });
      continue;
    }
    const step = stepFrom(node);
    if (step) loose.push(step);
  }
  pushGroup(undefined, loose);

  // Plain-string fallback: one paragraph of prose → sentence-ish steps.
  if (!groups.length && typeof value === "string") {
    const text = sanitizeText(value);
    if (text) {
      const steps = text
        .split(/(?<=\.)\s+(?=[A-Z])/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => ({ text: s }));
      if (steps.length) groups.push({ steps });
    }
  }
  return groups;
}

function parseNutrition(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  const labels: Record<string, string> = {
    calories: "Calories",
    carbohydrateContent: "Carbs",
    proteinContent: "Protein",
    fatContent: "Fat",
    saturatedFatContent: "Saturated fat",
    fiberContent: "Fiber",
    sugarContent: "Sugar",
    sodiumContent: "Sodium",
    cholesterolContent: "Cholesterol",
    servingSize: "Serving size",
  };
  for (const [key, label] of Object.entries(labels)) {
    const text = sanitizeText(obj[key]);
    if (text) out[label] = text;
  }
  return Object.keys(out).length ? out : null;
}

export function metaContent(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
    "i",
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
  return content ? sanitizeText(content) : null;
}

/* ------------------------------ entry point --------------------------- */

export function parseRecipeFromHtml(html: string, pageUrl: string): ParsedRecipe | null {
  const node = findRecipeNode(extractJsonLdBlocks(html));
  if (!node) return null;

  const title = sanitizeText(node.name) || metaContent(html, "og:title") || "";
  const ingredients = (Array.isArray(node.recipeIngredient) ? node.recipeIngredient : [node.recipeIngredient])
    .map((i) => sanitizeText(i))
    .filter(Boolean);
  const instructions = parseInstructions(node.recipeInstructions, pageUrl);
  if (!title || (!ingredients.length && !instructions.length)) return null;

  const prep = parseDuration(node.prepTime);
  const cook = parseDuration(node.cookTime);
  const totalRaw = parseDuration(node.totalTime);
  const total = totalRaw ?? (prep != null || cook != null ? (prep ?? 0) + (cook ?? 0) || null : null);

  let siteName = metaContent(html, "og:site_name");
  if (!siteName) {
    try {
      siteName = new URL(pageUrl).hostname.replace(/^www\./, "");
    } catch {
      siteName = null;
    }
  }

  return {
    title,
    description: sanitizeText(node.description) || metaContent(html, "og:description") || null,
    imageUrl: sanitizeImageUrl(node.image, pageUrl) ?? sanitizeImageUrl(metaContent(html, "og:image"), pageUrl),
    author: parseAuthor(node.author),
    prepMinutes: prep,
    cookMinutes: cook,
    totalMinutes: total,
    servings: parseServings(node.recipeYield),
    categories: toStringList(node.recipeCategory).slice(0, 6),
    cuisines: toStringList(node.recipeCuisine).slice(0, 4),
    ingredients: ingredients.slice(0, 80),
    instructions,
    nutrition: parseNutrition(node.nutrition),
    siteName,
  };
}
