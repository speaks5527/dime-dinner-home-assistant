/**
 * Grocery aggregation + pantry deduction (pure, unit-tested).
 */
import {
  type Amount,
  type Aisle,
  aisleFor,
  combineAmounts,
  dimensionOf,
  formatAmounts,
  isStapleAisle,
  normalizeName,
  parseIngredientLine,
  titleCaseName,
  toBase,
  fromBase,
  formatAmount,
} from "./ingredients";

export type PantryEntry = {
  id?: number;
  itemKey: string;
  name: string;
  quantity: number | null;
  unit: string | null;
};

export type RecipeIngredients = { recipeTitle: string; lines: string[] };

export type AggregatedLine = {
  key: string;
  name: string;
  aisle: Aisle;
  /** amount string with no pantry deduction applied */
  originalDisplay: string;
  /** amount string after pantry deduction (equals originalDisplay when none) */
  display: string;
  parts: Amount[];
  sources: { recipe: string; raw: string }[];
  pantry: {
    status: "covered" | "reduced" | "noted";
    originalDisplay: string;
    pantryDisplay: string;
    overridden: boolean;
  } | null;
};

/** Merge every ingredient line of every scheduled recipe into one list. */
export function aggregateIngredients(recipes: RecipeIngredients[]): AggregatedLine[] {
  const map = new Map<string, AggregatedLine & { rawAmounts: Amount[]; unquantified: boolean }>();

  for (const recipe of recipes) {
    for (const line of recipe.lines) {
      const parsed = parseIngredientLine(line);
      if (!parsed.key) continue;
      const existing = map.get(parsed.key);
      const amount: Amount = { quantity: parsed.quantity, unit: parsed.unit };
      if (existing) {
        existing.rawAmounts.push(amount);
        existing.sources.push({ recipe: recipe.recipeTitle, raw: parsed.raw });
      } else {
        map.set(parsed.key, {
          key: parsed.key,
          name: titleCaseName(parsed.key),
          aisle: parsed.aisle,
          originalDisplay: "",
          display: "",
          parts: [],
          sources: [{ recipe: recipe.recipeTitle, raw: parsed.raw }],
          pantry: null,
          rawAmounts: [amount],
          unquantified: false,
        });
      }
    }
  }

  const lines: AggregatedLine[] = [];
  for (const entry of map.values()) {
    const combined = combineAmounts(entry.rawAmounts);
    const display = formatAmounts(combined.amounts, combined.hasUnquantified);
    lines.push({
      key: entry.key,
      name: entry.name,
      aisle: entry.aisle,
      originalDisplay: display,
      display,
      parts: combined.amounts,
      sources: entry.sources,
      pantry: null,
    });
  }

  return sortLines(lines);
}

export function sortLines(lines: AggregatedLine[]): AggregatedLine[] {
  const order: Aisle[] = [
    "Produce",
    "Meat & Seafood",
    "Dairy & Eggs",
    "Bakery",
    "Frozen",
    "Canned & Jarred",
    "Pantry & Dry Goods",
    "Spices & Baking",
    "Other",
  ];
  return [...lines].sort((a, b) => {
    const byAisle = order.indexOf(a.aisle) - order.indexOf(b.aisle);
    return byAisle !== 0 ? byAisle : a.name.localeCompare(b.name);
  });
}

/** Build the lookup key a pantry entry matches on. */
export function pantryKey(name: string): string {
  return normalizeName(name);
}

/**
 * Apply the pantry to an aggregated list.
 *
 * Deliberately conservative:
 *  - a quantified pantry entry only reduces amounts in a *comparable* unit
 *    dimension; anything else is surfaced as a note and still bought
 *  - an unquantified pantry entry ("I have olive oil") only fully covers
 *    shelf-stable staples (spices/baking/dry goods); for fresh categories it
 *    is only a note, so you never arrive home without the chicken
 *  - overrides always put the full original amount back on the list
 */
export function applyPantry(
  lines: AggregatedLine[],
  pantry: PantryEntry[],
  overriddenKeys: Set<string> = new Set(),
): AggregatedLine[] {
  const byKey = new Map<string, PantryEntry[]>();
  for (const item of pantry) {
    const key = item.itemKey || pantryKey(item.name);
    const list = byKey.get(key) ?? [];
    list.push(item);
    byKey.set(key, list);
  }

  return lines.map((line) => {
    const matches = byKey.get(line.key);
    if (!matches?.length) return line;

    const overridden = overriddenKeys.has(line.key);
    const pantryDisplay = matches
      .map((m) => (m.quantity != null ? formatAmount({ quantity: m.quantity, unit: m.unit }) : "on hand"))
      .join(" + ");

    const quantified = matches.filter((m) => m.quantity != null);

    // No quantities recorded → staples only.
    if (!quantified.length) {
      const status = isStapleAisle(line.aisle) ? "covered" : "noted";
      return {
        ...line,
        display: status === "covered" && !overridden ? "in pantry" : line.originalDisplay,
        pantry: { status, originalDisplay: line.originalDisplay, pantryDisplay, overridden },
      };
    }

    // Sum pantry stock per dimension, then subtract where comparable.
    const stock = new Map<string, number>();
    for (const m of quantified) {
      const base = toBase({ quantity: m.quantity, unit: m.unit });
      if (!base) continue;
      stock.set(base.dimension, (stock.get(base.dimension) ?? 0) + base.value);
    }

    let deductedSomething = false;
    let anyComparable = false;
    const remaining: Amount[] = [];
    for (const part of line.parts) {
      const base = toBase(part);
      if (!base) {
        remaining.push(part);
        continue;
      }
      const available = stock.get(base.dimension);
      if (available == null || available <= 0) {
        remaining.push(part);
        continue;
      }
      anyComparable = true;
      const used = Math.min(available, base.value);
      stock.set(base.dimension, available - used);
      const left = base.value - used;
      if (left > 1e-6) {
        const system = part.unit && ["g", "kg", "ml", "l"].includes(part.unit) ? "metric" : "us";
        remaining.push(fromBase(base.dimension, left, system));
      }
      deductedSomething = true;
    }

    if (!anyComparable) {
      return {
        ...line,
        pantry: { status: "noted", originalDisplay: line.originalDisplay, pantryDisplay, overridden },
      };
    }

    const remainingDisplay = formatAmounts(remaining);
    const fullyCovered = remaining.length === 0;
    const status: "covered" | "reduced" = fullyCovered ? "covered" : "reduced";
    if (!deductedSomething) return line;

    return {
      ...line,
      display: overridden ? line.originalDisplay : fullyCovered ? "in pantry" : remainingDisplay,
      parts: overridden ? line.parts : remaining,
      pantry: { status, originalDisplay: line.originalDisplay, pantryDisplay, overridden },
    };
  });
}

/** Lines that should actually be shown on the shopping list. */
export function visibleLines(lines: AggregatedLine[]): AggregatedLine[] {
  return lines.filter((line) => !line.pantry || line.pantry.status !== "covered" || line.pantry.overridden);
}

export { dimensionOf, aisleFor };
