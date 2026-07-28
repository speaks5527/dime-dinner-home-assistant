/**
 * Ingredient parsing + normalization.
 *
 * Pure functions only — no I/O — so they can be unit tested directly.
 */

export type Dimension = string; // "volume" | "weight" | `count:${unit}`

export type UnitDef = {
  canonical: string;
  plural: string;
  dimension: "volume" | "weight" | "count";
  /** amount of base unit (ml for volume, g for weight, 1 for count) */
  factor: number;
  system?: "us" | "metric";
};

const UNIT_DEFS: UnitDef[] = [
  // volume — US
  { canonical: "tsp", plural: "tsp", dimension: "volume", factor: 4.92892, system: "us" },
  { canonical: "tbsp", plural: "tbsp", dimension: "volume", factor: 14.7868, system: "us" },
  { canonical: "fl oz", plural: "fl oz", dimension: "volume", factor: 29.5735, system: "us" },
  { canonical: "cup", plural: "cups", dimension: "volume", factor: 236.588, system: "us" },
  { canonical: "pint", plural: "pints", dimension: "volume", factor: 473.176, system: "us" },
  { canonical: "quart", plural: "quarts", dimension: "volume", factor: 946.353, system: "us" },
  { canonical: "gallon", plural: "gallons", dimension: "volume", factor: 3785.41, system: "us" },
  // volume — metric
  { canonical: "ml", plural: "ml", dimension: "volume", factor: 1, system: "metric" },
  { canonical: "l", plural: "l", dimension: "volume", factor: 1000, system: "metric" },
  // weight — US
  { canonical: "oz", plural: "oz", dimension: "weight", factor: 28.3495, system: "us" },
  { canonical: "lb", plural: "lb", dimension: "weight", factor: 453.592, system: "us" },
  // weight — metric
  { canonical: "g", plural: "g", dimension: "weight", factor: 1, system: "metric" },
  { canonical: "kg", plural: "kg", dimension: "weight", factor: 1000, system: "metric" },
  // countable containers / pieces
  { canonical: "can", plural: "cans", dimension: "count", factor: 1 },
  { canonical: "jar", plural: "jars", dimension: "count", factor: 1 },
  { canonical: "package", plural: "packages", dimension: "count", factor: 1 },
  { canonical: "box", plural: "boxes", dimension: "count", factor: 1 },
  { canonical: "bag", plural: "bags", dimension: "count", factor: 1 },
  { canonical: "bottle", plural: "bottles", dimension: "count", factor: 1 },
  { canonical: "clove", plural: "cloves", dimension: "count", factor: 1 },
  { canonical: "head", plural: "heads", dimension: "count", factor: 1 },
  { canonical: "bunch", plural: "bunches", dimension: "count", factor: 1 },
  { canonical: "stalk", plural: "stalks", dimension: "count", factor: 1 },
  { canonical: "sprig", plural: "sprigs", dimension: "count", factor: 1 },
  { canonical: "slice", plural: "slices", dimension: "count", factor: 1 },
  { canonical: "pinch", plural: "pinches", dimension: "count", factor: 1 },
  { canonical: "dash", plural: "dashes", dimension: "count", factor: 1 },
  { canonical: "ear", plural: "ears", dimension: "count", factor: 1 },
  { canonical: "stick", plural: "sticks", dimension: "count", factor: 1 },
  { canonical: "container", plural: "containers", dimension: "count", factor: 1 },
];

