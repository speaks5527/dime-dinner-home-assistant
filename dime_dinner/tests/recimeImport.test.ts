/**
 * Reading a recipe out of ReciMe: share links, and PDFs the app exported.
 *
 * ReciMe publishes no API, so there is nothing to integrate with and nothing
 * here talks to a ReciMe service. What is tested is the knowledge Dime Dinner
 * adds to two paths it already had — the SSRF-guarded page fetch and the
 * poppler/OCR PDF pipeline — plus the one behaviour that matters more than any
 * parsing detail: a page that asks the visitor to sign in is refused, not
 * worked around.
 *
 * Network-touching tests stub `fetch` and use a public IP literal as the host,
 * the same trick the pdfSource suite uses: `assertPublicHost` short-circuits on
 * literals, so no DNS lookup happens and nothing leaves the machine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findRecimeRecipeNode,
  isRecimeUrl,
  looksLikeRecimePdf,
  parseRecimeSharePage,
  recimeAccessProblem,
  recimeFooterUrl,
} from "../server/lib/recime";
import { buildDocumentCandidate } from "../server/lib/ebookParser";
import { importFromUrl } from "../server/lib/source";
import { FetchRejected } from "../server/lib/safeFetch";

const SHARE_URL = "https://recime.app/recipe/sheet-pan-gnocchi";

function page(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

/**
 * Fetched pages are cached for fifteen minutes, so each test that goes through
 * `importFromUrl` needs a URL of its own or it will read the previous test's
 * page instead of its own stub.
 */
