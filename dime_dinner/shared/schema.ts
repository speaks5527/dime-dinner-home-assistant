import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/** A recipe the user has imported or planned. Stored only on user action. */
export const recipes = sqliteTable("recipes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceUrl: text("source_url").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  author: text("author"),
  prepMinutes: integer("prep_minutes"),
  cookMinutes: integer("cook_minutes"),
  totalMinutes: integer("total_minutes"),
  servings: text("servings"),
  /** JSON string[] */
  categories: text("categories").notNull().default("[]"),
  /** JSON string[] */
  cuisines: text("cuisines").notNull().default("[]"),
  /** JSON string[] — raw ingredient lines exactly as published */
  ingredients: text("ingredients").notNull().default("[]"),
  /** JSON {heading?: string, steps: string[]}[] */
  instructions: text("instructions").notNull().default("[]"),
  /** JSON Record<string,string> | null */
  nutrition: text("nutrition"),
  /** hostname / og:site_name of the source, e.g. "eatingonadime.com" */
  siteName: text("site_name"),
  favorite: integer("favorite").notNull().default(0),
  importedAt: integer("imported_at").notNull(),
});

/** One recipe placed in one weekday meal slot. */
export const planSlots = sqliteTable("plan_slots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** ISO date (Monday) of the week, e.g. 2026-07-27 */
  weekStart: text("week_start").notNull(),
  /** 0 = Monday … 6 = Sunday */
  day: integer("day").notNull(),
  /** "lunch" | "dinner" */
  meal: text("meal").notNull(),
  recipeId: integer("recipe_id").notNull(),
});

/** Check-off state for auto-generated grocery lines, keyed by normalized ingredient key. */
export const groceryChecks = sqliteTable(
  "grocery_checks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    weekStart: text("week_start").notNull(),
    itemKey: text("item_key").notNull(),
    checked: integer("checked").notNull().default(0),
  },
  (t) => ({ uniq: uniqueIndex("grocery_checks_week_key").on(t.weekStart, t.itemKey) }),
);

/** Manually added grocery lines (not derived from the plan). */
export const manualItems = sqliteTable("manual_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  weekStart: text("week_start").notNull(),
  text: text("text").notNull(),
  checked: integer("checked").notNull().default(0),
});

/** Persistent pantry inventory of staples the user already has on hand. */
export const pantryItems = sqliteTable(
  "pantry_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** normalized matching key derived from the name */
    itemKey: text("item_key").notNull(),
    name: text("name").notNull(),
    quantity: real("quantity"),
    unit: text("unit"),
    note: text("note"),
  },
  (t) => ({ uniq: uniqueIndex("pantry_items_key").on(t.itemKey, t.unit) }),
);

/** User-edited quantities for auto-generated grocery lines. */
export const groceryEdits = sqliteTable(
  "grocery_edits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    weekStart: text("week_start").notNull(),
    itemKey: text("item_key").notNull(),
    /** free-text amount that replaces the computed one */
    amount: text("amount").notNull(),
  },
  (t) => ({ uniq: uniqueIndex("grocery_edits_week_key").on(t.weekStart, t.itemKey) }),
);

/** Grocery lines the user has explicitly opted to keep despite pantry coverage. */
export const pantryOverrides = sqliteTable(
  "pantry_overrides",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    weekStart: text("week_start").notNull(),
    itemKey: text("item_key").notNull(),
  },
  (t) => ({ uniq: uniqueIndex("pantry_overrides_week_key").on(t.weekStart, t.itemKey) }),
);

/** Key/value app settings (Kroger credentials, theme, etc.). */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const insertRecipeSchema = createInsertSchema(recipes).omit({ id: true });
export type InsertRecipe = z.infer<typeof insertRecipeSchema>;
export type Recipe = typeof recipes.$inferSelect;

export const insertPlanSlotSchema = createInsertSchema(planSlots).omit({ id: true });
export type InsertPlanSlot = z.infer<typeof insertPlanSlotSchema>;
export type PlanSlot = typeof planSlots.$inferSelect;