const UNIT_ALIASES: Record<string, string> = {
  t: "tsp",
  tsp: "tsp",
  tsps: "tsp",
  teaspoon: "tsp",
  teaspoons: "tsp",
  tb: "tbsp",
  tbs: "tbsp",
  tbsp: "tbsp",
  tbsps: "tbsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  "fl oz": "fl oz",
  "fluid ounce": "fl oz",
  "fluid ounces": "fl oz",
  c: "cup",
  cup: "cup",
  cups: "cup",
  pt: "pint",
  pint: "pint",
  pints: "pint",
  qt: "quart",
  quart: "quart",
  quarts: "quart",
  gal: "gallon",
  gallon: "gallon",
  gallons: "gallon",
  ml: "ml",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  l: "l",
  liter: "l",
  liters: "l",
  litre: "l",
  oz: "oz",
  ozs: "oz",
  ounce: "oz",
  ounces: "oz",
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  g: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  kilogram: "kg",
  kilograms: "kg",
  can: "can",
  cans: "can",
  jar: "jar",
  jars: "jar",
  pkg: "package",
  package: "package",
  packages: "package",
  pack: "package",
  packs: "package",
  box: "box",
  boxes: "box",
  bag: "bag",
  bags: "bag",
  bottle: "bottle",
  bottles: "bottle",
  clove: "clove",
  cloves: "clove",
  head: "head",
  heads: "head",
  bunch: "bunch",
  bunches: "bunch",
  stalk: "stalk",
  stalks: "stalk",
  sprig: "sprig",
  sprigs: "sprig",
  slice: "slice",
  slices: "slice",
  pinch: "pinch",
  pinches: "pinch",
  dash: "dash",
  dashes: "dash",
  ear: "ear",
  ears: "ear",
  stick: "stick",
  sticks: "stick",
  container: "container",
  containers: "container",
};

const UNIT_BY_CANONICAL = new Map(UNIT_DEFS.map((u) => [u.canonical, u]));

export function lookupUnit(word: string): UnitDef | null {
  const canonical = UNIT_ALIASES[word.trim().toLowerCase().replace(/\.$/, "")];
  return canonical ? UNIT_BY_CANONICAL.get(canonical) ?? null : null;
}

export function dimensionOf(unit: string | null): Dimension {
  if (!unit) return "count:each";
  const def = UNIT_BY_CANONICAL.get(unit);
  if (!def) return `count:${unit}`;
  return def.dimension === "count" ? `count:${unit}` : def.dimension;
}

/* ------------------------------------------------------------------ *
 * Numbers
 * ------------------------------------------------------------------ */

const VULGAR: Record<string, number> = {
  "½": 0.5,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "¼": 0.25,
  "¾": 0.75,
  "⅕": 0.2,
  "⅖": 0.4,
  "⅗": 0.6,
  "⅘": 0.8,
  "⅙": 1 / 6,
  "⅚": 5 / 6,
  "⅛": 0.125,
  "⅜": 0.375,
  "⅝": 0.625,
  "⅞": 0.875,
};

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  dozen: 12,
  half: 0.5,
};

/** Expand vulgar fractions to ascii so the tokenizer sees a uniform shape. */
export function normalizeUnicodeNumbers(input: string): string {
  let out = input;
  for (const [glyph, value] of Object.entries(VULGAR)) {
    const ascii = value === 0.5 ? "1/2" : value === 0.25 ? "1/4" : value === 0.75 ? "3/4" : String(round(value, 3));
    // keep a space so "1½" becomes "1 1/2"
    out = out.split(glyph).join(` ${ascii} `);
  }
  return out.replace(/\s+/g, " ").trim();
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Parse a leading quantity from tokens. Handles "2", "1/2", "1 1/2", "2-3",
 * "2 to 3", "1.5" and number words. Ranges resolve to the upper bound so the
 * shopping list never under-buys.
 */
export function parseQuantity(text: string): { quantity: number | null; rest: string } {
  const s = normalizeUnicodeNumbers(text).replace(/^[\s,]+/, "");
  const numberRe = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)/;
  const first = s.match(numberRe);
  if (!first) {
    const wordMatch = s.match(/^([a-z]+)\b/i);
    if (wordMatch) {
      const value = WORD_NUMBERS[wordMatch[1].toLowerCase()];
      // "a"/"an" only count as 1 when followed by a unit ("a cup of…")
      if (value !== undefined) {
        const rest = s.slice(wordMatch[0].length).trim();
        const nextWord = rest.split(/\s+/)[0] ?? "";
        if (!["a", "an"].includes(wordMatch[1].toLowerCase()) || lookupUnit(nextWord)) {
          return { quantity: value, rest };
        }
      }
    }
    return { quantity: null, rest: s };
  }
  let value = evalNumber(first[1]);
  let rest = s.slice(first[0].length);
  const range = rest.match(/^\s*(?:-|–|—|to)\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)/i);
  if (range) {
    value = Math.max(value, evalNumber(range[1]));
    rest = rest.slice(range[0].length);
  }
  // "1 1/2" written as "1 and 1/2"
  return { quantity: round(value, 4), rest: rest.trim() };
}

