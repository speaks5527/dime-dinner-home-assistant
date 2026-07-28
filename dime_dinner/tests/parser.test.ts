import { describe, expect, it } from "vitest";
import {
  extractJsonLdBlocks,
  findRecipeNode,
  parseDuration,
  parseInstructions,
  parseRecipeFromHtml,
  sanitizeText,
  sanitizeImageUrl,
} from "../server/lib/recipeParser";

const wrap = (json: unknown, extraHead = "") =>
  `<!doctype html><html><head>${extraHead}<script type="application/ld+json">${JSON.stringify(
    json,
  )}</script></head><body><p>page</p></body></html>`;

const baseRecipe = {
  "@type": "Recipe",
  name: "Crockpot Chicken and Noodles",
  description: "Comforting slow cooker dinner.",
  author: { "@type": "Person", name: "Carrie Barnard" },
  image: [
    "https://www.eatingonadime.com/wp-content/uploads/hero.jpg",
    "https://www.eatingonadime.com/wp-content/uploads/hero-500x500.jpg",
  ],
  recipeYield: ["6", "6 -8 servings"],
  prepTime: "PT15M",
  cookTime: "PT6H",
  totalTime: "PT6H15M",
  recipeCategory: "Main Course",
  recipeCuisine: "American",
  recipeIngredient: ["2 pounds boneless skinless chicken breasts", "12 ounces wide egg noodles"],
  recipeInstructions: [
    { "@type": "HowToStep", text: "Place the chicken in the crock pot." },
    { "@type": "HowToStep", text: "Cook on low for 6 hours." },
  ],
  nutrition: { "@type": "NutritionInformation", calories: "512 kcal", proteinContent: "38 g" },
};

