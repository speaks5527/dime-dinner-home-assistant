/**
 * Recipe sourcing.
 *
 *  - Browse/search is backed by each publisher's public catalog endpoint
 *    (one request per user action, cached, rate limited — never a crawl).
 *  - Import accepts ANY public http(s) recipe URL and reads standards-based
 *    schema.org/Recipe JSON-LD from it, with a ReciMe-shaped fallback for
 *    public ReciMe share links, which do not publish JSON-LD.
 */
import { TtlCache, politeGate, RateLimited } from "./cache";
import { FetchRejected, safeFetch, validateUrlShape } from "./safeFetch";
import { parseRecipeFromHtml, sanitizeText, type ParsedRecipe } from "./recipeParser";
import { isRecimeUrl, parseRecimeSharePage, recimeAccessProblem } from "./recime";
import { DEMO_RECIPES, demoBySlug, demoSearch, type DemoRecipe } from "./demoData";
import type { SearchHit } from "@shared/schema";

export type CatalogSource = "eatingonadime" | "ajgreats" | "ketofocus";

type CatalogDefinition = {
  label: string;
  host: string;
  origin: string;
  kind: "wordpress" | "ketofocus";
};

export const CATALOGS: Record<CatalogSource, CatalogDefinition> = {
  eatingonadime: {
    label: "Eating on a Dime",
    host: "www.eatingonadime.com",
    origin: "https://www.eatingonadime.com",
    kind: "wordpress",
  },
  ajgreats: {
    label: "AJ Greats",
    host: "ajgreats.com",
    origin: "https://ajgreats.com",
    kind: "wordpress",
  },
  ketofocus: {
    label: "KetoFocus",
    host: "www.ketofocus.com",
    origin: "https://www.ketofocus.com",
    kind: "ketofocus",
  },
};

export const CATALOG_HOST = CATALOGS.eatingonadime.host;
export const CATALOG_ORIGIN = CATALOGS.eatingonadime.origin;

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

type KetoFocusRecipe = {
  url?: string;
  title?: string;
  thumb?: string;
  image?: string;
  time?: number | string;
  carbs?: number | string;
  courses?: string[];
};