function evalNumber(token: string): number {
  const mixed = token.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = token.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  return Number(token);
}

/** Render a number the way a cook would write it. */
export function formatQuantity(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  const whole = Math.floor(rounded + 1e-9);
  const frac = rounded - whole;
  const eighths = Math.round(frac * 8);
  const nice: Record<number, string> = { 1: "1/8", 2: "1/4", 3: "3/8", 4: "1/2", 5: "5/8", 6: "3/4", 7: "7/8" };
  if (Math.abs(frac * 8 - eighths) < 0.06 && eighths > 0 && eighths < 8) {
    return whole > 0 ? `${whole} ${nice[eighths]}` : nice[eighths];
  }
  if (eighths === 8) return String(whole + 1);
  if (eighths === 0) return String(whole);
  return String(round(rounded, 2));
}

/* ------------------------------------------------------------------ *
 * Ingredient name normalization
 * ------------------------------------------------------------------ */

const LEADING_DESCRIPTORS = new Set([
  "chopped",
  "finely",
  "freshly",
  "fresh",
  "frozen",
  "diced",
  "minced",
  "sliced",
  "shredded",
  "grated",
  "crushed",
  "melted",
  "softened",
  "cooked",
  "uncooked",
  "raw",
  "peeled",
  "seeded",
  "rinsed",
  "drained",
  "cubed",
  "halved",
  "quartered",
  "large",
  "small",
  "medium",
  "ripe",
  "warm",
  "cold",
  "hot",
  "room",
  "temperature",
  "optional",
  "packed",
  "heaping",
  "level",
  "additional",
  "extra",
  "about",
  "approximately",
  "of",
]);

const TRAILING_NOISE = [
  /\bfor (?:garnish|serving|topping|dusting|greasing|frying|drizzling)\b.*$/i,
  /\bto taste\b.*$/i,
  /\bdivided\b.*$/i,
  /\bplus more\b.*$/i,
  /\bif (?:desired|needed|using)\b.*$/i,
  /\boptional\b.*$/i,
  /\bat room temperature\b.*$/i,
];

const IRREGULAR_SINGULAR: Record<string, string> = {
  tomatoes: "tomato",
  potatoes: "potato",
  leaves: "leaf",
  loaves: "loaf",
  halves: "half",
  knives: "knife",
  berries: "berry",
  cherries: "cherry",
  strawberries: "strawberry",
  blueberries: "blueberry",
  raspberries: "raspberry",
  chilies: "chili",
  chiles: "chile",
  noodles: "noodles",
  greens: "greens",
  oats: "oats",
  grits: "grits",
  beans: "beans",
  peas: "peas",
  chives: "chives",
  sprouts: "sprouts",
};

export function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (IRREGULAR_SINGULAR[lower]) return IRREGULAR_SINGULAR[lower];
  if (lower.length > 3 && lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.length > 3 && /(ch|sh|ss|x|z)es$/.test(lower)) return lower.slice(0, -2);
  if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss") && !lower.endsWith("us")) {
    return lower.slice(0, -1);
  }
  return lower;
}