describe("JSON-LD recipe extraction", () => {
  it("parses a bare Recipe object", () => {
    const parsed = parseRecipeFromHtml(wrap(baseRecipe), "https://www.eatingonadime.com/x/");
    expect(parsed?.title).toBe("Crockpot Chicken and Noodles");
    expect(parsed?.ingredients).toHaveLength(2);
    expect(parsed?.instructions[0].steps).toHaveLength(2);
    expect(parsed?.prepMinutes).toBe(15);
    expect(parsed?.cookMinutes).toBe(360);
    expect(parsed?.totalMinutes).toBe(375);
    expect(parsed?.servings).toBe("6 -8 servings");
    expect(parsed?.imageUrl).toBe("https://www.eatingonadime.com/wp-content/uploads/hero.jpg");
    expect(parsed?.nutrition).toMatchObject({ Calories: "512 kcal", Protein: "38 g" });
  });

  it("parses a Recipe nested in an @graph container", () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [{ "@type": "WebSite", name: "Site" }, { "@type": "WebPage" }, baseRecipe],
    };
    const parsed = parseRecipeFromHtml(wrap(graph), "https://example.com/recipe/");
    expect(parsed?.title).toBe("Crockpot Chicken and Noodles");
  });

  it("parses a Recipe inside a top-level array", () => {
    const parsed = parseRecipeFromHtml(wrap([{ "@type": "Organization" }, baseRecipe]), "https://example.com/r/");
    expect(parsed?.ingredients[0]).toContain("chicken breasts");
  });

  it("accepts @type given as an array", () => {
    const node = { ...baseRecipe, "@type": ["NewsArticle", "Recipe"] };
    const parsed = parseRecipeFromHtml(wrap(node), "https://example.com/r/");
    expect(parsed?.title).toBe("Crockpot Chicken and Noodles");
  });

  it("handles HowToSection groups and preserves genuine step images", () => {
    const node = {
      ...baseRecipe,
      recipeInstructions: [
        {
          "@type": "HowToSection",
          name: "Prep",
          itemListElement: [
            { "@type": "HowToStep", text: "Chop the onion.", image: "https://cdn.example.com/step1.jpg" },
            { "@type": "HowToStep", text: "Mince the garlic." },
          ],
        },
        {
          "@type": "HowToSection",
          name: "Cook",
          itemListElement: [{ "@type": "HowToStep", text: "Simmer 20 minutes." }],
        },
      ],
    };
    const parsed = parseRecipeFromHtml(wrap(node), "https://example.com/r/");
    expect(parsed?.instructions).toHaveLength(2);
    expect(parsed?.instructions[0].heading).toBe("Prep");
    expect(parsed?.instructions[0].steps[0].image).toBe("https://cdn.example.com/step1.jpg");
    expect(parsed?.instructions[0].steps[1].image).toBeUndefined();
    expect(parsed?.instructions[1].steps[0].text).toBe("Simmer 20 minutes.");
  });

  it("handles plain-string instructions", () => {
    const node = { ...baseRecipe, recipeInstructions: ["Mix everything.", "Bake for 20 minutes."] };
    const parsed = parseRecipeFromHtml(wrap(node), "https://example.com/r/");
    expect(parsed?.instructions[0].steps.map((s) => s.text)).toEqual(["Mix everything.", "Bake for 20 minutes."]);
  });

  it("splits an HTML instruction blob into steps", () => {
    const groups = parseInstructions("<ol><li>Preheat the oven.</li><li>Bake 30 minutes.</li></ol>");
    expect(groups[0].steps.map((s) => s.text)).toEqual(["Preheat the oven.", "Bake 30 minutes."]);
  });

  it("falls back to og: meta for image and site name", () => {
    const node = { ...baseRecipe, image: undefined };
    const html = wrap(node, '<meta property="og:image" content="https://cdn.example.com/og.jpg"><meta property="og:site_name" content="Example Kitchen">');
    const parsed = parseRecipeFromHtml(html, "https://example.com/r/");
    expect(parsed?.imageUrl).toBe("https://cdn.example.com/og.jpg");
    expect(parsed?.siteName).toBe("Example Kitchen");
  });

  it("derives siteName from the hostname when og:site_name is absent", () => {
    const parsed = parseRecipeFromHtml(wrap(baseRecipe), "https://www.allrecipes.com/recipe/123/");
    expect(parsed?.siteName).toBe("allrecipes.com");
  });

  it("returns null when there is no recipe data", () => {
    expect(parseRecipeFromHtml("<html><body>no recipe here</body></html>", "https://example.com/")).toBeNull();
    expect(parseRecipeFromHtml(wrap({ "@type": "Article", headline: "hi" }), "https://example.com/")).toBeNull();
  });

  it("recovers from one malformed JSON-LD block", () => {
    const html = `<script type="application/ld+json">{ broken json </script>${wrap(baseRecipe)}`;
    expect(parseRecipeFromHtml(html, "https://example.com/")?.title).toBe("Crockpot Chicken and Noodles");
  });

  it("finds a recipe-shaped node even without @type", () => {
    const node = { name: "Untyped", recipeIngredient: ["1 cup rice"], recipeInstructions: ["Cook it."] };
    expect(findRecipeNode(extractJsonLdBlocks(wrap(node)))).toBeTruthy();
  });
});

describe("sanitizing", () => {
  it("strips markup, scripts and entities from stored text", () => {
    expect(sanitizeText('<script>alert("x")</script><b>Hello&nbsp;&amp; welcome</b>')).toBe("Hello & welcome");
    expect(sanitizeText("<img src=x onerror=alert(1)>Cook")).toBe("Cook");
  });

  it("rejects non-http image URLs", () => {
    expect(sanitizeImageUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeImageUrl("data:image/png;base64,AAA")).toBeNull();
    expect(sanitizeImageUrl({ url: "https://cdn.example.com/a.jpg" })).toBe("https://cdn.example.com/a.jpg");
    expect(sanitizeImageUrl("/rel.jpg", "https://example.com/r/")).toBe("https://example.com/rel.jpg");
  });

  it("parses durations in several notations", () => {
    expect(parseDuration("PT1H30M")).toBe(90);
    expect(parseDuration("PT45M")).toBe(45);
    expect(parseDuration("P1DT2H")).toBe(1560);
    expect(parseDuration("1 hour 15 minutes")).toBe(75);
    expect(parseDuration(null)).toBeNull();
  });
});
