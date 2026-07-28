/**
 * The import job end to end, driven through the real HTTP routes.
 *
 * A generated fixture PDF is uploaded, polled to completion and then partly
 * imported, which is the whole user journey minus the browser. The two things
 * this is really here to protect are that a recipe can only ever be written
 * because the user explicitly selected it, and that the PDF itself does not
 * survive the job — so the temp root is redirected into the test directory and
 * inspected afterwards.
 *
 * The client speaks node:http rather than `fetch` so that the app under test
 * and the outbound calls it makes stay distinguishable.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeImagePdf, makeTextPdf } from "./fixtures/makePdf";
import { toolStatus } from "../server/lib/pdfTools";
import type { EbookImportJob, EbookSaveResult } from "@shared/schema";

/** Resolved before the suites register, so the OCR block can skip itself. */
const tools = await toolStatus();

let dir: string;
let tmpRoot: string;
let server: http.Server;
let baseUrl: string;
let shutdownJobs: typeof import("../server/lib/importJobs")["shutdownJobs"];
let storage: typeof import("../server/storage")["storage"];

type Reply<T = any> = { status: number; body: T };

function request<T = any>(
  method: string,
  url: string,
  payload?: unknown,
  options: { raw?: Buffer; contentType?: string } = {},
): Promise<Reply<T>> {
  const body = options.raw ?? (payload === undefined ? undefined : Buffer.from(JSON.stringify(payload)));
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${url}`,
      {
        method,
        headers: body
          ? { "Content-Type": options.contentType ?? "application/json", "Content-Length": body.byteLength }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          let parsed: any = raw.toString("utf-8");
          try {
            parsed = JSON.parse(parsed);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** A page with a heading pair and enough prose to be a real text layer. */
function recipePage(title: string, servings = "4 servings, 2 pancakes each"): string[] {
  return [
    "INGREDIENTS",
    "4 large eggs",
    "1/2 cup whole milk",
    "1 tablespoon salted butter",
    "1 teaspoon vanilla extract",
    "2 cups all purpose flour",
    "INSTRUCTIONS",
    "1. Combine all of the ingredients except the butter in a blender.",
    "2. Blend for twenty seconds until the batter is completely smooth.",
    "3. Let the batter rest for two minutes before you cook anything.",
    "4. Heat the butter in a nonstick skillet over a medium heat.",
    title,
    servings,
  ];
}

const CONTENTS_PAGE = [
  "CONTENTS",
  "Breakfast",
  "Squeaky Pancakes .............. 1",
  "Berry Bliss Bowl ................ 2",
  "Mains",
  "Salmon Chowder ............... 5",
  "A note before you begin: read the whole book first and plan your week.",
];

function book(): Buffer {
  return makeTextPdf([recipePage("Squeaky Pancakes"), recipePage("Berry Bliss Bowl"), CONTENTS_PAGE], {
    title: "Test Cookbook",
    author: "A Cook",
  });
}

async function upload(pdf: Buffer, filename = "cookbook.pdf"): Promise<EbookImportJob> {
  const res = await request<EbookImportJob>("POST", `/api/ebook/upload?filename=${encodeURIComponent(filename)}`, undefined, {
    raw: pdf,
    contentType: "application/pdf",
  });
  expect(res.status).toBe(200);
  return res.body;
}

/** Poll the job the way the dialog does, until it stops moving. */
async function settle(id: string, timeoutMs = 60_000): Promise<EbookImportJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request<EbookImportJob>("GET", `/api/ebook/${encodeURIComponent(id)}`);
    if (res.status !== 200) throw new Error(`job ${id} vanished: ${res.status}`);
    if (["ready", "failed", "cancelled"].includes(res.body.phase)) return res.body;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${res.body.phase}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function selectionFor(candidate: EbookImportJob["candidates"][number]) {
  return {
    id: candidate.id,
    title: candidate.title ?? "Untitled",
    ingredients: candidate.ingredients,
    instructions: candidate.instructions.map((group) => ({
      ...(group.heading ? { heading: group.heading } : {}),
      steps: group.steps.map((step) => ({ text: step.text })),
    })),
  };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dime-ebook-"));
  tmpRoot = path.join(dir, "tmp");
  fs.mkdirSync(tmpRoot);
  process.env.DIME_DINNER_DB = path.join(dir, "test.db");
  process.env.DIME_DINNER_OPTIONS = path.join(dir, "options.json");
  // Job directories land here, so the test can prove they were cleaned up.
  process.env.DIME_DINNER_TMP = tmpRoot;
  fs.writeFileSync(process.env.DIME_DINNER_OPTIONS, JSON.stringify({ kroger_enabled: false }));

  const { default: express } = await import("express");
  const { registerRoutes } = await import("../server/routes");
  shutdownJobs = (await import("../server/lib/importJobs")).shutdownJobs;
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
  shutdownJobs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.DIME_DINNER_DB;
  delete process.env.DIME_DINNER_OPTIONS;
  delete process.env.DIME_DINNER_TMP;
});

beforeEach(() => {
  shutdownJobs();
  for (const recipe of storage.listRecipes()) storage.deleteRecipe(recipe.id);
});

describe("starting an import", () => {
  it("answers immediately with a job rather than doing the work inline", async () => {
    const started = Date.now();
    const job = await upload(book());

    // The response is the receipt for work that has not happened yet.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(job.id).toBeTruthy();
    expect(job.phase).not.toBe("ready");
    expect(job.candidates).toEqual([]);
    expect(job.filename).toBe("cookbook.pdf");

    await settle(job.id);
  });

  it("sanitises the filename it was handed", async () => {
    const job = await upload(book(), "../../etc/passwd.pdf");
    expect(job.filename).toBe("passwd.pdf");
    await settle(job.id);
  });

  it("refuses a body that is not a PDF", async () => {
    const res = await request("POST", "/api/ebook/upload", undefined, {
      raw: Buffer.from("PK\x03\x04 this is a zip"),
      contentType: "application/pdf",
    });
    expect(res.status).toBe(415);
    expect(res.body.message).toMatch(/not a PDF/i);
  });

  it("refuses an empty upload", async () => {
    const res = await request("POST", "/api/ebook/upload", undefined, {
      raw: Buffer.alloc(0),
      contentType: "application/pdf",
    });
    expect(res.status).toBe(400);
  });

  it("refuses a URL that is not a public http(s) address", async () => {
    for (const url of ["http://192.168.1.5/book.pdf", "file:///etc/passwd", "http://homeassistant/book.pdf"]) {
      const res = await request<EbookImportJob>("POST", "/api/ebook/url", { url });
      // The job starts, then fails on the guard rather than reaching the host.
      if (res.status === 200) {
        const done = await settle(res.body.id);
        expect(done.phase, url).toBe("failed");
        expect(done.error, url).toBeTruthy();
      } else {
        expect(res.status, url).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it("reports what the add-on image can do", async () => {
    const res = await request("GET", "/api/ebook/tools");
    expect(res.status).toBe(200);
    expect(typeof res.body.ocrAvailable).toBe("boolean");
    expect(res.body.message).toBeTruthy();
  });
});

describe("reading a book", () => {
  it("finds every recipe and leaves the contents page out", async () => {
    const job = await settle((await upload(book())).id);

    expect(job.phase).toBe("ready");
    expect(job.pageCount).toBe(3);
    expect(job.title).toBe("Test Cookbook");
    expect(job.author).toBe("A Cook");
    // A real text layer means no OCR was needed.
    expect(job.usedOcr).toBe(false);
    expect(job.candidates.map((c) => c.title)).toEqual(["Squeaky Pancakes", "Berry Bliss Bowl"]);
    expect(job.skippedPages).toEqual([3]);
    expect(job.percent).toBe(100);
    expect(job.message).toMatch(/Found 2 recipes/);
  });

  it("carries each recipe's page, ingredients and steps into the review", async () => {
    const job = await settle((await upload(book())).id);
    const first = job.candidates[0];

    expect(first.pages).toEqual([1]);
    expect(first.ingredients).toContain("4 large eggs");
    expect(first.instructions[0].steps).toHaveLength(4);
    expect(first.instructions[0].steps[0].text).toMatch(/^Combine all of the ingredients/);
    expect(first.confidence).toBeGreaterThan(0.5);
  });

  it("fails with an explanation when there are no recipes in the file", async () => {
    const job = await settle((await upload(makeTextPdf([CONTENTS_PAGE, CONTENTS_PAGE]))).id);

    expect(job.phase).toBe("failed");
    expect(job.error).toMatch(/No recipes/i);
    expect(job.errorStatus).toBe(422);
  });

  it("refuses a book with too many pages", async () => {
    const pages = Array.from({ length: 61 }, () => ["Filler page with a little text on it."]);
    const job = await settle((await upload(makeTextPdf(pages))).id);

    expect(job.phase).toBe("failed");
    expect(job.errorStatus).toBe(413);
    expect(job.error).toMatch(/61 pages/);
  });

  it("reports a corrupt file as a failed job, not a crash", async () => {
    const job = await settle((await upload(Buffer.from("%PDF-1.4\nnot actually a pdf\n"))).id);
    expect(job.phase).toBe("failed");
    expect(job.error).toBeTruthy();
  });
});

describe("the job's footprint on disk", () => {
  it("deletes the PDF as soon as the job finishes", async () => {
    const job = await settle((await upload(book())).id);
    expect(job.phase).toBe("ready");

    // The candidates are still readable, but nothing of the book is left.
    expect(job.candidates.length).toBe(2);
    expect(fs.readdirSync(tmpRoot).filter((e) => e.startsWith("dime-dinner-import-"))).toEqual([]);
  });

  it("deletes the PDF when the job fails too", async () => {
    await settle((await upload(Buffer.from("%PDF-1.4\nbroken\n"))).id);
    expect(fs.readdirSync(tmpRoot).filter((e) => e.startsWith("dime-dinner-import-"))).toEqual([]);
  });

  it("takes everything with it when the job is cancelled", async () => {
    const job = await upload(book());

    expect((await request("DELETE", `/api/ebook/${job.id}`)).status).toBe(200);
    const cancelled = await settle(job.id);
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.candidates).toEqual([]);

    // Give the worker a moment to unwind, then check nothing is left.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fs.readdirSync(tmpRoot).filter((e) => e.startsWith("dime-dinner-import-"))).toEqual([]);
  });

  it("says a cancelled job cannot be cancelled twice", async () => {
    const job = await upload(book());
    await request("DELETE", `/api/ebook/${job.id}`);
    await settle(job.id);
    shutdownJobs();
    expect((await request("DELETE", `/api/ebook/${job.id}`)).status).toBe(404);
  });

  it("forgets a job entirely on shutdown", async () => {
    const job = await settle((await upload(book())).id);
    shutdownJobs();
    expect((await request("GET", `/api/ebook/${job.id}`)).status).toBe(404);
  });

  it("has nothing to say about an unknown job", async () => {
    expect((await request("GET", "/api/ebook/not-a-real-job")).status).toBe(404);
    expect((await request("GET", "/api/ebook/not-a-real-job/page/1.png")).status).toBe(404);
  });
});

/**
 * The reason this feature exists: a book whose pages are flattened images, with
 * no font objects for `pdftotext` to find. Nothing here is mocked — the page is
 * really rendered and really recognised, so the OCR fallback is proven rather
 * than assumed. Skipped where the binaries are absent; the add-on image has them.
 */
describe.skipIf(!tools.ocrAvailable)("a scanned book with no text layer", () => {
  const scanned = () =>
    makeImagePdf([
      [
        "INGREDIENTS",
        "4 LARGE EGGS",
        "1 CUP WHOLE MILK",
        "2 CUPS PLAIN FLOUR",
        "INSTRUCTIONS",
        "1. MIX THE FLOUR AND THE MILK.",
        "2. ADD THE EGGS AND STIR WELL.",
        "3. COOK FOR 10 MINUTES.",
        "SQUEAKY PANCAKES",
      ],
    ]);

  it("falls back to OCR and still finds the recipe", async () => {
    const job = await settle((await upload(scanned(), "scanned.pdf")).id, 180_000);

    expect(job.phase).toBe("ready");
    expect(job.usedOcr).toBe(true);
    // The user is told the text was recognised rather than read.
    expect(job.warnings.join(" ")).toMatch(/OCR/i);

    const recipe = job.candidates[0];
    expect(recipe.pages).toEqual([1]);
    expect(recipe.ingredients.length).toBeGreaterThanOrEqual(3);
    expect(recipe.instructions[0].steps.length).toBeGreaterThanOrEqual(2);
    expect(recipe.instructions[0].steps[0].text.toUpperCase()).toContain("FLOUR");
  }, 180_000);

  it("offers an ephemeral page preview that is never cached", async () => {
    const job = await settle((await upload(scanned(), "scanned.pdf")).id, 180_000);

    const png = await request("GET", `/api/ebook/${job.id}/page/1.png`);
    expect(png.status).toBe(200);
    expect(Buffer.isBuffer(png.body)).toBe(true);
    expect((png.body as Buffer).subarray(1, 4).toString("latin1")).toBe("PNG");

    // The preview dies with the job, so it must not be stored anywhere.
    shutdownJobs();
    expect((await request("GET", `/api/ebook/${job.id}/page/1.png`)).status).toBe(404);
  }, 180_000);

  it("still saves nothing the user did not select", async () => {
    const job = await settle((await upload(scanned(), "scanned.pdf")).id, 180_000);

    const refused = await request("POST", `/api/ebook/${job.id}/save`, {
      selections: [selectionFor(job.candidates[0])],
    });

    expect(refused.status).toBe(400);
    expect(storage.listRecipes()).toHaveLength(0);
  }, 180_000);
});

describe("saving only what the user picked", () => {
  it("refuses to write anything without the explicit confirmation", async () => {
    const job = await settle((await upload(book())).id);
    const selections = [selectionFor(job.candidates[0])];

    for (const payload of [
      { selections },
      { confirm: false, selections },
      { confirm: "yes", selections },
      { confirm: true },
      { confirm: true, selections: [] },
    ]) {
      const res = await request("POST", `/api/ebook/${job.id}/save`, payload);
      expect(res.status, JSON.stringify(payload).slice(0, 60)).toBe(400);
    }
    expect(storage.listRecipes()).toHaveLength(0);
  });

  it("saves the one recipe that was selected and not the other", async () => {
    const job = await settle((await upload(book())).id);

    const res = await request<EbookSaveResult>("POST", `/api/ebook/${job.id}/save`, {
      confirm: true,
      selections: [selectionFor(job.candidates[0])],
    });

    expect(res.status).toBe(200);
    expect(res.body.saved).toHaveLength(1);
    expect(res.body.saved[0].title).toBe("Squeaky Pancakes");

    const library = storage.listRecipes();
    expect(library).toHaveLength(1);
    expect(library.map((r) => r.title)).not.toContain("Berry Bliss Bowl");
  });

  it("keeps the user's corrections rather than the OCR text", async () => {
    const job = await settle((await upload(book())).id);
    const edited = {
      ...selectionFor(job.candidates[0]),
      title: "Squeaky Pancakes (fixed)",
      ingredients: ["4 large eggs", "1 tablespoon psyllium husk powder"],
      instructions: [{ steps: [{ text: "Blend everything and cook it." }] }],
      servings: "3 servings",
      totalMinutes: 18,
    };

    const res = await request<EbookSaveResult>("POST", `/api/ebook/${job.id}/save`, {
      confirm: true,
      selections: [edited],
    });

    const saved = res.body.saved[0];
    expect(saved.title).toBe("Squeaky Pancakes (fixed)");
    expect(saved.ingredients).toEqual(["4 large eggs", "1 tablespoon psyllium husk powder"]);
    expect(saved.instructions[0].steps[0].text).toBe("Blend everything and cook it.");
    expect(saved.servings).toBe("3 servings");
    expect(saved.totalMinutes).toBe(18);
  });

  it("attributes the book and copies none of its artwork", async () => {
    const job = await settle((await upload(book())).id);

    const res = await request<EbookSaveResult>("POST", `/api/ebook/${job.id}/save`, {
      confirm: true,
      selections: job.candidates.map(selectionFor),
    });

    for (const saved of res.body.saved) {
      expect(saved.siteName).toBe("Test Cookbook");
      expect(saved.author).toBe("A Cook");
      // A page of the book is the publisher's artwork; nothing is lifted from it.
      expect(saved.imageUrl).toBeNull();
      expect(saved.sourceUrl).toMatch(/^dime-dinner:ebook\/cookbook\.pdf#page=\d+$/);
    }
    // Each recipe keeps its own page, so the two do not collide.
    expect(new Set(res.body.saved.map((r) => r.sourceUrl)).size).toBe(2);
  });

  it("re-importing the same recipe updates it instead of duplicating it", async () => {
    const job = await settle((await upload(book())).id);
    const selection = selectionFor(job.candidates[0]);

    await request("POST", `/api/ebook/${job.id}/save`, { confirm: true, selections: [selection] });
    const second = await request<EbookSaveResult>("POST", `/api/ebook/${job.id}/save`, {
      confirm: true,
      selections: [{ ...selection, title: "Squeaky Pancakes v2" }],
    });

    expect(second.status).toBe(200);
    const library = storage.listRecipes();
    expect(library).toHaveLength(1);
    expect(library[0].title).toBe("Squeaky Pancakes v2");
  });

  it("skips a selection that is not part of this import", async () => {
    const job = await settle((await upload(book())).id);

    const res = await request<EbookSaveResult>("POST", `/api/ebook/${job.id}/save`, {
      confirm: true,
      selections: [
        selectionFor(job.candidates[0]),
        { ...selectionFor(job.candidates[1]), id: "made-up-id" },
      ],
    });

    expect(res.body.saved).toHaveLength(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].reason).toMatch(/No longer part of this import/i);
    expect(storage.listRecipes()).toHaveLength(1);
  });

  it("will not save from a job that has not finished or no longer exists", async () => {
    const running = await upload(book());
    const early = await request("POST", `/api/ebook/${running.id}/save`, {
      confirm: true,
      selections: [{ id: "x", title: "T", ingredients: ["a"], instructions: [{ steps: [{ text: "b" }] }] }],
    });
    expect([409, 410]).toContain(early.status);
    await settle(running.id);

    shutdownJobs();
    const gone = await request("POST", `/api/ebook/${running.id}/save`, {
      confirm: true,
      selections: [{ id: "x", title: "T", ingredients: ["a"], instructions: [{ steps: [{ text: "b" }] }] }],
    });
    expect(gone.status).toBe(410);
    expect(storage.listRecipes()).toHaveLength(0);
  });

  it("rejects a selection with an empty title, no ingredients or no steps", async () => {
    const job = await settle((await upload(book())).id);
    const base = selectionFor(job.candidates[0]);

    for (const broken of [
      { ...base, title: "" },
      { ...base, ingredients: [] },
      { ...base, instructions: [] },
      { ...base, instructions: [{ steps: [] }] },
    ]) {
      const res = await request("POST", `/api/ebook/${job.id}/save`, { confirm: true, selections: [broken] });
      expect(res.status).toBe(400);
    }
    expect(storage.listRecipes()).toHaveLength(0);
  });
});
