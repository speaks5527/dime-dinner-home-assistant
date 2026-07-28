import { describe, expect, it } from "vitest";
import {
  aisleFor,
  combineAmounts,
  formatAmount,
  formatAmounts,
  formatQuantity,
  normalizeName,
  parseIngredientLine,
  parseQuantity,
  singularize,
} from "../server/lib/ingredients";

describe("quantity parsing", () => {
  it("reads whole numbers, decimals and fractions", () => {
    expect(parseQuantity("2 cups flour").quantity).toBe(2);
    expect(parseQuantity("1.5 pounds beef").quantity).toBe(1.5);
    expect(parseQuantity("1/2 cup butter").quantity).toBe(0.5);
    expect(parseQuantity("1 1/2 cups milk").quantity).toBe(1.5);
  });

  it("reads unicode fractions", () => {
    expect(parseQuantity("½ cup butter").quantity).toBe(0.5);
    expect(parseQuantity("1½ cups sugar").quantity).toBe(1.5);
    expect(parseQuantity("¼ teaspoon salt").quantity).toBe(0.25);
  });

  it("takes the upper bound of a range so the list never under-buys", () => {
    expect(parseQuantity("2-3 tablespoons oil").quantity).toBe(3);
    expect(parseQuantity("2 to 3 cloves garlic").quantity).toBe(3);
  });

  it("handles missing quantities", () => {
    expect(parseQuantity("Salt and pepper to taste").quantity).toBeNull();
  });
});

describe("ingredient line parsing", () => {
  it("parses a simple weighted line", () => {
    const parsed = parseIngredientLine("2 pounds boneless skinless chicken breasts");
    expect(parsed.quantity).toBe(2);
    expect(parsed.unit).toBe("lb");
    expect(parsed.key).toBe("boneless skinless chicken breast");
    expect(parsed.aisle).toBe("Meat & Seafood");
  });

  it("keeps parentheticals as notes", () => {
    const parsed = parseIngredientLine("1/2 cup butter (cut into cubes)");
    expect(parsed.quantity).toBe(0.5);
    expect(parsed.unit).toBe("cup");
    expect(parsed.key).toBe("butter");
    expect(parsed.note).toContain("cut into cubes");
  });

  it("handles container sizes stated inline", () => {
    const parsed = parseIngredientLine("2 cans 10.5 ounce each cream of chicken soup");
    expect(parsed.quantity).toBe(2);
    expect(parsed.unit).toBe("can");
    expect(parsed.key).toBe("cream of chicken soup");
    expect(parsed.note).toContain("10.5 ounce each");
  });

  it("handles a parenthetical container size", () => {
    const parsed = parseIngredientLine("1 (14.5 ounce) can low-sodium chicken broth");
    expect(parsed.quantity).toBe(1);
    expect(parsed.unit).toBe("can");
    expect(parsed.key).toContain("chicken broth");
  });

  it("drops prep descriptors and trailing garnish notes from the key", () => {
    expect(parseIngredientLine("Chopped fresh parsley (for garnish, optional)").key).toBe("parsley");
    expect(parseIngredientLine("1 medium onion (diced)").key).toBe("onion");
    expect(parseIngredientLine("3 cloves garlic (minced)").key).toBe("garlic");
  });

  it("normalizes plurals so duplicates collapse", () => {
    expect(normalizeName("Tomatoes")).toBe("tomato");
    expect(normalizeName("2 Potatoes")).toBe("2 potato");
    expect(singularize("cloves")).toBe("clove");
    expect(parseIngredientLine("2 medium tomatoes (diced)").key).toBe(
      parseIngredientLine("1 tomato").key,
    );
  });

  it("routes ingredients to sensible aisles", () => {
    expect(aisleFor("garlic powder")).toBe("Spices & Baking");
    expect(aisleFor("onion")).toBe("Produce");
    expect(aisleFor("shredded cheddar cheese")).toBe("Dairy & Eggs");
    expect(aisleFor("corn tortilla")).toBe("Bakery");
    expect(aisleFor("penne pasta")).toBe("Pantry & Dry Goods");
  });
});

describe("amount math", () => {
  it("sums compatible volumes into one friendly amount", () => {
    const combined = combineAmounts([
      { quantity: 1, unit: "cup" },
      { quantity: 2, unit: "tbsp" },
      { quantity: 1, unit: "cup" },
    ]);
    expect(combined.amounts).toHaveLength(1);
    expect(formatAmounts(combined.amounts)).toBe("2 1/8 cups");
  });

  it("keeps incompatible dimensions separate", () => {
    const combined = combineAmounts([
      { quantity: 2, unit: "lb" },
      { quantity: 1, unit: "cup" },
      { quantity: 3, unit: "clove" },
    ]);
    expect(combined.amounts).toHaveLength(3);
    expect(formatAmounts(combined.amounts)).toContain("2 lb");
    expect(formatAmounts(combined.amounts)).toContain("3 cloves");
  });

  it("marks unquantified contributions", () => {
    const combined = combineAmounts([{ quantity: null, unit: null }, { quantity: 1, unit: "tsp" }]);
    expect(formatAmounts(combined.amounts, combined.hasUnquantified)).toBe("1 tsp + as needed");
  });

  it("formats quantities like a cook writes them", () => {
    expect(formatQuantity(0.5)).toBe("1/2");
    expect(formatQuantity(1.25)).toBe("1 1/4");
    expect(formatQuantity(3)).toBe("3");
    expect(formatAmount({ quantity: 2, unit: "cup" })).toBe("2 cups");
    expect(formatAmount({ quantity: 1, unit: "cup" })).toBe("1 cup");
  });

  it("scales weights up to pounds", () => {
    const combined = combineAmounts([
      { quantity: 12, unit: "oz" },
      { quantity: 8, unit: "oz" },
    ]);
    expect(formatAmounts(combined.amounts)).toBe("1 1/4 lb");
  });
});

describe("real-world lines seen in the wild", () => {
  it("keeps compound names split by commas together", () => {
    const parsed = parseIngredientLine("3/4 lb. boneless, skinless chicken breast ($2.09)");
    expect(parsed.key).toBe("boneless skinless chicken breast");
    expect(parsed.aisle).toBe("Meat & Seafood");
    expect(parsed.quantity).toBe(0.75);
    expect(parsed.unit).toBe("lb");
  });

  it("still peels off genuine prep tails", () => {
    const parsed = parseIngredientLine("1 yellow onion, finely diced");
    expect(parsed.key).toBe("yellow onion");
    expect(parsed.note).toContain("finely diced");
  });

  it("sends bell peppers to produce, peppercorns to spices", () => {
    expect(parseIngredientLine("3 bell peppers").aisle).toBe("Produce");
    expect(parseIngredientLine("1/2 teaspoon pepper").aisle).toBe("Spices & Baking");
    expect(parseIngredientLine("1 teaspoon garlic powder").aisle).toBe("Spices & Baking");
    expect(parseIngredientLine("3 cloves garlic").aisle).toBe("Produce");
  });

  it("prefers readable teaspoons over fractional tablespoons", () => {
    const combined = combineAmounts([
      { quantity: 1, unit: "tsp" },
      { quantity: 1.5, unit: "tsp" },
      { quantity: 1, unit: "tsp" },
    ]);
    expect(formatAmounts(combined.amounts)).toBe("3 1/2 tsp");
  });
});
