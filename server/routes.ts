import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { z } from "zod";
import { storage } from "./storage";
import { aggregateIngredients, applyPantry, visibleLines } from "./lib/grocery";
import { parseIngredientLine, formatAmount } from "./lib/ingredients";
import { importFromUrl, searchCatalog, FetchRejected, RateLimited } from "./lib/source";
import { KrogerError, KROGER_DISCLAIMER, matchProducts, resolveLocation, resetKrogerCaches } from "./lib/kroger";
import { krogerConfig, mealTimes, isValidTime, resetConfigCache } from "./lib/config";
import { buildIcs, type CalendarEvent } from "./lib/ics";
import { sanitizeText } from "./lib/recipeParser";
import {
  DAY_NAMES,
  MEALS,
  type GroceryLine,
  type GroceryResponse,
  type KrogerStatus,
  type PlanEntry,
  type PlanResponse,
  type RecipeDTO,
  type SearchResponse,
} from "@shared/schema";

const weekRe = /^\d{4}-\d{2}-\d{2}$/;

function fail(res: Response, err: unknown) {
  if (err instanceof FetchRejected || err instanceof KrogerError) {
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

  /* -------------------------------- search ------------------------------- */

  app.get("/api/search", async (req, res) => {
    try {
      const query = sanitizeText(String(req.query.q ?? "")).slice(0, 80);
      const page = Math.min(Math.max(Number(req.query.page ?? 1) || 1, 1), 10);
      const result = await searchCatalog(query, page);
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
    res.json({ kroger: status, mealTimes: times });
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
    for (const key of ["kroger.enabled", "kroger.clientId", "kroger.clientSecret", "kroger.zip", "kroger.locationId"]) {
      storage.deleteSetting(key);
    }
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

  /* --------------------------------- meta -------------------------------- */

  app.get("/api/meta", (_req, res) => {
    res.json({
      days: DAY_NAMES,
      meals: MEALS,
      attribution:
        "Recipes are fetched on demand from their publishers. Eating on a Dime is the built-in browse source. Dime Dinner is an independent personal tool and is not affiliated with, endorsed by, or sponsored by Eating on a Dime, Kroger, or Skylight.",
    });
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  return httpServer;
}

export { buildGrocery, formatAmount };
