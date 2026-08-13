import { afterEach, describe, expect, it, vi } from "vitest";
import { searchCatalog } from "../server/lib/source";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publisher recipe catalogs", () => {
  it("searches AJ Greats through its WordPress catalog", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            id: 42,
            link: "https://ajgreats.com/recipes/air-fryer-chicken/",
            title: { rendered: "Air Fryer Chicken" },
            excerpt: { rendered: "<p>Crisp chicken for dinner.</p>" },
            yoast_head_json: { og_image: [{ url: "https://ajgreats.com/chicken.jpg" }] },
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await searchCatalog("catalog-aj-unique", 1, "ajgreats");

    expect(result.source).toBe("live");
    expect(result.hits).toEqual([
      {
        title: "Air Fryer Chicken",
        url: "https://ajgreats.com/recipes/air-fryer-chicken/",
        imageUrl: "https://ajgreats.com/chicken.jpg",
        excerpt: "Crisp chicken for dinner.",
      },
    ]);
    expect(String(fetch.mock.calls[0][0])).toContain("ajgreats.com/wp-json/wp/v2/posts");
  });

  it("searches KetoFocus through its recipe endpoint", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          recipes: [
            {
              title: "Keto Chicken Skillet",
              url: "https://www.ketofocus.com/recipes/keto-chicken-skillet/",
              thumb: "/images/chicken.jpg",
              time: 25,
              carbs: 4,
              courses: ["Dinner"],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await searchCatalog("catalog-keto-unique", 1, "ketofocus");

    expect(result.source).toBe("live");
    expect(result.hits).toEqual([
      {
        title: "Keto Chicken Skillet",
        url: "https://www.ketofocus.com/recipes/keto-chicken-skillet/",
        imageUrl: "https://www.ketofocus.com/images/chicken.jpg",
        excerpt: "25 min · 4g net carbs · Dinner",
      },
    ]);
    expect(String(fetch.mock.calls[0][0])).toContain("ketofocus.com/wp-json/kf/v1/recipes");
  });
});
