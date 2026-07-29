/**
 * Sending a recipe from Dime Dinner to ReciMe.
 *
 * ReciMe has no import API, so an export is only ever a file or a block of
 * text the user hands over themselves. That makes two things worth protecting
 * above all else. The format must be deterministic — one ingredient per line,
 * one numbered instruction per line — because that is what ReciMe reads back
 * correctly, and a drift between the clipboard and the PDF would be invisible
 * until someone's recipe imported wrong. And nothing private may ride along:
 * no ingress URL, no session token, nothing about the plan, the grocery list
 * or the pantry.
 *
 * The PDF is inspected as bytes rather than trusted. It is a small, fully
 * hand-written PDF 1.4 file, so its text, its metadata and its link annotation
 * can all be read straight back out of the buffer.
 */
import { describe, expect, it } from "vitest";
import {
  attributionLine,
  exportLine,
  formatDuration,
  formatRecipeForRecime,
  numberedInstructions,
  recimeFilename,
  RECIME_DISCLAIMER,
  sanitizeSourceUrl,
  type RecimeExportRecipe,
} from "@shared/recime";
import { buildRecimePdf } from "../server/lib/recimePdf";

const RECIPE: RecimeExportRecipe = {
  title: "Crockpot Chicken and Noodles",
  servings: "6 servings",
  prepMinutes: 10,
  cookMinutes: 240,
  totalMinutes: 250,
  description: "Leftovers keep for three days and reheat with a splash of stock.",
  author: "Carrie Barnard",
  siteName: "eatingonadime.com",
  sourceUrl: "https://www.eatingonadime.com/crockpot-chicken-and-noodles/",
  ingredients: ["2 lbs boneless skinless chicken breasts", "⅓ cup salted butter", "24 oz frozen egg noodles"],
  instructions: [
    { heading: "Prep", steps: [{ text: "Place the chicken in the crock pot." }] },
    {
      heading: "Cook",
      steps: [{ text: "Cook on low for 4 hours." }, { text: "Shred the chicken and stir the noodles through." }],
    },
  ],
};

/** The bytes of the PDF as latin1, which is how its text and metadata are stored. */
function pdfText(pdf: Buffer): string {
  return pdf.toString("latin1");
}

/* ------------------------------ the text form ----------------------------- */

describe("copying a recipe for ReciMe", () => {
  it("produces the same bytes every time", () => {
    expect(formatRecipeForRecime(RECIPE)).toBe(formatRecipeForRecime(structuredClone(RECIPE)));
  });

  it("lays the recipe out the way ReciMe reads it", () => {
    expect(formatRecipeForRecime(RECIPE)).toBe(
      [
        "Crockpot Chicken and Noodles",
        "",
        "Servings: 6 servings",
        "Prep time: 10 minutes",
        "Cook time: 4 hours",
        "Total time: 4 hours 10 minutes",
        "",
        "Ingredients",
        "2 lbs boneless skinless chicken breasts",
        "⅓ cup salted butter",
        "24 oz frozen egg noodles",
        "",
        "Instructions",
        "1. Prep: Place the chicken in the crock pot.",
        "2. Cook: Cook on low for 4 hours.",
        "3. Shred the chicken and stir the noodles through.",
        "",
        "Notes",
        "Leftovers keep for three days and reheat with a splash of stock.",
        "",
        "Source: Carrie Barnard · eatingonadime.com",
        "https://www.eatingonadime.com/crockpot-chicken-and-noodles/",
      ].join("\n"),
    );
  });

  it("gives every ingredient a line of its own, and only one", () => {
    const text = formatRecipeForRecime({
      ...RECIPE,
      ingredients: ["1 cup\nflour", "  2  tsp   salt  ", "", "3 eggs"],
    });
    const block = text.split("\n\n").find((b) => b.startsWith("Ingredients"))!.split("\n").slice(1);

    // A newline inside a source ingredient must not become a second ingredient,
    // and a blank one must not become a blank line ReciMe reads as a separator.
    expect(block).toEqual(["1 cup flour", "2 tsp salt", "3 eggs"]);
  });

  it("numbers instructions continuously across groups, one per line", () => {
    expect(
      numberedInstructions([
        { heading: "Sauce", steps: [{ text: "Simmer the tomatoes." }, { text: "Season." }] },
        { steps: [{ text: "Boil the pasta." }] },
        { heading: "Finish", steps: [{ text: "Toss together." }] },
      ]),
    ).toEqual(["1. Sauce: Simmer the tomatoes.", "2. Season.", "3. Boil the pasta.", "4. Finish: Toss together."]);
  });

  it("leaves out every section the recipe does not have", () => {
    const bare: RecimeExportRecipe = {
      title: "Toast",
      ingredients: ["2 slices bread"],
      instructions: [{ steps: [{ text: "Toast the bread." }] }],
    };
    expect(formatRecipeForRecime(bare)).toBe("Toast\n\nIngredients\n2 slices bread\n\nInstructions\n1. Toast the bread.");
  });

  it("spells durations out and ignores ones that are not real", () => {
    expect(formatDuration(90)).toBe("1 hour 30 minutes");
    expect(formatDuration(60)).toBe("1 hour");
    expect(formatDuration(1)).toBe("1 minute");
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });

  it("credits the author and the site, and neither when there is neither", () => {
    expect(attributionLine(RECIPE)).toBe("Carrie Barnard · eatingonadime.com");
    expect(attributionLine({ ...RECIPE, author: null })).toBe("eatingonadime.com");
    expect(attributionLine({ ...RECIPE, author: null, siteName: null })).toBeNull();
  });

  it("flattens anything that would break the line-per-item contract", () => {
    expect(exportLine("a\nb\tc")).toBe("a b c");
    expect(exportLine("  spaced   out  ")).toBe("spaced out");
    expect(exportLine("bellhere")).toBe("bell here");
    expect(exportLine(null)).toBe("");
  });
});

