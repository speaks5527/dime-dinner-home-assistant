/**
 * Recipe sourcing.
 *
 *  - Browse/search is backed by Eating on a Dime's public WordPress REST API
 *    (one request per user action, cached, rate limited — never a crawl).
 *  - Import accepts ANY public http(s) recipe URL and reads standards-based
 *    schema.org/Recipe JSON-LD from it.
 */
import { TtlCache, politeGate, RateLimited } from "./cache";
import { FetchRejected, safeFetch, validateUrlShape } from "./safeFetch";
import { parseRecipeFromHtml, sanitizeText, type ParsedRecipe } from "./recipeParser";
import { DEMO_RECIPES, demoBySlug, demoSearch, type DemoRecipe } from "./demoData";
import type { SearchHit } from "@shared/schema";

export const CATALOG_HOST = "www.eatingonadime.com";
export const CATALOG_ORIGIN = `https://${CATALOG_HOST}`;

const searchCache = new TtlCache<{ hits: SearchHit[]; source: "live" | "demo" }>(10 * 60_000);
const pageCache = new TtlCache<string>(15 * 60_000, 40);

export type CatalogResult = { hits: SearchHit[]; source: "live" | "demo"; notice?: string };

type WpPost = {
  id: number;
  link: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  yoast_head_json?: { og_image?: { url?: string }[]; description?: string };
};

function demoHits(query: string): SearchHit[] {
  const list: DemoRecipe[] = demoSearch(query);
  return list.map((r) => ({
    title: r.title,
    url: `${CATALOG_ORIGIN}/${r.slug}/`,
    imageUrl: null,
    excerpt: r.description,
  }));
}

/** Search the Eating on a Dime catalog. Falls back to demo data when offline. */
export async function searchCatalog(query: string, page = 1): Promise<CatalogResult> {
  const key = `${query.toLowerCase().trim()}|${page}`;
  const cached = searchCache.get(key);
  if (cached) return { ...cached };

  const params = new URLSearchParams({
    per_page: "18",
    page: String(page),
    _fields: "id,link,title,excerpt,yoast_head_json",
    orderby: query.trim() ? "relevance" : "date",
  });
  if (query.trim()) params.set("search", query.trim());
  const url = `${CATALOG_ORIGIN}/wp-json/wp/v2/posts?${params.toString()}`;

  try {
    await politeGate(CATALOG_HOST);
    const res = await safeFetch(url, { accept: "application/json", timeoutMs: 10_000 });
    const data = JSON.parse(res.body) as WpPost[];
    const hits: SearchHit[] = (Array.isArray(data) ? data : [])
      .map((post) => ({
        title: sanitizeText(post.title?.rendered ?? ""),
        url: post.link,
        imageUrl: post.yoast_head_json?.og_image?.[0]?.url ?? null,
        excerpt: sanitizeText(post.excerpt?.rendered ?? post.yoast_head_json?.description ?? "").slice(0, 220) || null,
      }))
      .filter((hit) => hit.title && hit.url.startsWith(CATALOG_ORIGIN));
    if (!hits.length && page === 1) {
      const fallback = { hits: demoHits(query), source: "demo" as const };
      return { ...fallback, notice: "No live results — showing the offline demo catalog." };
    }
    const result = { hits, source: "live" as const };
    searchCache.set(key, result);
    return result;
  } catch (err) {
    if (err instanceof RateLimited) throw err;
    const fallback = { hits: demoHits(query), source: "demo" as const };
    searchCache.set(key, fallback, 60_000);
    return {
      ...fallback,
      notice: "Eating on a Dime could not be reached, so a small offline demo catalog is shown instead.",
    };
  }
}

export type ImportResult = {
  recipe: ParsedRecipe;
  sourceUrl: string;
  source: "live" | "demo";
  notice?: string;
};

function demoImport(url: string): ImportResult | null {
  const slug = url.replace(/\/+$/, "").split("/").pop() ?? "";
  const demo = demoBySlug(slug) ?? (url.includes("eatingonadime.com") ? DEMO_RECIPES[0] : null);
  if (!demo) return null;
  return {
    sourceUrl: url,
    source: "demo",
    notice: "Live fetch is unavailable here, so a demo version of this recipe was loaded.",
    recipe: {
      title: demo.title,
      description: demo.description,
      imageUrl: null,
      author: demo.author,
      prepMinutes: demo.prepMinutes,
      cookMinutes: demo.cookMinutes,
      totalMinutes: demo.totalMinutes,
      servings: demo.servings,
      categories: demo.categories,
      cuisines: demo.cuisines,
      ingredients: demo.ingredients,
      instructions: demo.instructions,
      nutrition: demo.nutrition,
      siteName: "eatingonadime.com (demo)",
    },
  };
}

/**
 * Import one recipe from any public recipe URL.
 * Throws FetchRejected for unsafe or unusable URLs.
 */
export async function importFromUrl(rawUrl: string): Promise<ImportResult> {
  const url = validateUrlShape(rawUrl);
  const host = url.hostname.toLowerCase();
  const canonical = url.toString();

  const cachedHtml = pageCache.get(canonical);
  if (cachedHtml) {
    const parsed = parseRecipeFromHtml(cachedHtml, canonical);
    if (parsed) return { recipe: parsed, sourceUrl: canonical, source: "live" };
  }

  let html: string;
  try {
    await politeGate(host);
    const res = await safeFetch(canonical);
    if (!/text\/html|application\/xhtml|text\/plain/.test(res.contentType) && res.contentType) {
      throw new FetchRejected("That link is not a web page.", 415);
    }
    html = res.body;
    pageCache.set(canonical, html);
  } catch (err) {
    const demo = demoImport(canonical);
    if (demo) return demo;
    if (err instanceof FetchRejected || err instanceof RateLimited) throw err;
    throw new FetchRejected(`Could not load that page: ${(err as Error).message}`, 502);
  }

  const parsed = parseRecipeFromHtml(html, canonical);
  if (!parsed) {
    throw new FetchRejected(
      "No structured recipe data (schema.org Recipe) was found on that page. Most major recipe sites publish it — try the printable or main recipe page URL.",
      422,
    );
  }
  return { recipe: parsed, sourceUrl: canonical, source: "live" };
}

export { FetchRejected, RateLimited };
