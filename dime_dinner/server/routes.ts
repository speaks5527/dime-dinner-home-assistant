import express, { type Express, type Request, type Response } from "express";
import type { Server } from "node:http";
import { z } from "zod";
import { storage } from "./storage";
import { aggregateIngredients, applyPantry, visibleLines } from "./lib/grocery";
import { parseIngredientLine, formatAmount } from "./lib/ingredients";
import {
  importFromUrl,
  searchCatalog,
  FetchRejected,
  RateLimited,
  type CatalogSource,
} from "./lib/source";
import { KrogerError, KROGER_DISCLAIMER, matchProducts, resolveLocation, resetKrogerCaches } from "./lib/kroger";
import {
  authStatus,
  buildAuthorizeUrl,
  disconnect as disconnectKroger,
  getCustomerAccessToken,
  KrogerAuthRequired,
  validateRedirectUri,
} from "./lib/krogerAuth";
import {
  addItemsToCart,
  CART_MODALITIES,
  KROGER_CART_URL,
  MAX_CART_QUANTITY,
  type CartModality,
} from "./lib/krogerCart";
import {
  createReview,
  deleteReview,
  getReview,
  isReady,
  patchReviewItem,
  selectedProduct,
  type ReviewLine,
} from "./lib/krogerReview";
import { callbackPort, krogerConfig, krogerRedirectUri, mealTimes, isValidTime, resetConfigCache } from "./lib/config";
import { buildIcs, type CalendarEvent } from "./lib/ics";
import { sanitizeText } from "./lib/recipeParser";
import { cancelJob, getJob, getThumbnail, startImport } from "./lib/importJobs";
import { MAX_PDF_BYTES, PdfToolError, sanitizeFilename, toolStatus } from "./lib/pdfTools";
import { buildRecimePdf, fetchCoverJpeg } from "./lib/recimePdf";
import { recimeFilename } from "@shared/recime";
import {
  DAY_NAMES,
  MEALS,
  type EbookSaveResult,
  type GroceryLine,
  type GroceryResponse,
  type InstructionGroup,
  type KrogerAuthState,
  type KrogerCartResult,
  type KrogerStatus,
  type PlanEntry,
  type PlanResponse,
  type RecipeDTO,
  type SearchResponse,
} from "@shared/schema";

const weekRe = /^\d{4}-\d{2}-\d{2}$/;

function fail(res: Response, err: unknown) {
  if (err instanceof FetchRejected || err instanceof KrogerError || err instanceof PdfToolError) {
    return res.status(err.status).json({ message: err.message });
  }
  if (err instanceof RateLimited) return res.status(429).json({ message: err.message });
  if (err instanceof z.ZodError) return res.status(400).json({ message: "Invalid request." });
  console.error(err);
  return res.status(500).json({ message: (err as Error).message ?? "Something went wrong." });
}

function requireWeek(value: unknown): string {
  const week = String(value ?? "");
  if (!weekRe.test(week)) throw new FetchRejected("A week start date (YYYY-MM-DD) is required.");
  return week;
}