/* ------------------------------ what stays in ----------------------------- */

describe("keeping private things out of an export", () => {
  it("strips session parameters from the source URL", () => {
    expect(sanitizeSourceUrl("https://example.com/r?token=abc123&utm_source=x&sig=deadbeef")).toBe(
      "https://example.com/r?utm_source=x",
    );
    expect(sanitizeSourceUrl("https://example.com/r?ACCESS_TOKEN=abc")).toBe("https://example.com/r");
  });

  it("refuses a Home Assistant ingress link outright", () => {
    expect(sanitizeSourceUrl("http://homeassistant.local:8123/api/hassio_ingress/A1b2C3/recipes/4")).toBeNull();
    expect(sanitizeSourceUrl("https://example.com/api/hassio_ingress/tok/x")).toBeNull();
  });

  it("refuses anything that only exists on this network", () => {
    for (const url of [
      "http://localhost:8099/recipes/4",
      "http://127.0.0.1/r",
      "http://192.168.1.40:8123/r",
      "http://10.0.0.5/r",
      "http://172.20.0.3/r",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/r",
      "http://supervisor/core/api",
      "http://nas.local/r",
    ]) {
      expect(sanitizeSourceUrl(url), url).toBeNull();
    }
  });

  it("refuses credentials, non-http schemes and the ebook pseudo-URL", () => {
    expect(sanitizeSourceUrl("https://user:pw@example.com/r")).toBeNull();
    expect(sanitizeSourceUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeSourceUrl("file:///etc/passwd")).toBeNull();
    expect(sanitizeSourceUrl("dime-dinner:ebook/cookbook.pdf#page=12")).toBeNull();
    expect(sanitizeSourceUrl(null)).toBeNull();
  });

  it("keeps an unsafe URL out of the copied text and the PDF alike", () => {
    const leaky = { ...RECIPE, sourceUrl: "https://example.com/r?token=SECRET" };

    const text = formatRecipeForRecime(leaky);
    expect(text).not.toContain("SECRET");
    expect(text).toContain("https://example.com/r");

    const pdf = pdfText(buildRecimePdf(leaky, { now: new Date(0) }));
    expect(pdf).not.toContain("SECRET");
  });
});

/* --------------------------------- the PDF -------------------------------- */