type KetoFocusResponse = {
  recipes?: KetoFocusRecipe[];
  total?: number;
  offset?: number;
  remaining?: number;
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

function wpHits(data: unknown, catalog: CatalogDefinition): SearchHit[] {
  return (Array.isArray(data) ? (data as WpPost[]) : [])
    .map((post) => ({
      title: sanitizeText(post.title?.rendered ?? ""),
      url: post.link,
      imageUrl: post.yoast_head_json?.og_image?.[0]?.url ?? null,
      excerpt: sanitizeText(post.excerpt?.rendered ?? post.yoast_head_json?.description ?? "").slice(0, 220) || null,
    }))
    .filter((hit) => {
      try {
        return !!hit.title && new URL(hit.url).hostname.toLowerCase().replace(/\.$/, "") === catalog.host;
      } catch {
        return false;
      }
    });
}

async function searchWordpressCatalog(
  catalog: CatalogDefinition,
  query: string,
  page: number,
): Promise<SearchHit[]> {
  const params = new URLSearchParams({
    per_page: "18",
    page: String(page),
    _fields: "id,link,title,excerpt,yoast_head_json",
    orderby: query.trim() ? "relevance" : "date",
  });
  if (query.trim()) params.set("search", query.trim());
  const url = `${catalog.origin}/wp-json/wp/v2/posts?${params.toString()}`;
  await politeGate(catalog.host);
  const res = await safeFetch(url, { accept: "application/json", timeoutMs: 10_000 });
  return wpHits(JSON.parse(res.body), catalog);
}

async function searchKetoFocus(catalog: CatalogDefinition, query: string, page: number): Promise<SearchHit[]> {
  const params = new URLSearchParams({
    per_page: "18",
    offset: String((page - 1) * 18),
    sort: query.trim() ? "relevance" : "popular",
  });
  if (query.trim()) params.set("search", query.trim());
  const url = `${catalog.origin}/wp-json/kf/v1/recipes?${params.toString()}`;
  await politeGate(catalog.host);
  const res = await safeFetch(url, { accept: "application/json", timeoutMs: 10_000 });
  const data = JSON.parse(res.body) as KetoFocusResponse;
  return (Array.isArray(data.recipes) ? data.recipes : [])
    .map((recipe) => {
      const details = [
        recipe.time ? `${sanitizeText(recipe.time)} min` : "",
        recipe.carbs !== "" && recipe.carbs != null ? `${sanitizeText(recipe.carbs)}g net carbs` : "",
        ...(Array.isArray(recipe.courses) ? recipe.courses.map((course) => sanitizeText(course)) : []),
      ].filter(Boolean);
      return {
        title: sanitizeText(recipe.title),
        url: sanitizeText(recipe.url),
        imageUrl: sanitizeImage(recipe.image ?? recipe.thumb, catalog.origin),
        excerpt: details.join(" · ") || null,
      };
    })
    .filter((hit) => {
      try {
        return !!hit.title && new URL(hit.url).hostname.toLowerCase().replace(/\.$/, "") === catalog.host;
      } catch {
        return false;
      }
    });
}

function sanitizeImage(value: unknown, base: string): string | null {
  const raw = sanitizeText(value);
  if (!raw) return null;
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Search a built-in publisher catalog. Eating on a Dime alone has demo data. */
export async function searchCatalog(
  query: string,
  page = 1,
  source: CatalogSource = "eatingonadime",
): Promise<CatalogResult> {
  const catalog = CATALOGS[source];
  const key = `${source}|${query.toLowerCase().trim()}|${page}`;
  const cached = searchCache.get(key);
  if (cached) return { ...cached };

  try {
    const hits =
      catalog.kind === "ketofocus"
        ? await searchKetoFocus(catalog, query, page)
        : await searchWordpressCatalog(catalog, query, page);
    if (!hits.length && page === 1 && source === "eatingonadime") {
      const fallback = { hits: demoHits(query), source: "demo" as const };
      return { ...fallback, notice: "No live results — showing the offline demo catalog." };
    }
    const result = { hits, source: "live" as const };
    searchCache.set(key, result);
    return result;
  } catch (err) {
    if (err instanceof RateLimited) throw err;
    if (source !== "eatingonadime") {
      const fallback = { hits: [], source: "live" as const };
      searchCache.set(key, fallback, 60_000);
      return {
        ...fallback,
        notice: `${catalog.label} could not be reached. Try again in a moment, or paste an individual recipe URL above.`,
      };
    }
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
 * Read a page as a recipe: the schema.org standard first, then the ReciMe
 * fallback for ReciMe's own share pages, which render client-side and publish
 * no JSON-LD.
 */
function parsePage(html: string, canonical: string, recime: boolean): ParsedRecipe | null {
  if (recime) {
    // Checked before parsing, and on the cached copy as well as a fresh one, so
    // a sign-in prompt can never be read as a recipe however it was obtained.
    const problem = recimeAccessProblem(200, html);
    if (problem) throw new FetchRejected(problem, 403);
  }
  return parseRecipeFromHtml(html, canonical) ?? (recime ? parseRecimeSharePage(html, canonical) : null);
}

/**
 * Import one recipe from any public recipe URL.
 * Throws FetchRejected for unsafe or unusable URLs.
 */
export async function importFromUrl(rawUrl: string): Promise<ImportResult> {
  const url = validateUrlShape(rawUrl);
  const host = url.hostname.toLowerCase();
  const canonical = url.toString();
  const recime = isRecimeUrl(url);

  const cachedHtml = pageCache.get(canonical);
  if (cachedHtml) {
    const parsed = parsePage(cachedHtml, canonical, recime);
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
    // A ReciMe link is never satisfied with an Eating on a Dime demo recipe,
    // and a refusal from ReciMe is worth explaining in ReciMe's own terms.
    if (recime && err instanceof FetchRejected) {
      const status = err.upstreamStatus ?? err.status;
      const problem = recimeAccessProblem(status, "");
      throw problem ? new FetchRejected(problem, status === 403 ? 403 : err.status) : err;
    }
    if (!recime) {
      const demo = demoImport(canonical);
      if (demo) return demo;
    }
    if (err instanceof FetchRejected || err instanceof RateLimited) throw err;
    throw new FetchRejected(`Could not load that page: ${(err as Error).message}`, 502);
  }

  const parsed = parsePage(html, canonical, recime);
  if (!parsed) {
    throw new FetchRejected(
      recime
        ? "That ReciMe page did not contain a readable recipe. Make sure the link is a shared recipe rather than a collection or profile page, or export the recipe from ReciMe as a PDF and import that instead."
        : "No structured recipe data (schema.org Recipe) was found on that page. Most major recipe sites publish it — try the printable or main recipe page URL.",
      422,
    );
  }
  return { recipe: parsed, sourceUrl: canonical, source: "live" };
}

export { FetchRejected, RateLimited };
