/**
 * SQLite persistence.
 *
 * Data lives in /data (the Home Assistant add-on persistent volume) when that
 * directory is writable, otherwise in ./data locally for development.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import {
  groceryChecks,
  groceryEdits,
  manualItems,
  pantryItems,
  pantryOverrides,
  planSlots,
  recipes,
  settings,
  type InsertPlanSlot,
  type PantryItem,
  type PlanSlot,
  type Recipe,
  type RecipeDTO,
  type ManualItem,
  type InstructionGroup,
} from "@shared/schema";
import { pantryKey } from "./lib/grocery";

function resolveDbPath(): string {
  const explicit = process.env.DIME_DINNER_DB;
  if (explicit) return explicit;
  const haData = "/data";
  try {
    fs.accessSync(haData, fs.constants.W_OK);
    return path.join(haData, "dime-dinner.db");
  } catch {
    const local = path.resolve(process.cwd(), "data");
    fs.mkdirSync(local, { recursive: true });
    return path.join(local, "dime-dinner.db");
  }
}

export const DB_PATH = resolveDbPath();
const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

sqlite.exec(`
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  author TEXT,
  prep_minutes INTEGER,
  cook_minutes INTEGER,
  total_minutes INTEGER,
  servings TEXT,
  categories TEXT NOT NULL DEFAULT '[]',
  cuisines TEXT NOT NULL DEFAULT '[]',
  ingredients TEXT NOT NULL DEFAULT '[]',
  instructions TEXT NOT NULL DEFAULT '[]',
  nutrition TEXT,
  site_name TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  imported_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  day INTEGER NOT NULL,
  meal TEXT NOT NULL,
  recipe_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grocery_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  item_key TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS grocery_checks_week_key ON grocery_checks (week_start, item_key);
CREATE TABLE IF NOT EXISTS grocery_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  item_key TEXT NOT NULL,
  amount TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS grocery_edits_week_key ON grocery_edits (week_start, item_key);
CREATE TABLE IF NOT EXISTS manual_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  text TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pantry_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity REAL,
  unit TEXT,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS pantry_items_key ON pantry_items (item_key, unit);
CREATE TABLE IF NOT EXISTS pantry_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  item_key TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pantry_overrides_week_key ON pantry_overrides (week_start, item_key);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export const db = drizzle(sqlite);

/* ------------------------------- helpers -------------------------------- */

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toDTO(row: Recipe): RecipeDTO {
  return {
    ...row,
    categories: parseJson<string[]>(row.categories, []),
    cuisines: parseJson<string[]>(row.cuisines, []),
    ingredients: parseJson<string[]>(row.ingredients, []),
    instructions: parseJson<InstructionGroup[]>(row.instructions, []),
    nutrition: parseJson<Record<string, string> | null>(row.nutrition, null),
    favorite: row.favorite === 1,
  };
}

