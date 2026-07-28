import { describe, expect, it } from "vitest";
import { detectRecipes, mergeCandidates, MIN_CONFIDENCE } from "../server/lib/ebookParser";

/** A page as OCR actually returns it: two columns flattened, characters wrong. */
const OCR_RECIPE_PAGE = `INGREDIENTS

4 eggs

1/2 cup hemp milk

1 tablespoon psyllium husk
powder

] teaspoon vanilla extract

1 tablespoon butter for frying

INSTRUCTIONS

1.Combine all ingredients
except for butter in a small
blender.

2.Blend for 20 seconds, or until
smooth.

3.Let the batter rest for 2
minutes - It will be thick.

4.Heat the butter in a nonstick
skillet over medium heat.

Squeaky Pancakes

| 3 servings, 2 pancakes each © 18 minutes

Move over bacon and eggs, these
pancakes are a squeaky game changer!

NOTES:

1.The batter won't keep, so cook all of the
pancakes at once.

191 calories, 12g fat, 10g carbs, 7g fiber, 1Og protein
`;

const CONTENTS_PAGE = `CONTENTS

Breakfast

Squeaky Pancakes .............. 13
Berry Bliss Bowl ................ 16
Italian Frittata ................... 17

Mains

Salmon Chowder ............... 22
Shrimp Stew ...................... 23

INGREDIENTS FOR SUCCESS
Read the whole book first.
`;

const MEAL_PLAN_PAGE = `WEEK ONE MEAL PLAN

MONDAY
Breakfast: Squeaky Pancakes
Lunch: Tuna Salad
Dinner: Salmon Chowder

TUESDAY
Breakfast: Berry Bliss Bowl
Lunch: Egg Salad
Dinner: Shrimp Stew

Remember to drink plenty of water and
track your carbs each day.
`;