export const insertGroceryEditSchema = createInsertSchema(groceryEdits).omit({ id: true });
export type GroceryEdit = typeof groceryEdits.$inferSelect;

export const insertManualItemSchema = createInsertSchema(manualItems).omit({ id: true });
export type InsertManualItem = z.infer<typeof insertManualItemSchema>;
export type ManualItem = typeof manualItems.$inferSelect;

export const insertPantryItemSchema = createInsertSchema(pantryItems).omit({ id: true, itemKey: true });
export type InsertPantryItem = z.infer<typeof insertPantryItemSchema>;
export type PantryItem = typeof pantryItems.$inferSelect;

export const MEALS = ["lunch", "dinner"] as const;
export type Meal = (typeof MEALS)[number];
export const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/* ---------- API payload types shared by client + server ---------- */

export type InstructionStep = {
  text: string;
  /** only set when the source recipe genuinely published a step image */
  image?: string;
};
export type InstructionGroup = { heading?: string; steps: InstructionStep[] };

/** Recipe with JSON columns already decoded — what the API returns. */
export type RecipeDTO = Omit<
  Recipe,
  "categories" | "cuisines" | "ingredients" | "instructions" | "nutrition" | "favorite"
> & {
  categories: string[];
  cuisines: string[];
  ingredients: string[];
  instructions: InstructionGroup[];
  nutrition: Record<string, string> | null;
  favorite: boolean;
};

export type SearchHit = {
  title: string;
  url: string;
  imageUrl: string | null;
  excerpt: string | null;
  /** id of the locally saved recipe, if already imported */
  savedId?: number | null;
};

export type SearchResponse = {
  query: string;
  results: SearchHit[];
  source: "live" | "demo";
  notice?: string;
};

export type PlanEntry = { id: number; day: number; meal: Meal; recipe: RecipeDTO };
export type PlanResponse = { weekStart: string; entries: PlanEntry[] };

export type GroceryPart = { quantity: number | null; unit: string | null };

export type GroceryLine = {
  key: string;
  name: string;
  display: string;
  aisle: string;
  checked: boolean;
  parts: GroceryPart[];
  /** raw ingredient lines + which recipe each came from */
  sources: { recipe: string; raw: string }[];
  /** pantry deduction, if any was applied */
  /** user-typed amount that overrides the computed one */
  editedAmount: string | null;
  pantry: {
    /**
     * "covered" = fully satisfied by the pantry and hidden unless overridden
     * "reduced" = quantity lowered by the pantry amount
     * "noted"   = pantry has some but units are not comparable, so nothing was deducted
     */
    status: "covered" | "reduced" | "noted";
    /** what the list would have said without the pantry */
    originalDisplay: string;
    pantryDisplay: string;
    /** true when the user forced the item back onto the list */
    overridden: boolean;
  } | null;
};

export type GroceryResponse = {
  weekStart: string;
  recipeCount: number;
  lines: GroceryLine[];
  manual: ManualItem[];
  pantryCoveredCount: number;
};

export type KrogerSettings = {
  enabled: boolean;
  clientId: string;
  /** never returned to the client — presence is reported via hasClientSecret */
  clientSecret?: string;
  zip: string;
  locationId: string;
};

export type KrogerStatus = {
  enabled: boolean;
  configured: boolean;
  hasClientSecret: boolean;
  clientId: string;
  zip: string;
  locationId: string;
  locationName?: string | null;
  managedByAddonOptions: boolean;
  message: string;
};

export type KrogerProduct = {
  productId: string;
  description: string;
  brand: string | null;
  size: string | null;
  imageUrl: string | null;
  regularPrice: number | null;
  promoPrice: number | null;
  aisle: string | null;
  fulfillment: string[];
  stockLevel: string | null;
  soldBy: string | null;
};

export type KrogerMatchResponse = {
  term: string;
  locationId: string | null;
  products: KrogerProduct[];
  disclaimer: string;
};
