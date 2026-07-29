/**
 * Choosing how a recipe leaves the browser.
 *
 * The share sheet is the one part of this feature that cannot be relied on.
 * Inside the Home Assistant iOS app it can hand a PDF straight to ReciMe; in a
 * desktop browser it usually does not exist; in some WebViews `navigator.share`
 * is present but refuses files, and a `share()` call with a payload the device
 * will not take rejects only *after* the user has tapped the button. So what is
 * tested here is the decision, not the sheet: what each environment is offered,
 * and that every path a user can take still ends with the recipe in their hands.
 *
 * Two outcomes matter more than the rest. Dismissing the share sheet is not an
 * error and must not download anything. And when nothing can be shared at all,
 * the copy-and-download fallback has to actually run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchRecimePdf,
  recimePdfUrl,
  shareCapability,
  shareToRecime,
  type ShareOutcome,
} from "../client/src/lib/recimeShare";
import type { RecimeExportRecipe } from "@shared/recime";

const RECIPE: RecimeExportRecipe & { id: number } = {
  id: 7,
  title: "Sheet Pan Gnocchi",
  servings: "4 servings",
  ingredients: ["500 g gnocchi", "2 tbsp olive oil"],
  instructions: [{ steps: [{ text: "Roast for 25 minutes." }] }],
};

const PDF = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "probe.pdf", { type: "application/pdf" });

/** A navigator with only the capabilities named. */
function nav(options: { share?: boolean; files?: boolean; onShare?: (data: ShareData) => Promise<void> }) {
  if (!options.share) return {};
  return {
    share: options.onShare ?? (async () => {}),
    canShare: (data: ShareData) => (data.files?.length ? options.files === true : true),
  };
}

/**
 * A document just real enough for the fallback: the download builds an anchor
 * and clicks it, and the clipboard fallback builds a textarea and selects it.
 */
function stubDocument() {
  const clicked: string[] = [];
  const doc = {
    createElement: (tag: string) => ({
      tagName: tag,
      style: {} as Record<string, string>,
      set href(value: string) {
        clicked.push(value);
      },
      select: () => {},
      click() {},
      value: "",
      rel: "",
    }),
    body: { appendChild: () => {}, removeChild: () => {} },
    execCommand: () => true,
  };
  vi.stubGlobal("document", doc);
  return clicked;
}

function abortError(): Error {
  const err = new Error("Share canceled");
  err.name = "AbortError";
  return err;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------- what this browser can do ------------------------ */

describe("measuring what the browser can share", () => {
  it("offers file sharing only when the device accepts a file", () => {
    expect(shareCapability(nav({ share: true, files: true }), PDF)).toBe("files");
    expect(shareCapability(nav({ share: true, files: false }), PDF)).toBe("text");
  });

  it("falls to text when there is nothing to probe with", () => {
    // Some WebViews expose share() and no File constructor at all.
    expect(shareCapability(nav({ share: true, files: true }), undefined)).toBe("text");
  });

  it("reports nothing at all on a desktop browser with no share sheet", () => {
    expect(shareCapability({}, PDF)).toBe("none");
    expect(shareCapability(undefined, PDF)).toBe("none");
    // canShare without share is not a share sheet.
    expect(shareCapability({ canShare: () => true }, PDF)).toBe("none");
  });
});

/* ------------------------------- sharing ---------------------------------- */

describe("handing the recipe to the share sheet", () => {
  it("sends the PDF when the device takes files", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF, { status: 200 })));
    const share = vi.fn(async () => {});

    const outcome = await shareToRecime(RECIPE, nav({ share: true, files: true, onShare: share }));

    expect(outcome).toEqual<ShareOutcome>({ kind: "shared", withFile: true });
    const payload = share.mock.calls[0][0] as ShareData;
    expect(payload.files?.[0].name).toBe("sheet-pan-gnocchi-recime.pdf");
    expect(payload.files?.[0].type).toBe("application/pdf");
    // The text rides along, so a target app that ignores files still gets the recipe.
    expect(payload.text).toContain("Ingredients");
  });

  it("sends text alone when the device refuses files", async () => {
    const share = vi.fn(async () => {});

    const outcome = await shareToRecime(RECIPE, nav({ share: true, files: false, onShare: share }));

    expect(outcome).toEqual<ShareOutcome>({ kind: "shared", withFile: false });
    expect((share.mock.calls[0][0] as ShareData).files).toBeUndefined();
  });

  it("still shares the text when building the PDF fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const share = vi.fn(async () => {});

    const outcome = await shareToRecime(RECIPE, nav({ share: true, files: true, onShare: share }));

    expect(outcome).toEqual<ShareOutcome>({ kind: "shared", withFile: false });
  });
});

/* ------------------------------- backing out ------------------------------- */

describe("a user who changes their mind", () => {
  it("is not shown an error and is not sent a download", async () => {
    const clicked = stubDocument();
    const outcome = await shareToRecime(
      RECIPE,
      nav({
        share: true,
        files: false,
        onShare: async () => {
          throw abortError();
        },
      }),
    );

    expect(outcome).toEqual<ShareOutcome>({ kind: "cancelled" });
    expect(clicked).toEqual([]);
  });

  it("is respected even when they dismiss the sheet that was carrying the PDF", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF, { status: 200 })));
    const clicked = stubDocument();

    const outcome = await shareToRecime(
      RECIPE,
      nav({
        share: true,
        files: true,
        onShare: async () => {
          throw abortError();
        },
      }),
    );

    expect(outcome).toEqual<ShareOutcome>({ kind: "cancelled" });
    expect(clicked).toEqual([]);
  });
});

/* ------------------------------ the fallback ------------------------------- */

describe("a browser that cannot share at all", () => {
  it("copies the text and downloads the PDF instead", async () => {
    const clicked = stubDocument();

    const outcome = await shareToRecime(RECIPE, {});

    expect(outcome).toEqual<ShareOutcome>({ kind: "fellBack", copied: true });
    expect(clicked).toEqual([recimePdfUrl(RECIPE.id)]);
  });

  it("still downloads the PDF when the clipboard is blocked too", async () => {
    const clicked = stubDocument();
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("denied"); } } });
    // execCommand is the last resort, and it can refuse as well.
    (globalThis as { document: { execCommand: () => boolean } }).document.execCommand = () => false;

    const outcome = await shareToRecime(RECIPE, {});

    expect(outcome).toEqual<ShareOutcome>({ kind: "fellBack", copied: false });
    expect(clicked).toEqual([recimePdfUrl(RECIPE.id)]);
  });
});

/* -------------------------------- the URL --------------------------------- */

describe("asking the server for the PDF", () => {
  it("asks for one recipe by id, on a path ingress can rewrite", () => {
    expect(recimePdfUrl(7)).toMatch(/\/api\/recipes\/7\/recime\.pdf$/);
  });

  it("names the downloaded file after the recipe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF, { status: 200 })));
    const file = await fetchRecimePdf(7, "Mum's Best Chilli");
    expect(file.name).toBe("mum-s-best-chilli-recime.pdf");
  });

  it("says so plainly when the server will not produce one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(fetchRecimePdf(7, "Toast")).rejects.toThrow(/HTTP 404/);
  });
});