describe("ebook recipe detection", () => {
  it("reads a recipe out of a page of OCR text", () => {
    const { candidates } = detectRecipes([OCR_RECIPE_PAGE]);
    expect(candidates).toHaveLength(1);

    const recipe = candidates[0];
    expect(recipe.title).toBe("Squeaky Pancakes");
    expect(recipe.pages).toEqual([1]);
    expect(recipe.confidence).toBeGreaterThanOrEqual(0.9);
    expect(recipe.warnings).toEqual([]);
  });

  it("rejoins ingredients that wrapped onto a second line", () => {
    const { candidates } = detectRecipes([OCR_RECIPE_PAGE]);
    expect(candidates[0].ingredients).toContain("1 tablespoon psyllium husk powder");
  });

  it("reads a quantity whose 1 was recognised as a bracket", () => {
    const { candidates } = detectRecipes([OCR_RECIPE_PAGE]);
    expect(candidates[0].ingredients).toContain("] teaspoon vanilla extract");
  });

  it("keeps numbered steps whole and strips their numbering", () => {
    const steps = detectRecipes([OCR_RECIPE_PAGE]).candidates[0].instructions[0].steps;
    expect(steps).toHaveLength(4);
    expect(steps[0].text).toBe("Combine all ingredients except for butter in a small blender.");
    expect(steps[2].text).toBe("Let the batter rest for 2 minutes - It will be thick.");
  });

  it("reads servings, time and nutrition off the meta strip", () => {
    const recipe = detectRecipes([OCR_RECIPE_PAGE]).candidates[0];
    expect(recipe.servings).toBe("3 servings, 2 pancakes each");
    expect(recipe.totalMinutes).toBe(18);
    expect(recipe.nutrition).toMatchObject({ calories: "191", fat: "12g", protein: "10g" });
  });

  it("keeps the notes separate from the method", () => {
    const recipe = detectRecipes([OCR_RECIPE_PAGE]).candidates[0];
    expect(recipe.notes[0]).toContain("batter won't keep");
    const stepText = recipe.instructions.flatMap((g) => g.steps.map((s) => s.text)).join(" ");
    expect(stepText).not.toContain("batter won't keep");
  });

  it("names an alternative method as its own group", () => {
    const page = OCR_RECIPE_PAGE.replace(
      "Squeaky Pancakes",
      "ALTERNATIVE METHOD\n1.Butter a small ramekin.\n2.Microwave for 40 seconds.\n\nSqueaky Pancakes",
    );
    const groups = detectRecipes([page]).candidates[0].instructions;
    expect(groups).toHaveLength(2);
    expect(groups[1].heading).toBe("ALTERNATIVE METHOD");
    expect(groups[1].steps).toHaveLength(2);
  });

  it("survives OCR noise welded onto the INSTRUCTIONS heading", () => {
    const { candidates } = detectRecipes([OCR_RECIPE_PAGE.replace("INSTRUCTIONS", "INSTRUCTIONS gy Oa om")]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].instructions[0].steps.length).toBe(4);
  });

  it("splits a title off the column gutter it was flattened into", () => {
    const page = OCR_RECIPE_PAGE.replace(
      "4.Heat the butter in a nonstick\nskillet over medium heat.\n\nSqueaky Pancakes",
      "4.Heat the butter in a nonstick\nskillet over medium heat.      Squeaky Pancakes",
    );
    expect(detectRecipes([page]).candidates[0].title).toBe("Squeaky Pancakes");
  });

  it("does not treat a table of contents as a recipe", () => {
    const { candidates, skippedPages } = detectRecipes([CONTENTS_PAGE]);
    expect(candidates).toHaveLength(0);
    expect(skippedPages).toEqual([1]);
  });

  it("does not treat a meal plan as a recipe", () => {
    const { candidates, skippedPages } = detectRecipes([MEAL_PLAN_PAGE]);
    expect(candidates).toHaveLength(0);
    expect(skippedPages).toEqual([1]);
  });

  it("finds several recipes across a book and records their pages", () => {
    const { candidates, skippedPages } = detectRecipes([
      CONTENTS_PAGE,
      OCR_RECIPE_PAGE,
      MEAL_PLAN_PAGE,
      OCR_RECIPE_PAGE.replace("Squeaky Pancakes", "Berry Bliss Bowl"),
    ]);
    expect(candidates.map((c) => c.pages[0])).toEqual([2, 4]);
    expect(candidates.map((c) => c.title)).toEqual(["Squeaky Pancakes", "Berry Bliss Bowl"]);
    expect(skippedPages).toEqual([1, 3]);
  });

  it("leaves an unreadable title null and says so instead of inventing one", () => {
    const page = OCR_RECIPE_PAGE.replace("Squeaky Pancakes\n", "");
    const recipe = detectRecipes([page]).candidates[0];
    expect(recipe.title).toBeNull();
    expect(recipe.warnings.join(" ")).toMatch(/no title/i);
    expect(recipe.confidence).toBeLessThan(1);
  });

  it("warns when a page yielded barely any content", () => {
    const thin = `INGREDIENTS

2 cups flour

INSTRUCTIONS

1.Stir it all together well and serve at once.

Plain Flour Paste

| 1 serving © 2 minutes
`;
    const recipe = detectRecipes([thin]).candidates[0];
    expect(recipe.confidence).toBeLessThan(0.7);
    expect(recipe.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("skips a page with an ingredients list but no method", () => {
    const page = OCR_RECIPE_PAGE.replace(/INSTRUCTIONS[\s\S]*/, "");
    expect(detectRecipes([page]).candidates).toHaveLength(0);
  });

  it("reads a text-layer page that has no headings at all", () => {
    const page = `Simple Pancakes

2 cups flour
1 cup milk
3 large eggs
1 teaspoon salt

1. Mix the flour and salt.
2. Add the milk and eggs.
3. Cook for 10 minutes.
`;
    const recipe = detectRecipes([page]).candidates[0];
    expect(recipe.title).toBe("Simple Pancakes");
    expect(recipe.ingredients).toHaveLength(4);
    expect(recipe.instructions[0].steps).toHaveLength(3);
    expect(recipe.warnings.join(" ")).toMatch(/no INGREDIENTS\/INSTRUCTIONS headings/i);
  });

  it("skips blank and near-blank pages", () => {
    const { candidates, skippedPages } = detectRecipes(["", "   \n \n", "a few stray words"]);
    expect(candidates).toHaveLength(0);
    expect(skippedPages).toEqual([1, 2, 3]);
  });

  it("only returns candidates at or above the confidence floor", () => {
    const { candidates } = detectRecipes([OCR_RECIPE_PAGE, CONTENTS_PAGE, MEAL_PLAN_PAGE]);
    for (const candidate of candidates) expect(candidate.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });
});

describe("merging candidates", () => {
  it("joins a recipe split across two pages in page order", () => {
    const { candidates } = detectRecipes([
      OCR_RECIPE_PAGE,
      OCR_RECIPE_PAGE.replace("Squeaky Pancakes", "Squeaky Pancakes Continued"),
    ]);
    const merged = mergeCandidates([candidates[1], candidates[0]])!;

    expect(merged.title).toBe("Squeaky Pancakes");
    expect(merged.pages).toEqual([1, 2]);
    expect(merged.ingredients).toHaveLength(
      candidates[0].ingredients.length + candidates[1].ingredients.length,
    );
    expect(merged.confidence).toBe(Math.min(candidates[0].confidence, candidates[1].confidence));
  });

  it("returns a single candidate untouched and null for none", () => {
    const { candidates } = detectRecipes([OCR_RECIPE_PAGE]);
    expect(mergeCandidates(candidates)).toBe(candidates[0]);
    expect(mergeCandidates([])).toBeNull();
  });
});