/** Stable matching key: lowercase, de-pluralized, descriptor-free. */
export function normalizeName(name: string): string {
  let s = name.toLowerCase();
  s = s.replace(/\([^)]*\)/g, " ");
  for (const re of TRAILING_NOISE) s = s.replace(re, " ");
  s = s.replace(/[^a-z0-9%\s-]/g, " ").replace(/\s+/g, " ").trim();
  let words = s.split(" ").filter(Boolean);
  while (words.length > 1 && LEADING_DESCRIPTORS.has(words[0])) words = words.slice(1);
  while (words.length > 1 && LEADING_DESCRIPTORS.has(words[words.length - 1])) words = words.slice(0, -1);
  words = words.map((w, i) => (i === words.length - 1 ? singularize(w) : w));
  return words.join(" ").trim();
}

export function titleCaseName(key: string): string {
  return key
    .split(" ")
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/* ------------------------------------------------------------------ *
 * Aisles
 * ------------------------------------------------------------------ */

export const AISLES = [
  "Produce",
  "Meat & Seafood",
  "Dairy & Eggs",
  "Bakery",
  "Frozen",
  "Canned & Jarred",
  "Pantry & Dry Goods",
  "Spices & Baking",
  "Other",
] as const;
export type Aisle = (typeof AISLES)[number];

const AISLE_RULES: [Aisle, string[]][] = [
  [
    "Produce",
    ["onion", "garlic", "tomato", "potato", "carrot", "celery", "pepper flake" /*guard*/, "bell pepper", "jalapeno", "lettuce", "spinach", "kale", "cilantro", "parsley", "basil", "lime", "lemon", "apple", "banana", "avocado", "cucumber", "zucchini", "squash", "mushroom", "broccoli", "cauliflower", "cabbage", "corn", "green bean", "scallion", "green onion", "shallot", "ginger", "berry", "strawberry", "blueberry", "grape", "orange", "peach", "pear", "sweet potato", "salad", "herb", "chive", "sprout", "cucumbers"],
  ],
  [
    "Meat & Seafood",
    ["chicken", "beef", "pork", "turkey", "sausage", "bacon", "ham", "steak", "ground meat", "shrimp", "salmon", "tilapia", "fish", "crab", "lamb", "brisket", "ribs", "meatball"],
  ],
  [
    "Dairy & Eggs",
    ["milk", "butter", "cheese", "cream", "yogurt", "egg", "sour cream", "half and half", "buttermilk", "cream cheese", "parmesan", "mozzarella", "cheddar", "ricotta", "whipped topping"],
  ],
  ["Bakery", ["bread", "bun", "roll", "tortilla", "bagel", "pita", "biscuit", "croissant", "hoagie", "baguette", "crust"]],
  ["Frozen", ["frozen", "ice cream", "puff pastry", "tater tot", "hash brown"]],
  [
    "Canned & Jarred",
    ["canned", "can of", "broth", "stock", "soup", "tomato sauce", "tomato paste", "salsa", "beans", "olive", "pickle", "coconut milk", "enchilada sauce", "marinara", "chile", "corn kernel", "condensed"],
  ],
  [
    "Pantry & Dry Goods",
    ["pasta", "noodle", "rice", "flour", "sugar", "oil", "vinegar", "soy sauce", "honey", "syrup", "oat", "cereal", "cracker", "chip", "peanut butter", "jam", "jelly", "ketchup", "mustard", "mayonnaise", "worcestershire", "cornstarch", "breadcrumb", "quinoa", "lentil", "stuffing", "cornmeal", "bouillon", "ranch", "bbq sauce", "barbecue"],
  ],
  [
    "Spices & Baking",
    ["salt", "pepper", "paprika", "cumin", "chili powder", "oregano", "thyme", "basil leaves", "cinnamon", "nutmeg", "vanilla", "baking powder", "baking soda", "yeast", "garlic powder", "onion powder", "seasoning", "cayenne", "turmeric", "curry powder", "bay leaf", "italian seasoning", "taco seasoning", "cocoa", "chocolate chip", "powdered sugar", "brown sugar", "spice"],
  ],
];

export function aisleFor(nameKey: string): Aisle {
  const n = ` ${nameKey.toLowerCase()} `;
  // spices win over produce for things like "garlic powder"
  const ordered: Aisle[] = ["Spices & Baking", "Frozen", "Canned & Jarred", "Meat & Seafood", "Dairy & Eggs", "Bakery", "Produce", "Pantry & Dry Goods"];
  for (const aisle of ordered) {
    const rule = AISLE_RULES.find(([a]) => a === aisle);
    if (!rule) continue;
    for (const kw of rule[1]) {
      if (n.includes(` ${kw} `) || n.includes(`${kw}`)) return aisle;
    }
  }
  return "Other";
}

/** Pantry staples that an un-quantified pantry entry is allowed to fully cover. */
export function isStapleAisle(aisle: Aisle): boolean {
  return aisle === "Spices & Baking" || aisle === "Pantry & Dry Goods";
}

/* ------------------------------------------------------------------ *
 * Line parsing
 * ------------------------------------------------------------------ */

export type ParsedIngredient = {
  raw: string;
  quantity: number | null;
  unit: string | null;
  name: string;
  key: string;
  note: string | null;
  aisle: Aisle;
};

/**
 * Parse one published ingredient line into structured parts.
 *
 * Understands the shapes Eating on a Dime publishes, e.g.
 *   "2 pounds boneless skinless chicken breasts"
 *   "2 cans 10.5 ounce each cream of chicken soup"
 *   "1 (14.5 ounce) can low-sodium chicken broth"
 *   "½ cup butter (cut into cubes)"
 *   "Chopped fresh parsley (for garnish, optional)"
 */
export function parseIngredientLine(raw: string): ParsedIngredient {
  const original = raw.replace(/\s+/g, " ").trim();
  const notes: string[] = [];
  // pull out parentheticals as notes but keep container sizes visible
  let working = normalizeUnicodeNumbers(original).replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    notes.push(String(inner).trim());
    return " ";
  });
  working = working.replace(/\s+/g, " ").trim();

  const { quantity, rest } = parseQuantity(working);
  let remainder = rest;
  let unit: string | null = null;

  const firstWord = remainder.split(/\s+/)[0] ?? "";
  const twoWords = remainder.split(/\s+/).slice(0, 2).join(" ");
  const twoWordUnit = lookupUnit(twoWords);
  const oneWordUnit = lookupUnit(firstWord);
  if (twoWordUnit) {
    unit = twoWordUnit.canonical;
    remainder = remainder.split(/\s+/).slice(2).join(" ");
  } else if (oneWordUnit) {
    unit = oneWordUnit.canonical;
    remainder = remainder.split(/\s+/).slice(1).join(" ");
  }

  // "2 cans 10.5 ounce each cream of chicken soup" → drop the embedded size
  const embeddedSize = remainder.match(/^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\.?\s*(each\s+)?/i);
  if (unit && embeddedSize && lookupUnit(embeddedSize[2])) {
    notes.push(`${embeddedSize[1]} ${embeddedSize[2]} each`);
    remainder = remainder.slice(embeddedSize[0].length);
  }

  remainder = remainder.replace(/^(?:of|de)\s+/i, "").trim();
  // trailing ", diced" style prep
  const commaSplit = remainder.split(",");
  if (commaSplit.length > 1) {
    const tail = commaSplit.slice(1).join(",").trim();
    if (tail) notes.push(tail);
    remainder = commaSplit[0].trim();
  }

  const displayName = remainder.replace(/\s+/g, " ").trim() || original;
  const key = normalizeName(displayName) || normalizeName(original);
  const aisle = aisleFor(key);

  return {
    raw: original,
    quantity,
    unit,
    name: displayName,
    key,
    note: notes.length ? notes.join("; ") : null,
    aisle,
  };
}