export type NewRecipeInput = {
  sourceUrl: string;
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

/* -------------------------------- recipes -------------------------------- */

export const storage = {
  listRecipes(): RecipeDTO[] {
    return db.select().from(recipes).all().map(toDTO);
  },

  getRecipe(id: number): RecipeDTO | undefined {
    const row = db.select().from(recipes).where(eq(recipes.id, id)).get();
    return row ? toDTO(row) : undefined;
  },

  getRecipeByUrl(url: string): RecipeDTO | undefined {
    const row = db.select().from(recipes).where(eq(recipes.sourceUrl, url)).get();
    return row ? toDTO(row) : undefined;
  },

  upsertRecipe(input: NewRecipeInput): RecipeDTO {
    const existing = db.select().from(recipes).where(eq(recipes.sourceUrl, input.sourceUrl)).get();
    const values = {
      sourceUrl: input.sourceUrl,
      title: input.title,
      description: input.description,
      imageUrl: input.imageUrl,
      author: input.author,
      prepMinutes: input.prepMinutes,
      cookMinutes: input.cookMinutes,
      totalMinutes: input.totalMinutes,
      servings: input.servings,
      categories: JSON.stringify(input.categories),
      cuisines: JSON.stringify(input.cuisines),
      ingredients: JSON.stringify(input.ingredients),
      instructions: JSON.stringify(input.instructions),
      nutrition: input.nutrition ? JSON.stringify(input.nutrition) : null,
      siteName: input.siteName,
      importedAt: Date.now(),
    };
    if (existing) {
      db.update(recipes).set(values).where(eq(recipes.id, existing.id)).run();
      return this.getRecipe(existing.id)!;
    }
    const row = db.insert(recipes).values({ ...values, favorite: 0 }).returning().get();
    return toDTO(row);
  },

  setFavorite(id: number, favorite: boolean): RecipeDTO | undefined {
    db.update(recipes).set({ favorite: favorite ? 1 : 0 }).where(eq(recipes.id, id)).run();
    return this.getRecipe(id);
  },

  deleteRecipe(id: number): void {
    db.delete(planSlots).where(eq(planSlots.recipeId, id)).run();
    db.delete(recipes).where(eq(recipes.id, id)).run();
  },

  /* --------------------------------- plan --------------------------------- */

  listPlan(weekStart: string): PlanSlot[] {
    return db.select().from(planSlots).where(eq(planSlots.weekStart, weekStart)).all();
  },

  setPlanSlot(input: InsertPlanSlot): PlanSlot {
    const existing = db
      .select()
      .from(planSlots)
      .where(
        and(
          eq(planSlots.weekStart, input.weekStart),
          eq(planSlots.day, input.day),
          eq(planSlots.meal, input.meal),
        ),
      )
      .get();
    if (existing) {
      db.update(planSlots).set({ recipeId: input.recipeId }).where(eq(planSlots.id, existing.id)).run();
      return { ...existing, recipeId: input.recipeId };
    }
    return db.insert(planSlots).values(input).returning().get();
  },

  clearPlanSlot(weekStart: string, day: number, meal: string): void {
    db.delete(planSlots)
      .where(and(eq(planSlots.weekStart, weekStart), eq(planSlots.day, day), eq(planSlots.meal, meal)))
      .run();
  },

  clearWeek(weekStart: string): void {
    db.delete(planSlots).where(eq(planSlots.weekStart, weekStart)).run();
  },

  /* ------------------------------- grocery -------------------------------- */

  listChecks(weekStart: string): Record<string, boolean> {
    const rows = db.select().from(groceryChecks).where(eq(groceryChecks.weekStart, weekStart)).all();
    return Object.fromEntries(rows.map((r) => [r.itemKey, r.checked === 1]));
  },

  setCheck(weekStart: string, itemKey: string, checked: boolean): void {
    const existing = db
      .select()
      .from(groceryChecks)
      .where(and(eq(groceryChecks.weekStart, weekStart), eq(groceryChecks.itemKey, itemKey)))
      .get();
    if (existing) {
      db.update(groceryChecks).set({ checked: checked ? 1 : 0 }).where(eq(groceryChecks.id, existing.id)).run();
    } else {
      db.insert(groceryChecks).values({ weekStart, itemKey, checked: checked ? 1 : 0 }).run();
    }
  },

  clearChecks(weekStart: string): void {
    db.delete(groceryChecks).where(eq(groceryChecks.weekStart, weekStart)).run();
  },

  listEdits(weekStart: string): Record<string, string> {
    const rows = db.select().from(groceryEdits).where(eq(groceryEdits.weekStart, weekStart)).all();
    return Object.fromEntries(rows.map((r) => [r.itemKey, r.amount]));
  },

  setEdit(weekStart: string, itemKey: string, amount: string | null): void {
    const existing = db
      .select()
      .from(groceryEdits)
      .where(and(eq(groceryEdits.weekStart, weekStart), eq(groceryEdits.itemKey, itemKey)))
      .get();
    if (!amount) {
      if (existing) db.delete(groceryEdits).where(eq(groceryEdits.id, existing.id)).run();
      return;
    }
    if (existing) db.update(groceryEdits).set({ amount }).where(eq(groceryEdits.id, existing.id)).run();
    else db.insert(groceryEdits).values({ weekStart, itemKey, amount }).run();
  },

  listManual(weekStart: string): ManualItem[] {
    return db.select().from(manualItems).where(eq(manualItems.weekStart, weekStart)).all();
  },

  addManual(weekStart: string, text: string): ManualItem {
    return db.insert(manualItems).values({ weekStart, text, checked: 0 }).returning().get();
  },

  updateManual(id: number, patch: { text?: string; checked?: boolean }): ManualItem | undefined {
    const values: Record<string, unknown> = {};
    if (patch.text !== undefined) values.text = patch.text;
    if (patch.checked !== undefined) values.checked = patch.checked ? 1 : 0;
    if (Object.keys(values).length) db.update(manualItems).set(values).where(eq(manualItems.id, id)).run();
    return db.select().from(manualItems).where(eq(manualItems.id, id)).get();
  },

  deleteManual(id: number): void {
    db.delete(manualItems).where(eq(manualItems.id, id)).run();
  },

  /* -------------------------------- pantry -------------------------------- */

  listPantry(): PantryItem[] {
    return db.select().from(pantryItems).all();
  },

  addPantry(input: { name: string; quantity: number | null; unit: string | null; note?: string | null }): PantryItem {
    const key = pantryKey(input.name);
    const unit = input.unit ?? null;
    const existing = db.select().from(pantryItems).all().find((r) => r.itemKey === key && r.unit === unit);
    if (existing) {
      const quantity =
        existing.quantity != null && input.quantity != null
          ? existing.quantity + input.quantity
          : (input.quantity ?? existing.quantity);
      db.update(pantryItems)
        .set({ quantity, name: input.name, note: input.note ?? existing.note })
        .where(eq(pantryItems.id, existing.id))
        .run();
      return db.select().from(pantryItems).where(eq(pantryItems.id, existing.id)).get()!;
    }
    return db
      .insert(pantryItems)
      .values({ itemKey: key, name: input.name, quantity: input.quantity, unit, note: input.note ?? null })
      .returning()
      .get();
  },

  updatePantry(
    id: number,
    patch: { name?: string; quantity?: number | null; unit?: string | null; note?: string | null },
  ): PantryItem | undefined {
    const values: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      values.name = patch.name;
      values.itemKey = pantryKey(patch.name);
    }
    if (patch.quantity !== undefined) values.quantity = patch.quantity;
    if (patch.unit !== undefined) values.unit = patch.unit;
    if (patch.note !== undefined) values.note = patch.note;
    if (Object.keys(values).length) db.update(pantryItems).set(values).where(eq(pantryItems.id, id)).run();
    return db.select().from(pantryItems).where(eq(pantryItems.id, id)).get();
  },

  deletePantry(id: number): void {
    db.delete(pantryItems).where(eq(pantryItems.id, id)).run();
  },

  listOverrides(weekStart: string): string[] {
    return db
      .select()
      .from(pantryOverrides)
      .where(eq(pantryOverrides.weekStart, weekStart))
      .all()
      .map((r) => r.itemKey);
  },

  setOverride(weekStart: string, itemKey: string, on: boolean): void {
    const existing = db
      .select()
      .from(pantryOverrides)
      .where(and(eq(pantryOverrides.weekStart, weekStart), eq(pantryOverrides.itemKey, itemKey)))
      .get();
    if (on && !existing) db.insert(pantryOverrides).values({ weekStart, itemKey }).run();
    if (!on && existing) db.delete(pantryOverrides).where(eq(pantryOverrides.id, existing.id)).run();
  },

  /* ------------------------------- settings -------------------------------- */

  getSetting(key: string): string | undefined {
    return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
  },

  setSetting(key: string, value: string): void {
    const existing = db.select().from(settings).where(eq(settings.key, key)).get();
    if (existing) db.update(settings).set({ value }).where(eq(settings.key, key)).run();
    else db.insert(settings).values({ key, value }).run();
  },

  deleteSetting(key: string): void {
    db.delete(settings).where(eq(settings.key, key)).run();
  },
};

export type Storage = typeof storage;