function dateForDay(weekStart: string, day: number): string {
  const [y, m, d] = weekStart.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d) + day * 86_400_000;
  const out = new Date(base);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${out.getUTCFullYear()}-${pad(out.getUTCMonth() + 1)}-${pad(out.getUTCDate())}`;
}

function planEntries(weekStart: string): PlanEntry[] {
  const slots = storage.listPlan(weekStart);
  const entries: PlanEntry[] = [];
  for (const slot of slots) {
    const recipe = storage.getRecipe(slot.recipeId);
    if (!recipe) continue;
    entries.push({ id: slot.id, day: slot.day, meal: slot.meal as PlanEntry["meal"], recipe });
  }
  return entries.sort((a, b) => a.day - b.day || a.meal.localeCompare(b.meal));
}

function buildGrocery(weekStart: string): GroceryResponse {
  const entries = planEntries(weekStart);
  const seen = new Map<number, RecipeDTO>();
  for (const entry of entries) seen.set(entry.recipe.id, entry.recipe);

  const aggregated = aggregateIngredients(
    [...seen.values()].map((recipe) => ({ recipeTitle: recipe.title, lines: recipe.ingredients })),
  );
  const pantry = storage.listPantry();
  const overrides = new Set(storage.listOverrides(weekStart));
  const withPantry = applyPantry(aggregated, pantry, overrides);
  const checks = storage.listChecks(weekStart);
  const edits = storage.listEdits(weekStart);

  const lines: GroceryLine[] = visibleLines(withPantry).map((line) => ({
    key: line.key,
    name: line.name,
    display: edits[line.key] ?? line.display,
    aisle: line.aisle,
    checked: checks[line.key] ?? false,
    parts: line.parts.map((p) => ({ quantity: p.quantity, unit: p.unit })),
    sources: line.sources,
    editedAmount: edits[line.key] ?? null,
    pantry: line.pantry,
  }));

  return {
    weekStart,
    recipeCount: seen.size,
    lines,
    manual: storage.listManual(weekStart),
    pantryCoveredCount: withPantry.filter((l) => l.pantry && l.pantry.status !== "noted" && !l.pantry.overridden).length,
  };
}

/** Everything the Settings page needs to describe the Kroger account link. */
function krogerAuthState(): KrogerAuthState {
  const config = krogerConfig();
  const configured = krogerRedirectUri();
  const status = authStatus();

  let redirectUri = configured.value;
  let redirectUriValid = true;
  let redirectUriError: string | null = null;
  try {
    redirectUri = validateRedirectUri(configured.value);
  } catch (err) {
    redirectUriValid = false;
    redirectUriError = (err as Error).message;
  }

  const credentialsReady = !!(config.clientId && config.clientSecret);
  const message = !config.enabled
    ? "Turn Kroger on to connect an account."
    : !credentialsReady
      ? "Add your Kroger client ID and secret first."
      : !redirectUriValid
        ? "Fix the redirect URI before connecting."
        : !status.connected
          ? "Not connected. Connecting signs you in at Kroger and lets Dime Dinner build a cart for you to review."
          : !status.hasCartScope
            ? "Connected, but Kroger did not grant cart access. Enable the Cart API on your Kroger application and reconnect."
            : "Connected. Dime Dinner can build a cart for you to review.";

  return {
    connected: status.connected,
    connectedAt: status.connectedAt,
    canRefresh: status.canRefresh,
    hasCartScope: status.hasCartScope,
    scopes: status.scopes,
    redirectUri,
    redirectUriValid,
    redirectUriError,
    redirectUriManagedByAddonOptions: configured.managedByAddonOptions,
    callbackPort: callbackPort(),
    credentialsReady,
    message,
  };
}

/**
 * Grocery lines that are candidates for a Kroger cart: still unchecked, and
 * already filtered of anything the pantry covers by buildGrocery.
 */
function cartCandidateLines(weekStart: string): ReviewLine[] {
  const grocery = buildGrocery(weekStart);
  const lines: ReviewLine[] = grocery.lines
    .filter((line) => !line.checked)
    .map((line) => ({ key: line.key, name: line.name, requestedDisplay: line.display }));

  for (const item of grocery.manual) {
    if (item.checked === 1) continue;
    const parsed = parseIngredientLine(item.text);
    lines.push({
      key: `manual:${item.id}`,
      name: parsed.name || item.text,
      requestedDisplay: parsed.quantity != null ? formatAmount({ quantity: parsed.quantity, unit: parsed.unit }) : "",
    });
  }
  return lines;
}

/** Refuse to go near the Cart API unless there is a usable customer grant. */
function requireCartAccess(): { clientId: string; clientSecret: string } {
  const config = krogerConfig();
  if (!config.enabled) throw new KrogerError("Turn Kroger on first.", 400);
  if (!config.clientId || !config.clientSecret) {
    throw new KrogerError("Add your Kroger client ID and secret first.", 400);
  }
  const status = authStatus();
  if (!status.connected) throw new KrogerAuthRequired("Connect your Kroger account in Settings first.");
  if (!status.hasCartScope) {
    throw new KrogerError(
      "This Kroger sign-in did not include cart access. Enable the Cart API on your Kroger application, then disconnect and reconnect.",
      403,
    );
  }
  return { clientId: config.clientId, clientSecret: config.clientSecret };
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  /* ------------------------------- recipes ------------------------------- */

  app.get("/api/recipes", (_req, res) => {
    res.json(storage.listRecipes().sort((a, b) => b.importedAt - a.importedAt));
  });

  app.get("/api/recipes/:id", (req, res) => {
    const recipe = storage.getRecipe(Number(req.params.id));
    if (!recipe) return res.status(404).json({ message: "Recipe not found." });
    res.json(recipe);
  });

  app.patch("/api/recipes/:id", (req, res) => {
    const favorite = z.object({ favorite: z.boolean() }).safeParse(req.body);
    if (!favorite.success) return res.status(400).json({ message: "Invalid request." });
    const recipe = storage.setFavorite(Number(req.params.id), favorite.data.favorite);
    if (!recipe) return res.status(404).json({ message: "Recipe not found." });
    res.json(recipe);
  });

  app.delete("/api/recipes/:id", (req, res) => {
    storage.deleteRecipe(Number(req.params.id));
    res.json({ ok: true });
  });

  /**
   * One recipe as one printable PDF, laid out for a ReciMe import.
   *
   * Built here rather than in the browser so the link annotation and the
   * document metadata can be written properly, and generated entirely inside
   * the add-on — the only outbound request is for the recipe's own photo,
   * which goes through the same SSRF guard as everything else and is skipped
   * rather than retried if it fails. Nothing about the plan, the grocery list
   * or this install goes into the file.
   */
  app.get("/api/recipes/:id/recime.pdf", async (req, res) => {
    try {
      const recipe = storage.getRecipe(Number(req.params.id));
      if (!recipe) return res.status(404).json({ message: "Recipe not found." });

      const image = req.query.image === "0" ? null : await fetchCoverJpeg(recipe.imageUrl);
      const pdf = buildRecimePdf(recipe, { image });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${recimeFilename(recipe.title)}"`);
      res.setHeader("Content-Length", String(pdf.length));
      res.setHeader("Cache-Control", "no-store");
      res.end(pdf);
    } catch (err) {
      fail(res, err);
    }
  });

  /* -------------------------------- search ------------------------------- */

  app.get("/api/search", async (req, res) => {
    try {
      const query = sanitizeText(String(req.query.q ?? "")).slice(0, 80);
      const page = Math.min(Math.max(Number(req.query.page ?? 1) || 1, 1), 10);
      const requestedSource = String(req.query.source ?? "eatingonadime");
      const source: CatalogSource =
        requestedSource === "ajgreats" || requestedSource === "ketofocus"
          ? requestedSource
          : "eatingonadime";
      const result = await searchCatalog(query, page, source);
      const saved = storage.listRecipes();
      const byUrl = new Map(saved.map((r) => [r.sourceUrl.replace(/\/+$/, ""), r.id]));
      const payload: SearchResponse = {
        query,
        source: result.source,
        notice: result.notice,
        results: result.hits.map((hit) => ({
          ...hit,
          savedId: byUrl.get(hit.url.replace(/\/+$/, "")) ?? null,
        })),
      };
      res.json(payload);
    } catch (err) {
      fail(res, err);
    }
  });

  /* -------------------------------- import ------------------------------- */

  app.post("/api/import", async (req, res) => {
    try {
      const body = z.object({ url: z.string().min(4).max(2048) }).parse(req.body);
      const result = await importFromUrl(body.url);
      const saved = storage.upsertRecipe({ ...result.recipe, sourceUrl: result.sourceUrl });
      res.json({ recipe: saved, source: result.source, notice: result.notice });
    } catch (err) {
      fail(res, err);
    }
  });

  /* ----------------------------- ebook import ----------------------------- */

  /**
   * Reading an ebook takes minutes, so these routes only ever start work and
   * report on it. Nothing here writes a recipe: the job holds candidates in
   * memory until the user picks from them at /api/ebook/:id/save.
   */

  app.get("/api/ebook/tools", async (_req, res) => {
    try {
      res.json(await toolStatus());
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/ebook/url", (req, res) => {
    try {
      const body = z.object({ url: z.string().min(4).max(2048) }).parse(req.body);
      res.json(startImport({ kind: "url", url: body.url }));
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * The PDF arrives as a raw body rather than multipart: it is a single file
   * with no other fields, so a parser dependency would buy nothing. Express
   * enforces the size cap before the body reaches this handler.
   */
  app.post(
    "/api/ebook/upload",
    express.raw({ type: ["application/pdf", "application/octet-stream"], limit: MAX_PDF_BYTES }),
    (req, res) => {
      try {
        const data = req.body;
        if (!Buffer.isBuffer(data) || !data.length) {
          throw new PdfToolError("No PDF was received. Choose a file and try again.", 400);
        }
        if (!data.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
          throw new PdfToolError("That file is not a PDF.", 415);
        }
        const filename = sanitizeFilename(String(req.query.filename ?? "ebook.pdf"), "ebook.pdf");
        res.json(startImport({ kind: "upload", filename, data }));
      } catch (err) {
        fail(res, err);
      }
    },
  );

  app.get("/api/ebook/:id", (req, res) => {
    const job = getJob(String(req.params.id));
    if (!job) return res.status(404).json({ message: "That import has expired or was cancelled." });
    res.json(job);
  });

  app.delete("/api/ebook/:id", (req, res) => {
    const cancelled = cancelJob(String(req.params.id));
    if (!cancelled) return res.status(404).json({ message: "That import is no longer running." });
    res.json({ ok: true });
  });

  /** Ephemeral page previews. They live in the job and die with it. */
  app.get("/api/ebook/:id/page/:page.png", (req, res) => {
    const page = Number(req.params.page);
    if (!Number.isInteger(page) || page < 1) return res.status(400).end();
    const png = getThumbnail(String(req.params.id), page);
    if (!png) return res.status(404).end();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(png);
  });

  /**
   * Save the recipes the user selected — and only those.
   *
   * Like the Kroger cart confirm, this needs an explicit flag and the count the
   * user was shown, so a job that changed underneath the review cannot cause
   * something unseen to be written. Titles, ingredients and steps come from the
   * request because the review screen lets the user correct OCR before saving.
   */
  app.post("/api/ebook/:id/save", (req, res) => {
    try {
      const body = z
        .object({
          confirm: z.literal(true),
          selections: z
            .array(
              z.object({
                id: z.string().min(1).max(64),
                title: z.string().min(1).max(200),
                ingredients: z.array(z.string().min(1).max(400)).min(1).max(120),
                instructions: z
                  .array(
                    z.object({
                      heading: z.string().max(120).optional(),
                      steps: z.array(z.object({ text: z.string().min(1).max(2000) })).min(1),
                    }),
                  )
                  .min(1)
                  .max(20),
                description: z.string().max(2000).nullish(),
                servings: z.string().max(120).nullish(),
                totalMinutes: z.number().int().min(0).max(100_000).nullish(),
              }),
            )
            .min(1)
            .max(60),
        })
        .parse(req.body);

      const id = String(req.params.id);
      const job = getJob(id);
      if (!job) throw new PdfToolError("That import has expired. Run it again to pick recipes.", 410);
      if (job.phase !== "ready") throw new PdfToolError("That import is not finished yet.", 409);

      const byId = new Map(job.candidates.map((c) => [c.id, c]));
      const saved: RecipeDTO[] = [];
      const skipped: EbookSaveResult["skipped"] = [];

      for (const selection of body.selections) {
        const candidate = byId.get(selection.id);
        if (!candidate) {
          skipped.push({ title: selection.title, reason: "No longer part of this import." });
          continue;
        }

        const instructions: InstructionGroup[] = selection.instructions.map((group) => ({
          ...(group.heading ? { heading: sanitizeText(group.heading) } : {}),
          steps: group.steps.map((step) => ({ text: sanitizeText(step.text) })).filter((s) => s.text),
        }));

        // The source is the book, not a page that can be re-fetched. A stable
        // per-page key keeps re-importing the same recipe an update rather than
        // a duplicate, and keeps the attribution attached to the recipe. A
        // ReciMe export is one recipe, so it is keyed by the whole document —
        // by the share link it printed when it printed one.
        const sourceUrl = job.recime
          ? (job.sourceUrl ?? `dime-dinner:recime/${encodeURIComponent(job.filename)}`)
          : job.sourceUrl
            ? `${job.sourceUrl}#page=${candidate.pages[0]}`
            : `dime-dinner:ebook/${encodeURIComponent(job.filename)}#page=${candidate.pages[0]}`;

        saved.push(
          storage.upsertRecipe({
            sourceUrl,
            title: sanitizeText(selection.title),
            description: selection.description ? sanitizeText(selection.description) : candidate.description,
            // Book pages are the publisher's artwork, so nothing is copied out
            // of the PDF — only the text the user reviewed is kept.
            imageUrl: null,
            author: job.author,
            prepMinutes: null,
            cookMinutes: null,
            totalMinutes: selection.totalMinutes ?? candidate.totalMinutes,
            servings: selection.servings ? sanitizeText(selection.servings) : candidate.servings,
            categories: [],
            cuisines: [],
            ingredients: selection.ingredients.map((line) => sanitizeText(line)).filter(Boolean),
            instructions: instructions.filter((group) => group.steps.length),
            nutrition: candidate.nutrition,
            siteName: job.recime ? "ReciMe" : (job.title ?? job.filename),
          }),
        );
      }

      const payload: EbookSaveResult = { saved, skipped };
      res.json(payload);
    } catch (err) {
      fail(res, err);
    }
  });

  /* --------------------------------- plan -------------------------------- */

  app.get("/api/plan/:weekStart", (req, res) => {
    try {
      const weekStart = requireWeek(req.params.weekStart);
      const payload: PlanResponse = { weekStart, entries: planEntries(weekStart) };
      res.json(payload);
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/plan/:weekStart", (req, res) => {
    try {
      const weekStart = requireWeek(req.params.weekStart);
      const body = z
        .object({
          day: z.number().int().min(0).max(6),
          meal: z.enum(MEALS),
          recipeId: z.number().int().positive(),
        })
        .parse(req.body);
      if (!storage.getRecipe(body.recipeId)) return res.status(404).json({ message: "Recipe not found." });
      storage.setPlanSlot({ weekStart, ...body });
      res.json({ weekStart, entries: planEntries(weekStart) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/plan/:weekStart/:day/:meal", (req, res) => {
    try {
      const weekStart = requireWeek(req.params.weekStart);
      storage.clearPlanSlot(weekStart, Number(req.params.day), String(req.params.meal));
      res.json({ weekStart, entries: planEntries(weekStart) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/plan/:weekStart/clear", (req, res) => {
    try {
      const weekStart = requireWeek(req.params.weekStart);
      storage.clearWeek(weekStart);
      res.json({ weekStart, entries: [] });
    } catch (err) {
      fail(res, err);
    }
  });

  /** Weekly plan as an .ics calendar file. */
  app.get("/api/plan/:weekStart/calendar.ics", (req, res) => {
    try {
      const weekStart = requireWeek(req.params.weekStart);
      const times = mealTimes();
      const events: CalendarEvent[] = planEntries(weekStart).map((entry) => ({
        uid: `dime-dinner-${weekStart}-${entry.day}-${entry.meal}@dime-dinner`,
        date: dateForDay(weekStart, entry.day),
        time: entry.meal === "lunch" ? times.lunch : times.dinner,
        durationMinutes: 60,
        summary: `${entry.meal === "lunch" ? "Lunch" : "Dinner"}: ${entry.recipe.title}`,
        description: [
          entry.recipe.description ?? "",
          entry.recipe.totalMinutes ? `Total time: ${entry.recipe.totalMinutes} min` : "",
          entry.recipe.servings ? `Serves: ${entry.recipe.servings}` : "",
          `Source: ${entry.recipe.sourceUrl}`,
        ]
          .filter(Boolean)
          .join("\n"),
        url: entry.recipe.sourceUrl,
      }));
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="dime-dinner-${weekStart}.ics"`);
      res.send(buildIcs(events, times.timezone));
    } catch (err) {
      fail(res, err);
    }
  });

  /* ------------------------------- grocery ------------------------------- */

  app.get("/api/grocery/:weekStart", (req, res) => {
    try {
      res.json(buildGrocery(requireWeek(req.params.weekStart)));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/grocery/:weekStart/check", (req, res) => {
    try {
      const weekStart = requireWeek(req.params.weekStart);
      const body = z.object({ itemKey: z.string().min(1), checked: z.boolean() }).parse(req.body);
      storage.setCheck(weekStart, body.itemKey, body.checked);
      res.json(buildGrocery(weekStart));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/grocery/:weekStart/amount", (req, res) => {
    try {
      const weekStart = requireWeek(req.params.weekStart);
      const body = z.object({ itemKey: z.string().min(1), amount: z.string().max(60).nullable() }).parse(req.body);
      storage.setEdit(weekStart, body.itemKey, body.amount ? sanitizeText(body.amount) : null);
      res.json(buildGrocery(weekStart));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/grocery/:weekStart/override", (req, res) => {
    try {
      const weekStart = requireWeek(req.params.weekStart);
      const body = z.object({ itemKey: z.string().min(1), override: z.boolean() }).parse(req.body);
      storage.setOverride(weekStart, body.itemKey, body.override);
      res.json(buildGrocery(weekStart));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/grocery/:weekStart/manual", (req, res) => {
    try {
      const weekStart = requireWeek(req.params.weekStart);
      const body = z.object({ text: z.string().min(1).max(120) }).parse(req.body);
      storage.addManual(weekStart, sanitizeText(body.text));
      res.json(buildGrocery(weekStart));
    } catch (err) {
      fail(res, err);
    }
  });

  app.patch("/api/grocery/:weekStart/manual/:id", (req, res) => {
    try {
      const weekStart = requireWeek(req.params.weekStart);
      const body = z
        .object({ text: z.string().min(1).max(120).optional(), checked: z.boolean().optional() })
        .parse(req.body);
      storage.updateManual(Number(req.params.id), {
        ...(body.text !== undefined ? { text: sanitizeText(body.text) } : {}),
        ...(body.checked !== undefined ? { checked: body.checked } : {}),
      });
      res.json(buildGrocery(weekStart));
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/grocery/:weekStart/manual/:id", (req, res) => {
    try {
      const weekStart = requireWeek(req.params.weekStart);
      storage.deleteManual(Number(req.params.id));
      res.json(buildGrocery(weekStart));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/grocery/:weekStart/clear-checks", (req, res) => {
    try {
      const weekStart = requireWeek(req.params.weekStart);
      storage.clearChecks(weekStart);
      res.json(buildGrocery(weekStart));
    } catch (err) {
      fail(res, err);
    }
  });

  /* -------------------------------- pantry ------------------------------- */

  app.get("/api/pantry", (_req, res) => res.json(storage.listPantry()));

  app.post("/api/pantry", (req, res) => {
    try {
      const body = z
        .object({
          name: z.string().min(1).max(80),
          quantity: z.number().nonnegative().nullable().optional(),
          unit: z.string().max(20).nullable().optional(),
          note: z.string().max(120).nullable().optional(),
        })
        .parse(req.body);
      const item = storage.addPantry({
        name: sanitizeText(body.name),
        quantity: body.quantity ?? null,
        unit: body.unit ? sanitizeText(body.unit) : null,
        note: body.note ? sanitizeText(body.note) : null,
      });
      res.json(item);
    } catch (err) {
      fail(res, err);
    }
  });

  app.patch("/api/pantry/:id", (req, res) => {
    try {
      const body = z
        .object({
          name: z.string().min(1).max(80).optional(),
          quantity: z.number().nonnegative().nullable().optional(),
          unit: z.string().max(20).nullable().optional(),
          note: z.string().max(120).nullable().optional(),
        })
        .parse(req.body);
      const item = storage.updatePantry(Number(req.params.id), body);
      if (!item) return res.status(404).json({ message: "Pantry item not found." });
      res.json(item);
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/pantry/:id", (req, res) => {
    storage.deletePantry(Number(req.params.id));
    res.json({ ok: true });
  });

  /**
   * Explicit, user-initiated transfer of purchased (checked) items into the
   * pantry. Nothing moves automatically.
   */
  app.post("/api/pantry/transfer", (req, res) => {
    try {
      const body = z
        .object({
          weekStart: z.string().regex(weekRe),
          keys: z.array(z.string().min(1)).optional(),
          includeManual: z.boolean().optional(),
          clearChecks: z.boolean().optional(),
        })
        .parse(req.body);

      const grocery = buildGrocery(body.weekStart);
      const wanted = body.keys?.length ? new Set(body.keys) : null;
      const moved: string[] = [];

      for (const line of grocery.lines) {
        if (!line.checked) continue;
        if (wanted && !wanted.has(line.key)) continue;
        const first = line.parts[0];
        storage.addPantry({
          name: line.name,
          quantity: first?.quantity ?? null,
          unit: first?.unit ?? null,
          note: "Added from grocery list",
        });
        moved.push(line.name);
      }

      if (body.includeManual) {
        for (const item of grocery.manual) {
          if (item.checked !== 1) continue;
          const parsed = parseIngredientLine(item.text);
          storage.addPantry({
            name: parsed.name,
            quantity: parsed.quantity,
            unit: parsed.unit,
            note: "Added from grocery list",
          });
          moved.push(parsed.name);
        }
      }

      if (body.clearChecks) storage.clearChecks(body.weekStart);
      res.json({ moved, count: moved.length, grocery: buildGrocery(body.weekStart) });
    } catch (err) {
      fail(res, err);
    }
  });

  /* ------------------------------- settings ------------------------------ */

  app.get("/api/settings", (_req, res) => {
    const kroger = krogerConfig();
    const times = mealTimes();
    const status: KrogerStatus = {
      enabled: kroger.enabled,
      configured: !!(kroger.clientId && kroger.clientSecret && (kroger.zip || kroger.locationId)),
      hasClientSecret: !!kroger.clientSecret,
      clientId: kroger.clientId,
      zip: kroger.zip,
      locationId: kroger.locationId,
      managedByAddonOptions: kroger.managedByAddonOptions,
      message: kroger.enabled
        ? kroger.clientId && kroger.clientSecret
          ? "Kroger lookups are ready."
          : "Add a client ID and secret to enable product lookups."
        : "Kroger integration is off. The rest of Dime Dinner works without it.",
    };
    res.json({ kroger: status, krogerAuth: krogerAuthState(), mealTimes: times });
  });

  app.post("/api/settings", (req, res) => {
    try {
      const body = z
        .object({
          kroger: z
            .object({
              enabled: z.boolean().optional(),
              clientId: z.string().max(200).optional(),
              clientSecret: z.string().max(200).optional(),
              zip: z.string().max(10).optional(),
              locationId: z.string().max(20).optional(),
              redirectUri: z.string().max(300).optional(),
            })
            .optional(),
          mealTimes: z
            .object({
              lunch: z.string().max(5).optional(),
              dinner: z.string().max(5).optional(),
              timezone: z.string().max(64).optional(),
            })
            .optional(),
        })
        .parse(req.body);

      if (body.kroger) {
        const k = body.kroger;
        if (k.enabled !== undefined) storage.setSetting("kroger.enabled", String(k.enabled));
        if (k.clientId !== undefined) storage.setSetting("kroger.clientId", k.clientId.trim());
        if (k.clientSecret !== undefined && k.clientSecret !== "") {
          storage.setSetting("kroger.clientSecret", k.clientSecret.trim());
        }
        if (k.zip !== undefined) storage.setSetting("kroger.zip", k.zip.trim());
        if (k.locationId !== undefined) storage.setSetting("kroger.locationId", k.locationId.trim());
        if (k.redirectUri !== undefined) {
          // Reject a malformed value here rather than letting it fail later as
          // an opaque redirect_uri_mismatch from Kroger.
          storage.setSetting("kroger.redirectUri", k.redirectUri.trim() ? validateRedirectUri(k.redirectUri) : "");
        }
        resetKrogerCaches();
      }
      if (body.mealTimes) {
        const t = body.mealTimes;
        if (t.lunch && isValidTime(t.lunch)) storage.setSetting("meal.lunchTime", t.lunch);
        if (t.dinner && isValidTime(t.dinner)) storage.setSetting("meal.dinnerTime", t.dinner);
        if (t.timezone) storage.setSetting("app.timezone", t.timezone.trim());
      }
      resetConfigCache();
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/settings/kroger/clear", (_req, res) => {
    for (const key of [
      "kroger.enabled",
      "kroger.clientId",
      "kroger.clientSecret",
      "kroger.zip",
      "kroger.locationId",
      "kroger.redirectUri",
    ]) {
      storage.deleteSetting(key);
    }
    // The customer grant belongs to the application being cleared, so it goes too.
    disconnectKroger();
    resetKrogerCaches();
    resetConfigCache();
    res.json({ ok: true });
  });

  /* -------------------------------- kroger ------------------------------- */

  app.post("/api/kroger/test", async (_req, res) => {
    try {
      const config = krogerConfig();
      if (!config.enabled) throw new KrogerError("Turn Kroger on first.", 400);
      const location = await resolveLocation(config);
      res.json({
        ok: true,
        locationId: location?.locationId ?? null,
        locationName: location?.name ?? null,
        message: location ? `Connected to ${location.name}.` : "Connected, but no store matched that ZIP.",
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/kroger/match", async (req, res) => {
    try {
      const term = sanitizeText(String(req.query.term ?? "")).slice(0, 60);
      const config = krogerConfig();
      const { products, locationId } = await matchProducts(config, term);
      res.json({ term, locationId, products, disclaimer: KROGER_DISCLAIMER });
    } catch (err) {
      fail(res, err);
    }
  });

  /* --------------------------- kroger account --------------------------- */

  app.get("/api/kroger/auth/status", (_req, res) => res.json(krogerAuthState()));

  /**
   * Hand the client a consent URL to open. The URL is built here so the client
   * ID, the scopes and the redirect URI all come from server configuration and
   * none of them can be influenced by the request.
   */
  app.post("/api/kroger/auth/start", (_req, res) => {
    try {
      const config = krogerConfig();
      if (!config.enabled) throw new KrogerError("Turn Kroger on first.", 400);
      const redirectUri = validateRedirectUri(krogerRedirectUri().value);
      const { url } = buildAuthorizeUrl(
        { clientId: config.clientId, clientSecret: config.clientSecret },
        redirectUri,
      );
      res.json({ authorizeUrl: url, redirectUri });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/kroger/auth/disconnect", (_req, res) => {
    disconnectKroger();
    res.json({ ok: true, auth: krogerAuthState() });
  });

  /* ----------------------------- kroger cart ---------------------------- */

  /** Build a review. This reads products only; it never touches the cart. */
  app.post("/api/kroger/cart/review", async (req, res) => {
    try {
      requireCartAccess();
      const body = z.object({ weekStart: z.string().regex(weekRe) }).parse(req.body);
      const config = krogerConfig();
      const location = await resolveLocation(config);
      const review = await createReview({
        weekStart: body.weekStart,
        locationId: location?.locationId ?? null,
        locationName: location?.name ?? null,
        lines: cartCandidateLines(body.weekStart),
        matcher: async (term) => (await matchProducts(config, term, 6)).products,
        disclaimer: KROGER_DISCLAIMER,
      });
      res.json(review);
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/kroger/cart/review/:id", (req, res) => {
    try {
      res.json(getReview(String(req.params.id)));
    } catch (err) {
      fail(res, err);
    }
  });

  app.patch("/api/kroger/cart/review/:id/items/:key", (req, res) => {
    try {
      const body = z
        .object({
          selectedUpc: z.string().max(32).nullable().optional(),
          quantity: z.number().int().min(1).max(MAX_CART_QUANTITY).optional(),
          modality: z.enum(CART_MODALITIES).optional(),
          allowSubstitutes: z.boolean().optional(),
          skipped: z.boolean().optional(),
        })
        .parse(req.body);
      res.json(patchReviewItem(String(req.params.id), String(req.params.key), body));
    } catch (err) {
      fail(res, err);
    }
  });

  /** Widen the candidate list for one item with a user-supplied search term. */
  app.post("/api/kroger/cart/review/:id/items/:key/search", async (req, res) => {
    try {
      requireCartAccess();
      const body = z.object({ term: z.string().min(1).max(60) }).parse(req.body);
      const term = sanitizeText(body.term).slice(0, 60);
      const { products } = await matchProducts(krogerConfig(), term, 8);
      res.json(patchReviewItem(String(req.params.id), String(req.params.key), { addCandidates: products }));
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/kroger/cart/review/:id", (req, res) => {
    deleteReview(String(req.params.id));
    res.json({ ok: true });
  });

  /**
   * The only route that writes to a Kroger cart.
   *
   * It requires an explicit confirmation flag plus the item count the user was
   * actually shown: if the review changed after the summary was rendered, the
   * count no longer agrees and the request is refused rather than adding
   * something the user did not see. Items still needing a decision block the
   * whole request, so an ambiguous match can never slip through.
   */
  app.post("/api/kroger/cart/review/:id/confirm", async (req, res) => {
    try {
      const credentials = requireCartAccess();
      const body = z
        .object({ confirm: z.literal(true), itemCount: z.number().int().min(1) })
        .parse(req.body);

      const id = String(req.params.id);
      const review = getReview(id);
      if (review.needsAttentionCount > 0) {
        throw new KrogerError(
          `${review.needsAttentionCount} item${review.needsAttentionCount === 1 ? "" : "s"} still need${review.needsAttentionCount === 1 ? "s" : ""} a product chosen or skipped.`,
          409,
        );
      }
      if (review.readyCount === 0) throw new KrogerError("Nothing is selected to add.", 400);
      if (body.itemCount !== review.readyCount) {
        throw new KrogerError(
          `This list changed since you reviewed it — it now has ${review.readyCount} item${review.readyCount === 1 ? "" : "s"}. Check it over and confirm again.`,
          409,
        );
      }

      const ready = review.items.filter(isReady);
      const outcome = await addItemsToCart(
        () => getCustomerAccessToken(credentials),
        ready.map((item) => ({
          key: item.key,
          name: item.name,
          upc: selectedProduct(item)!.upc,
          quantity: item.quantity,
          modality: item.modality as CartModality,
        })),
      );

      // Once anything is in the cart, re-running would double it up, so the
      // review is discarded. A run that added nothing is left alone so the user
      // can retry; it expires on its own either way.
      if (outcome.addedCount > 0) deleteReview(id);

      const payload: KrogerCartResult = {
        addedCount: outcome.addedCount,
        failedCount: outcome.failedCount,
        results: outcome.results,
        noSubstitutionReminders: ready.filter((item) => !item.allowSubstitutes).map((item) => item.name),
        authExpired: outcome.authExpired,
        cartUrl: KROGER_CART_URL,
      };
      res.json(payload);
    } catch (err) {
      fail(res, err);
    }
  });

  /* --------------------------------- meta -------------------------------- */

  app.get("/api/meta", (_req, res) => {
    res.json({
      days: DAY_NAMES,
      meals: MEALS,
      attribution:
        "Recipes are fetched on demand from their publishers. Eating on a Dime, AJ Greats, and KetoFocus are built-in browse sources. Dime Dinner is an independent personal tool and is not affiliated with, endorsed by, or sponsored by those publishers, Kroger, or Skylight.",
    });
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  return httpServer;
}

export { buildGrocery, formatAmount };