/* ------------------------------------------------------------------ *
 * Amount math
 * ------------------------------------------------------------------ */

export type Amount = { quantity: number | null; unit: string | null };

export function toBase(amount: Amount): { dimension: Dimension; value: number } | null {
  if (amount.quantity == null) return null;
  const def = amount.unit ? UNIT_BY_CANONICAL.get(amount.unit) : null;
  if (!def) return { dimension: dimensionOf(amount.unit), value: amount.quantity };
  if (def.dimension === "count") return { dimension: `count:${def.canonical}`, value: amount.quantity };
  return { dimension: def.dimension, value: amount.quantity * def.factor };
}

const VOLUME_LADDER_US = ["gallon", "quart", "cup", "tbsp", "tsp"];
const VOLUME_LADDER_METRIC = ["l", "ml"];
const WEIGHT_LADDER_US = ["lb", "oz"];
const WEIGHT_LADDER_METRIC = ["kg", "g"];

/** Convert a base value back into the friendliest unit of its dimension. */
export function fromBase(dimension: Dimension, value: number, system: "us" | "metric" = "us"): Amount {
  if (dimension.startsWith("count:")) {
    const unit = dimension.slice("count:".length);
    return { quantity: round(value, 3), unit: unit === "each" ? null : unit };
  }
  const ladder =
    dimension === "volume"
      ? system === "metric"
        ? VOLUME_LADDER_METRIC
        : VOLUME_LADDER_US
      : system === "metric"
        ? WEIGHT_LADDER_METRIC
        : WEIGHT_LADDER_US;
  for (const unit of ladder) {
    const def = UNIT_BY_CANONICAL.get(unit)!;
    if (value >= def.factor - 1e-9) return { quantity: round(value / def.factor, 3), unit };
  }
  const smallest = UNIT_BY_CANONICAL.get(ladder[ladder.length - 1])!;
  return { quantity: round(value / smallest.factor, 3), unit: smallest.canonical };
}