let counter = 0;
function freshShareUrl(): string {
  counter += 1;
  return `https://recime.app/recipe/case-${counter}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------ recognising ------------------------------- */

describe("recognising a ReciMe link", () => {
  it("accepts the hosts ReciMe serves share pages from, including subdomains", () => {
    expect(isRecimeUrl("https://recime.app/recipe/abc")).toBe(true);
    expect(isRecimeUrl("https://www.recime.app/recipe/abc")).toBe(true);
    expect(isRecimeUrl("https://share.recime.io/r/abc")).toBe(true);
    expect(isRecimeUrl(new URL("https://recimeapp.com/recipe/abc"))).toBe(true);
    // A trailing dot is still the same host.
    expect(isRecimeUrl("https://recime.app./recipe/abc")).toBe(true);
  });

  it("is not fooled by a lookalike hostname", () => {
    expect(isRecimeUrl("https://recime.app.evil.example/recipe/abc")).toBe(false);
    expect(isRecimeUrl("https://notrecime.app/recipe/abc")).toBe(false);
    expect(isRecimeUrl("https://recime.appliances.example/x")).toBe(false);
    expect(isRecimeUrl("not a url")).toBe(false);
  });
});

/* -------------------------------- JSON-LD --------------------------------- */

const JSON_LD = `<!doctype html><html><head>
<title>Sheet Pan Gnocchi | ReciMe</title>
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: "Sheet Pan Gnocchi",
  description: "Everything on one tray.",
  image: "https://cdn.recime.app/gnocchi.jpg",
  author: { "@type": "Person", name: "Dana Cook" },
  prepTime: "PT10M",
  cookTime: "PT25M",
  recipeYield: "4 servings",
  recipeIngredient: ["500 g shelf-stable gnocchi", "2 tbsp olive oil", "300 g cherry tomatoes"],
  recipeInstructions: [
    { "@type": "HowToStep", text: "Heat the oven to 220C." },
    { "@type": "HowToStep", text: "Toss the gnocchi with the oil and tomatoes." },
    { "@type": "HowToStep", text: "Roast for 25 minutes, shaking the tray once." },
  ],
})}</script></head><body></body></html>`;

describe("a share page that publishes standard recipe data", () => {
  it("is read by the existing schema.org parser, not the ReciMe fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => page(JSON_LD)));
    const url = freshShareUrl();

    const { recipe, sourceUrl } = await importFromUrl(url);

    expect(recipe.title).toBe("Sheet Pan Gnocchi");
    expect(recipe.ingredients).toHaveLength(3);
    expect(recipe.instructions[0].steps).toHaveLength(3);
    expect(recipe.prepMinutes).toBe(10);
    expect(recipe.cookMinutes).toBe(25);
    expect(recipe.servings).toBe("4 servings");
    expect(recipe.author).toBe("Dana Cook");
    // The share link itself is what the recipe is keyed by, so it survives.
    expect(sourceUrl).toBe(url);
  });
});

/* ---------------------------- the ReciMe fallback -------------------------- */

const EMBEDDED = `<!doctype html><html><head>
<title>Miso Butter Corn | ReciMe</title>
<meta property="og:image" content="https://cdn.recime.app/corn.jpg" />
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      data: {
        recipe: {
          title: "Miso Butter Corn",
          summary: "A side that eats like a main.",
          user: { displayName: "Jo Field" },
          serves: 2,
          prepTimeMinutes: 5,
          cookTimeMinutes: 15,
          tags: ["Sides", "Vegetarian"],
          ingredientLines: [
            { quantity: "4", unit: "ears", name: "sweetcorn" },
            { text: "2 tbsp white miso" },
            "60 g salted butter",
          ],
          steps: [
            {
              title: "Prep",
              steps: [{ text: "Strip the husks and snap each cob in half." }],
            },
            {
              name: "Cook",
              steps: [
                { instruction: "Boil the cobs for six minutes." },
                { instruction: "Mash the miso into the butter and roll the hot cobs in it." },
              ],
            },
          ],
        },
      },
    },
  },
})}</script></head><body></body></html>`;

describe("a share page with no JSON-LD", () => {
  it("reads the recipe out of the page's own embedded state", () => {
    const parsed = parseRecimeSharePage(EMBEDDED, SHARE_URL)!;

    expect(parsed.title).toBe("Miso Butter Corn");
    expect(parsed.description).toBe("A side that eats like a main.");
    expect(parsed.author).toBe("Jo Field");
    expect(parsed.servings).toBe("2");
    expect(parsed.imageUrl).toBe("https://cdn.recime.app/corn.jpg");
    expect(parsed.siteName).toBe("ReciMe");

    // Every shape ReciMe might model an ingredient in comes back as one line.
    expect(parsed.ingredients).toEqual(["4 ears sweetcorn", "2 tbsp white miso", "60 g salted butter"]);

    expect(parsed.instructions).toEqual([
      { heading: "Prep", steps: [{ text: "Strip the husks and snap each cob in half." }] },
      {
        heading: "Cook",
        steps: [
          { text: "Boil the cobs for six minutes." },
          { text: "Mash the miso into the butter and roll the hot cobs in it." },
        ],
      },
    ]);
  });

  it("derives a total time from prep and cook, and never invents one", () => {
    expect(parseRecimeSharePage(EMBEDDED, SHARE_URL)!.totalMinutes).toBe(20);

    const timeless = EMBEDDED.replace(/"prepTimeMinutes":5,/, "").replace(/"cookTimeMinutes":15,/, "");
    const parsed = parseRecimeSharePage(timeless, SHARE_URL)!;
    expect(parsed.prepMinutes).toBeNull();
    expect(parsed.cookMinutes).toBeNull();
    expect(parsed.totalMinutes).toBeNull();
  });

  it("drops the ReciMe suffix from a title that came from the page chrome", () => {
    const shell = (title: string) => `<html><head><title>${title}</title></head><body>
      <h2>Ingredients</h2><ul><li>1 onion</li></ul>
      <h2>Method</h2><ol><li>Chop the onion and fry it slowly.</li></ol></body></html>`;

    for (const title of ["Onion Base | ReciMe", "Onion Base · ReciMe", "Onion Base – ReciMe recipes"]) {
      expect(parseRecimeSharePage(shell(title), SHARE_URL)!.title).toBe("Onion Base");
    }
  });

  it("falls back to the rendered headings when there is no embedded state at all", () => {
    const html = `<!doctype html><html><head><title>Lemon Orzo | ReciMe</title></head><body>
      <h2>Ingredients</h2><ul><li>200 g orzo</li><li>1 lemon, zested and juiced</li></ul>
      <h2>Method</h2><ol><li>Boil the orzo in salted water for eight minutes.</li>
      <li>Stir through the lemon and a knob of butter.</li></ol>
      <h2>Nutrition</h2><p>Not our numbers</p></body></html>`;

    const parsed = parseRecimeSharePage(html, SHARE_URL)!;
    expect(parsed.title).toBe("Lemon Orzo");
    expect(parsed.ingredients).toEqual(["200 g orzo", "1 lemon, zested and juiced"]);
    expect(parsed.instructions[0].steps.map((s) => s.text)).toEqual([
      "Boil the orzo in salted water for eight minutes.",
      "Stir through the lemon and a knob of butter.",
    ]);
    // The section after the method must not leak into it.
    expect(JSON.stringify(parsed.instructions)).not.toMatch(/Not our numbers/);
  });

  it("refuses to turn a page without both halves of a recipe into one", () => {
    const marketing = `<html><head><title>ReciMe — save recipes from anywhere</title></head>
      <body><h1>Download the app</h1><p>Thousands of recipes.</p></body></html>`;
    expect(parseRecimeSharePage(marketing, SHARE_URL)).toBeNull();

    const ingredientsOnly = `<html><head><title>Half a recipe | ReciMe</title></head><body>
      <h2>Ingredients</h2><ul><li>1 onion</li></ul></body></html>`;
    expect(parseRecimeSharePage(ingredientsOnly, SHARE_URL)).toBeNull();
  });

  it("finds the recipe wherever in the payload it is buried", () => {
    const node = findRecimeRecipeNode([
      { a: { b: [{ c: { name: "Deep Dish", ingredients: ["flour"], steps: ["bake"] } }] } },
    ]);
    expect(node?.name).toBe("Deep Dish");
    expect(findRecimeRecipeNode([{ nothing: "here" }])).toBeNull();
  });
});

/* ----------------------------- private links ------------------------------ */

describe("a link that is not a public share", () => {
  it("reports a sign-in wall as private instead of importing the shell page", async () => {
    const wall = `<html><head><title>ReciMe</title></head><body>
      <h1>Sign in to view this recipe</h1></body></html>`;
    vi.stubGlobal("fetch", vi.fn(async () => page(wall)));

    await expect(importFromUrl(freshShareUrl())).rejects.toThrow(/not a public share link/i);
  });

  it("explains a 403 in ReciMe's terms and does not offer to sign in", () => {
    const message = recimeAccessProblem(403, "")!;
    expect(message).toMatch(/private or has been revoked/i);
    expect(message).toMatch(/will not sign in to ReciMe/i);
  });

  it("distinguishes a deleted link from a private one", () => {
    expect(recimeAccessProblem(404, "")).toMatch(/could not be found/i);
    expect(recimeAccessProblem(410, "")).toMatch(/could not be found/i);
    expect(recimeAccessProblem(500, "")).toMatch(/HTTP 500/);
    expect(recimeAccessProblem(200, "<p>A perfectly ordinary page</p>")).toBeNull();
  });

  it("recognises a revoked share link from the page body", () => {
    expect(recimeAccessProblem(200, "<p>This recipe is private.</p>")).toMatch(/not a public share link/i);
    expect(recimeAccessProblem(200, "<p>That link has expired.</p>")).toMatch(/not a public share link/i);
  });

  it("never substitutes a demo recipe when a ReciMe link cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => page("Forbidden", 403)));

    // The demo catalogue exists for eatingonadime.com; answering a ReciMe link
    // with someone else's recipe would be worse than failing.
    await expect(importFromUrl(freshShareUrl())).rejects.toThrow(/private or has been revoked/i);
  });

  it("says what to do next when a ReciMe page holds no readable recipe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => page("<html><body><h1>My collections</h1></body></html>")));

    await expect(importFromUrl(freshShareUrl())).rejects.toThrow(/export the recipe from ReciMe as a PDF/i);
  });
});

/* ---------------------------- exported PDFs ------------------------------- */

describe("recognising a PDF that came out of ReciMe", () => {
  it("trusts the document metadata", () => {
    expect(looksLikeRecimePdf({ producer: "ReciMe 5.2" })).toBe(true);
    expect(looksLikeRecimePdf({ creator: "ReciMe" })).toBe(true);
    expect(looksLikeRecimePdf({ title: "Gnocchi — exported from ReciMe" })).toBe(true);
  });

  it("falls back to the footer when a print-to-PDF step stripped the metadata", () => {
    expect(looksLikeRecimePdf({ producer: "macOS Quartz PDFContext" }, ["Gnocchi", "Made with ReciMe"])).toBe(true);
    expect(looksLikeRecimePdf({}, ["Gnocchi", "https://recime.app/recipe/gnocchi"])).toBe(true);
  });

  it("does not claim an ordinary cookbook", () => {
    expect(looksLikeRecimePdf({ title: "Test Cookbook", author: "A Cook", producer: "LaTeX" })).toBe(false);
    expect(looksLikeRecimePdf({}, ["CONTENTS", "Breakfast", "Mains"])).toBe(false);
    // A signal buried deep in a long book is not a ReciMe export.
    expect(looksLikeRecimePdf({}, ["one", "two", "three", "Made with ReciMe"])).toBe(false);
  });

  it("keeps the share link the export printed", () => {
    expect(recimeFooterUrl(["Gnocchi", "Saved from https://recime.app/recipe/gnocchi."])).toBe(
      "https://recime.app/recipe/gnocchi",
    );
    // Someone else's URL in the footer is not a ReciMe share link.
    expect(recimeFooterUrl(["See https://example.com/blog"])).toBeNull();
    expect(recimeFooterUrl([])).toBeNull();
  });
});

describe("reading a ReciMe export as one recipe", () => {
  /** Two pages, because a ReciMe export splits its method over a page break. */
  const pages = [
    ["ReciMe", "Sticky Sesame Tofu", "Serves 3", "Total time: 40 minutes", "Ingredients", "400 g firm tofu", "3 tbsp soy sauce", "2 tbsp honey", "1 tbsp sesame seeds"].join("\n"),
    [
      "Instructions",
      "1. Press the tofu for twenty minutes, then cube it.",
      "2. Fry the cubes until every side is golden brown.",
      "3. Add the soy and honey and let it reduce to a glaze.",
      "4. Scatter the sesame seeds over and serve.",
      "Made with ReciMe · https://recime.app/recipe/sticky-sesame-tofu",
    ].join("\n"),
  ];

  it("keeps the ingredients and the method together across the page break", () => {
    const candidate = buildDocumentCandidate(pages, "job-1")!;

    expect(candidate.title).toBe("Sticky Sesame Tofu");
    expect(candidate.pages).toEqual([1, 2]);
    expect(candidate.ingredients).toEqual([
      "400 g firm tofu",
      "3 tbsp soy sauce",
      "2 tbsp honey",
      "1 tbsp sesame seeds",
    ]);
    expect(candidate.instructions.flatMap((group) => group.steps)).toHaveLength(4);
    expect(candidate.servings).toBe("3");
    expect(candidate.totalMinutes).toBe(40);
  });

  it("produces exactly one recipe, never one per page", () => {
    const candidate = buildDocumentCandidate(pages, "job-1")!;
    expect(candidate.id).toBe("job-1");
    // The whole document is one candidate; there is no second id to select.
    expect(Array.isArray(candidate.pages)).toBe(true);
  });

  it("reads the two-page Marry Me Chicken Pasta export without merging its numbered steps", () => {
    const ingredients = [
      "1 pound chicken breast",
      "32 ounces reduced sodium chicken broth",
      "8 ounces sun dried tomatoes",
      "Italian seasoning, to taste",
      "Garlic powder, to taste",
      "Red pepper flakes, to taste",
      "Salt, to taste",
      "Pepper, to taste",
      "16 ounces heavy whipping cream",
      "16 ounces favorite pasta, uncooked",
      "1 cup shredded parmesan",
    ];
    const expectedSteps = [
      "Add the chicken breast to the crock pot.",
      "Pour in the reduced sodium chicken broth.",
      "Add the sun dried tomatoes.",
      "Season with Italian seasoning, garlic powder, red pepper flakes, salt, and pepper.",
      "Cook on high for about three hours.",
      "Shred the chicken once it is done.",
      "Add the heavy whipping cream.",
      "Add the uncooked pasta.",
      "Stir in the shredded parmesan cheese.",
      "Mix well and put the lid back on.",
      "Cook on high for one more hour.",
    ];
    const exportPages = [
      [
        "ReciMe",
        "Marry Me Chicken Pasta",
        "Servings: 2",
        "INGREDIENTS (11)",
        ...ingredients,
        "INSTRUCTIONS · 11",
        "1",
        expectedSteps[0],
        "2.",
        expectedSteps[1],
        "3",
        expectedSteps[2],
        "4.",
        expectedSteps[3],
        "5",
        expectedSteps[4],
        "Made with ReciMe",
        "Page 1 of 2",
      ].join("\n"),
      [
        "6",
        expectedSteps[5],
        "7.",
        expectedSteps[6],
        "8",
        expectedSteps[7],
        "9.",
        expectedSteps[8],
        "10",
        expectedSteps[9],
        "11.",
        expectedSteps[10],
        "https://recime.app/recipe/marry-me-chicken-pasta",
        "Page 2 of 2",
      ].join("\n"),
    ];

    const candidate = buildDocumentCandidate(exportPages, "marry-me")!;
    expect(candidate.title).toBe("Marry Me Chicken Pasta");
    expect(candidate.servings).toBe("2");
    expect(candidate.ingredients).toEqual(ingredients);
    expect(candidate.instructions.flatMap((group) => group.steps.map((step) => step.text))).toEqual(expectedSteps);
  });

  it("returns nothing when the document is not one recipe, so the page-by-page detector still gets a turn", () => {
    expect(buildDocumentCandidate(["A menu", "Starters, mains, puddings"], "job-2")).toBeNull();
    expect(buildDocumentCandidate(["Ingredients", "1 onion"], "job-3")).toBeNull();
  });
});
