import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const searchCatalog = vi.fn();

vi.mock("../server/lib/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/lib/source")>();
  return { ...actual, searchCatalog };
});

let dir: string;
let server: http.Server;
let baseUrl: string;
let storage: typeof import("../server/storage")["storage"];

function getJson(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${url}`, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dime-catalog-route-"));
  process.env.DIME_DINNER_DB = path.join(dir, "test.db");
  process.env.DIME_DINNER_OPTIONS = path.join(dir, "options.json");
  process.env.DIME_DINNER_TMP = dir;
  fs.writeFileSync(process.env.DIME_DINNER_OPTIONS, JSON.stringify({ kroger_enabled: false }));

  const { default: express } = await import("express");
  const { registerRoutes } = await import("../server/routes");
  storage = (await import("../server/storage")).storage;

  const app = express();
  app.use(express.json());
  server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  (await import("../server/lib/importJobs")).shutdownJobs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.DIME_DINNER_DB;
  delete process.env.DIME_DINNER_OPTIONS;
  delete process.env.DIME_DINNER_TMP;
});

beforeEach(() => {
  searchCatalog.mockReset();
  searchCatalog.mockResolvedValue({
    source: "live",
    hits: [
      {
        title: "Catalog Chicken",
        url: "https://ajgreats.com/catalog-chicken/",
        imageUrl: null,
        excerpt: "A result from the selected catalog.",
      },
    ],
  });
  for (const recipe of storage.listRecipes()) storage.deleteRecipe(recipe.id);
});

describe("GET /api/search catalog selection", () => {
  it.each(["eatingonadime", "ajgreats", "ketofocus"] as const)(
    "passes the %s source through to the catalog adapter",
    async (source) => {
      const response = await getJson(`/api/search?source=${source}&q=chicken&page=2`);

      expect(response.status).toBe(200);
      expect(searchCatalog).toHaveBeenCalledWith("chicken", 2, source);
      expect(response.body.results[0].title).toBe("Catalog Chicken");
    },
  );

  it("falls back to Eating on a Dime for an unknown source and clamps unsafe input", async () => {
    const response = await getJson("/api/search?source=attacker&q=%3Cb%3Echicken%3C%2Fb%3E&page=999");

    expect(response.status).toBe(200);
    expect(searchCatalog).toHaveBeenCalledWith("chicken", 10, "eatingonadime");
    expect(response.body.query).toBe("chicken");
  });

  it("marks a catalog result already stored under the same normalized URL", async () => {
    const saved = storage.upsertRecipe({
      sourceUrl: "https://ajgreats.com/catalog-chicken",
      title: "Catalog Chicken",
      description: null,
      imageUrl: null,
      author: null,
      prepMinutes: null,
      cookMinutes: null,
      totalMinutes: null,
      servings: null,
      categories: [],
      cuisines: [],
      ingredients: ["1 chicken breast"],
      instructions: [{ heading: null, steps: [{ text: "Cook the chicken." }] }],
      nutrition: null,
      siteName: "ajgreats.com",
    });

    const response = await getJson("/api/search?source=ajgreats&q=chicken");

    expect(response.status).toBe(200);
    expect(response.body.results[0].savedId).toBe(saved.id);
  });
});
