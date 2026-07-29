/**
 * The export route, driven over real HTTP.
 *
 * The browser never builds the PDF itself — it follows a link — so the route is
 * where the promises of this feature are actually kept: one recipe per file,
 * generated inside the add-on with no outbound call, named after the recipe it
 * contains, and never cached by anything between here and the user. Those are
 * checked on the wire rather than on the return value of the generator.
 *
 * `?image=0` is used throughout so nothing tries to fetch a cover photo; the
 * image path has its own SSRF guard and is not what this suite is about.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NewRecipeInput } from "../server/storage";

let dir: string;
let server: http.Server;
let baseUrl: string;
let storage: typeof import("../server/storage")["storage"];

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

function get(url: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${url}`, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

const RECIPE: NewRecipeInput = {
  sourceUrl: "https://www.eatingonadime.com/crockpot-chicken-and-noodles/",
  title: "Crockpot Chicken and Noodles",
  description: "Leftovers keep for three days.",
  imageUrl: null,
  author: "Carrie Barnard",
  prepMinutes: 10,
  cookMinutes: 240,
  totalMinutes: 250,
  servings: "6 servings",
  categories: ["Dinner"],
  cuisines: ["American"],
  ingredients: ["2 lbs boneless skinless chicken breasts", "24 oz frozen egg noodles"],
  instructions: [{ heading: null, steps: [{ text: "Cook on low for 4 hours." }] }],
  nutrition: null,
  siteName: "eatingonadime.com",
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dime-recime-"));
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
  for (const recipe of storage.listRecipes()) storage.deleteRecipe(recipe.id);
});

describe("downloading a recipe as a ReciMe PDF", () => {
  it("serves a PDF the browser will save under the recipe's own name", async () => {
    const saved = storage.upsertRecipe(RECIPE);

    const res = await get(`/api/recipes/${saved.id}/recime.pdf?image=0`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="crockpot-chicken-and-noodles-recime.pdf"',
    );
    expect(Number(res.headers["content-length"])).toBe(res.body.length);
    // A recipe can be edited, and a stale copy handed to ReciMe would be wrong.
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
  });

  it("puts that one recipe in the file and no other", async () => {
    const mine = storage.upsertRecipe(RECIPE);
    storage.upsertRecipe({ ...RECIPE, sourceUrl: "https://example.com/gnocchi", title: "Sheet Pan Gnocchi" });

    const raw = (await get(`/api/recipes/${mine.id}/recime.pdf?image=0`)).body.toString("latin1");

    expect(raw).toContain("(Crockpot Chicken and Noodles) Tj");
    expect(raw).not.toContain("Sheet Pan Gnocchi");
    expect(raw).toContain("/Type /Pages /Count 1");
  });

  it("answers 404 for a recipe that is not there", async () => {
    const res = await get("/api/recipes/999999/recime.pdf?image=0");
    expect(res.status).toBe(404);
  });
});
