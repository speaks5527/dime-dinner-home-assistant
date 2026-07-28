import { describe, expect, it } from "vitest";
import { aggregateIngredients, applyPantry, pantryKey, visibleLines } from "../server/lib/grocery";

const tacos = {
  recipeTitle: "Easy Beef Tacos",
  lines: ["1 pound ground beef", "1 cup shredded cheddar cheese", "2 medium tomatoes (diced)", "1/2 teaspoon salt"],
};
const chili = {
  recipeTitle: "Slow Cooker Chili",
  lines: ["2 pounds ground beef", "1 cup shredded cheddar cheese", "1 teaspoon salt", "3 cloves garlic (minced)"],
};

describe("grocery aggregation", () => {
  it("combines duplicate ingredients across recipes", () => {
    const lines = aggregateIngredients([tacos, chili]);
    const beef = lines.find((l) => l.key === "ground beef");
    expect(beef?.display).toBe("3 lb");
    expect(beef?.sources).toHaveLength(2);
    expect(beef?.aisle).toBe("Meat & Seafood");
  });

  it("merges small volume units into a friendly total", () => {
    const lines = aggregateIngredients([tacos, chili]);
    const cheese = lines.find((l) => l.key === "cheddar cheese");
    expect(cheese?.display).toBe("2 cups");
    const salt = lines.find((l) => l.key === "salt");
    expect(salt?.display).toBe("1 1/2 tsp");
  });

  it("groups the list by aisle", () => {
    const lines = aggregateIngredients([tacos, chili]);
    const aisles = lines.map((l) => l.aisle);
    expect(aisles.indexOf("Produce")).toBeLessThan(aisles.indexOf("Spices & Baking"));
  });

  it("returns an empty list for an empty week", () => {
    expect(aggregateIngredients([])).toEqual([]);
  });
});

describe("pantry deduction", () => {
  it("reduces a quantity when the pantry partially covers it", () => {
    const lines = aggregateIngredients([tacos, chili]);
    const withPantry = applyPantry(lines, [
      { itemKey: pantryKey("ground beef"), name: "Ground beef", quantity: 1, unit: "lb" },
    ]);
    const beef = withPantry.find((l) => l.key === "ground beef")!;
    expect(beef.pantry?.status).toBe("reduced");
    expect(beef.display).toBe("2 lb");
    expect(beef.pantry?.originalDisplay).toBe("3 lb");
    expect(beef.pantry?.pantryDisplay).toBe("1 lb");
  });

  it("fully covers and hides an item the pantry satisfies", () => {
    const lines = aggregateIngredients([tacos]);
    const withPantry = applyPantry(lines, [
      { itemKey: pantryKey("ground beef"), name: "Ground beef", quantity: 2, unit: "lb" },
    ]);
    const beef = withPantry.find((l) => l.key === "ground beef")!;
    expect(beef.pantry?.status).toBe("covered");
    expect(beef.display).toBe("in pantry");
    expect(visibleLines(withPantry).some((l) => l.key === "ground beef")).toBe(false);
  });

  it("converts between compatible units before deducting", () => {
    const lines = aggregateIngredients([{ recipeTitle: "R", lines: ["2 cups milk"] }]);
    const withPantry = applyPantry(lines, [{ itemKey: pantryKey("milk"), name: "Milk", quantity: 8, unit: "fl oz" }]);
    expect(withPantry[0].display).toBe("1 cup");
    expect(withPantry[0].pantry?.status).toBe("reduced");
  });

  it("does not deduct across incompatible units — it only notes the pantry stock", () => {
    const lines = aggregateIngredients([{ recipeTitle: "R", lines: ["3 cups all-purpose flour"] }]);
    const withPantry = applyPantry(lines, [
      { itemKey: pantryKey("all-purpose flour"), name: "All-purpose flour", quantity: 2, unit: "lb" },
    ]);
    expect(withPantry[0].pantry?.status).toBe("noted");
    expect(withPantry[0].display).toBe("3 cups");
  });

  it("lets an unquantified pantry entry cover shelf-stable staples only", () => {
    const staple = aggregateIngredients([{ recipeTitle: "R", lines: ["1 teaspoon garlic powder"] }]);
    const coveredStaple = applyPantry(staple, [
      { itemKey: pantryKey("garlic powder"), name: "Garlic powder", quantity: null, unit: null },
    ]);
    expect(coveredStaple[0].pantry?.status).toBe("covered");

    const fresh = aggregateIngredients([{ recipeTitle: "R", lines: ["2 pounds ground beef"] }]);
    const notedFresh = applyPantry(fresh, [
      { itemKey: pantryKey("ground beef"), name: "Ground beef", quantity: null, unit: null },
    ]);
    expect(notedFresh[0].pantry?.status).toBe("noted");
    expect(notedFresh[0].display).toBe("2 lb");
  });

  it("restores the full amount when the user overrides the deduction", () => {
    const lines = aggregateIngredients([tacos]);
    const overridden = applyPantry(
      lines,
      [{ itemKey: pantryKey("ground beef"), name: "Ground beef", quantity: 2, unit: "lb" }],
      new Set(["ground beef"]),
    );
    const beef = overridden.find((l) => l.key === "ground beef")!;
    expect(beef.pantry?.overridden).toBe(true);
    expect(beef.display).toBe("1 lb");
    expect(visibleLines(overridden).some((l) => l.key === "ground beef")).toBe(true);
  });

  it("leaves untouched lines alone", () => {
    const lines = aggregateIngredients([tacos]);
    const withPantry = applyPantry(lines, [{ itemKey: pantryKey("saffron"), name: "Saffron", quantity: 1, unit: "g" }]);
    expect(withPantry.every((l) => l.pantry === null)).toBe(true);
  });

  it("spends pantry stock only once across multiple parts", () => {
    const lines = aggregateIngredients([
      { recipeTitle: "A", lines: ["1 cup milk"] },
      { recipeTitle: "B", lines: ["2 cloves garlic"] },
    ]);
    const withPantry = applyPantry(lines, [
      { itemKey: pantryKey("milk"), name: "Milk", quantity: 4, unit: "cup" },
      { itemKey: pantryKey("garlic"), name: "Garlic", quantity: 1, unit: "clove" },
    ]);
    expect(withPantry.find((l) => l.key === "milk")!.pantry?.status).toBe("covered");
    expect(withPantry.find((l) => l.key === "garlic")!.display).toBe("1 clove");
  });
});