export function pluralizeUnit(unit: string, quantity: number): string {
  const def = UNIT_BY_CANONICAL.get(unit);
  if (!def) return quantity > 1 ? `${unit}s` : unit;
  return quantity > 1 ? def.plural : def.canonical;
}

export function formatAmount(amount: Amount): string {
  if (amount.quantity == null) return amount.unit ?? "";
  const qty = formatQuantity(amount.quantity);
  if (!amount.unit) return qty;
  return `${qty} ${pluralizeUnit(amount.unit, amount.quantity)}`;
}

/** Sum a set of amounts, keeping incompatible dimensions separate. */
export function combineAmounts(amounts: Amount[]): { amounts: Amount[]; hasUnquantified: boolean } {
  const buckets = new Map<Dimension, { value: number; system: "us" | "metric" }>();
  let hasUnquantified = false;
  for (const amount of amounts) {
    const base = toBase(amount);
    if (!base) {
      hasUnquantified = true;
      continue;
    }
    const def = amount.unit ? UNIT_BY_CANONICAL.get(amount.unit) : null;
    const system = def?.system ?? "us";
    const existing = buckets.get(base.dimension);
    if (existing) existing.value += base.value;
    else buckets.set(base.dimension, { value: base.value, system });
  }
  const out: Amount[] = [];
  for (const [dimension, bucket] of buckets) out.push(fromBase(dimension, bucket.value, bucket.system));
  return { amounts: out, hasUnquantified };
}

export function formatAmounts(amounts: Amount[], hasUnquantified = false): string {
  const parts = amounts.map(formatAmount).filter(Boolean);
  if (!parts.length) return hasUnquantified ? "as needed" : "";
  return hasUnquantified ? `${parts.join(" + ")} + as needed` : parts.join(" + ");
}