describe("exporting one recipe as a PDF", () => {
  const pdf = buildRecimePdf(RECIPE, { now: new Date(Date.UTC(2026, 6, 29, 12, 0, 0)) });
  const raw = pdfText(pdf);

  it("is a PDF, generated here, with no page but its own", () => {
    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(raw).toContain("/Type /Pages /Count 1");
  });

  it("carries the whole recipe", () => {
    expect(raw).toContain("(Crockpot Chicken and Noodles) Tj");
    expect(raw).toContain("(Ingredients) Tj");
    expect(raw).toContain("(Instructions) Tj");
    expect(raw).toContain("(Notes) Tj");
    expect(raw).toContain("(24 oz frozen egg noodles) Tj");
    expect(raw).toContain("1. Prep: Place the chicken in the crock pot.");
    expect(raw).toContain("Servings: 6 servings");
  });

  it("spells out a fraction the PDF encoding cannot represent", () => {
    // A blank box in place of ⅓ would make the export look broken.
    expect(raw).toContain("1/3 cup salted butter");
    expect(raw).not.toContain("⅓");
  });

  it("names itself as a user export from this app, not as a ReciMe document", () => {
    expect(raw).toContain("/Title (Crockpot Chicken and Noodles)");
    expect(raw).toContain("/Author (Carrie Barnard)");
    expect(raw).toContain("/Creator (Dime Dinner)");
    expect(raw).toContain("/Producer (Dime Dinner recipe export)");
    expect(raw).toContain("/Subject (Recipe exported for ReciMe import)");
    expect(raw).toContain("/CreationDate (D:20260729120000Z)");
  });

  it("credits the site when the recipe has no author of its own", () => {
    const anon = pdfText(buildRecimePdf({ ...RECIPE, author: null }, { now: new Date(0) }));
    expect(anon).toContain("/Author (eatingonadime.com)");

    const orphan = pdfText(buildRecimePdf({ ...RECIPE, author: null, siteName: null }, { now: new Date(0) }));
    expect(orphan).toContain("/Author (Dime Dinner user export)");
  });

  it("makes the original source clickable", () => {
    expect(raw).toContain("/Subtype /Link");
    expect(raw).toContain("/URI (https://www.eatingonadime.com/crockpot-chicken-and-noodles/)");
  });

  it("says on the page that this is a bridge and not an integration", () => {
    expect(raw).toMatch(/not an official ReciMe integration/);
    // The sentence wraps, so the second half lands on a line of its own.
    expect(raw).toMatch(/syncs automatically/);
    // The same promise the UI makes.
    expect(RECIME_DISCLAIMER).toMatch(/not an official ReciMe integration/);
  });

  it("says nothing about the plan, the grocery list or the pantry", () => {
    for (const word of ["grocery", "pantry", "Kroger", "week_start", "weekStart", "clientSecret"]) {
      expect(raw.toLowerCase(), word).not.toContain(word.toLowerCase());
    }
  });

  it("holds one recipe and one recipe only", () => {
    const other = buildRecimePdf({ ...RECIPE, title: "Sheet Pan Gnocchi" }, { now: new Date(0) });
    expect(pdfText(other)).not.toContain("Crockpot Chicken and Noodles");
    // Each call produces its own document; there is no way to append a second.
    expect(pdfText(other)).toContain("/Type /Pages /Count 1");
  });

  it("is byte-identical for the same recipe at the same instant", () => {
    const a = buildRecimePdf(RECIPE, { now: new Date(0) });
    const b = buildRecimePdf(structuredClone(RECIPE), { now: new Date(0) });
    expect(a.equals(b)).toBe(true);
  });

  it("runs onto a second page rather than dropping a long method", () => {
    const long: RecimeExportRecipe = {
      ...RECIPE,
      instructions: [
        {
          steps: Array.from({ length: 60 }, (_, i) => ({
            text: `Step ${i + 1}: stir the pot slowly and keep an eye on the heat the whole time.`,
          })),
        },
      ],
    };
    const many = pdfText(buildRecimePdf(long, { now: new Date(0) }));
    expect(Number(many.match(/\/Type \/Pages \/Count (\d+)/)![1])).toBeGreaterThan(1);
    expect(many).toContain("60. Step 60:");
  });

  it("still produces a readable document from a recipe that is barely there", () => {
    const bare = buildRecimePdf(
      { title: "", ingredients: [], instructions: [] },
      { now: new Date(0) },
    );
    expect(pdfText(bare)).toContain("(Untitled recipe) Tj");
    expect(pdfText(bare)).toContain("/Type /Pages /Count 1");
  });
});

describe("naming the exported file", () => {
  it("is descriptive, safe and marked as a ReciMe export", () => {
    expect(recimeFilename("Crockpot Chicken and Noodles")).toBe("crockpot-chicken-and-noodles-recime.pdf");
    expect(recimeFilename("Mum's 100% Best  Chilli!")).toBe("mum-s-100-best-chilli-recime.pdf");
    expect(recimeFilename("../../etc/passwd")).toBe("etc-passwd-recime.pdf");
    expect(recimeFilename("你好")).toBe("recipe-recime.pdf");
    expect(recimeFilename("Toast", "txt")).toBe("toast-recime.txt");
  });

  it("does not run away with a very long title", () => {
    const name = recimeFilename("a".repeat(500));
    expect(name.length).toBeLessThan(80);
  });
});
