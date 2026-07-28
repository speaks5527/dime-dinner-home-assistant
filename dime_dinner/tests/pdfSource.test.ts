/**
 * Turning a pasted link into one PDF, and refusing to be led somewhere private.
 *
 * The rewriting and link-ranking functions are pure, so they are called
 * directly. Everything that reaches the network goes through a stubbed `fetch`
 * and a public IP literal as the host: `assertPublicHost` short-circuits for
 * literals, so these tests never touch DNS and never leave the machine, while
 * still exercising the real redirect and content-type handling.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { downloadPdf, findPdfLinks, resolvePdfSource, rewriteDropbox, rewriteGoogleDrive } from "../server/lib/pdfSource";
import { FetchRejected } from "../server/lib/safeFetch";
import { MAX_PDF_BYTES } from "../server/lib/pdfTools";
import { makeTextPdf } from "./fixtures/makePdf";

/** A routable public address, so the SSRF guard passes without a DNS lookup. */
const HOST = "93.184.216.34";
const DROPBOX_SHARE =
  "https://www.dropbox.com/scl/fi/x1iyxr7ftotrl2yv3255s/2023-Squeaky-Clean-Keto-Challenge-small.pdf?rlkey=6kur4gpf02ua1czysu0sk1v8w&st=knxukog8&dl=0";

let dir: string;

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to } });
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dime-pdfsource-"));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rewriting a share link", () => {
  it("turns the user's Dropbox preview link into a direct download", () => {
    const rewritten = rewriteDropbox(new URL(DROPBOX_SHARE))!;
    const url = rewritten.url;

    expect(url.searchParams.get("dl")).toBe("1");
    // The rlkey is what keeps the link working; `st` is a signature that goes
    // stale within minutes, so it must not be carried over.
    expect(url.searchParams.get("rlkey")).toBe("6kur4gpf02ua1czysu0sk1v8w");
    expect(url.searchParams.get("st")).toBeNull();
    expect(url.hostname).toBe("www.dropbox.com");
    expect(rewritten.note).toMatch(/dl=1/);
  });

  it("rewrites a link that already says dl=0 or dl=1 the same way", () => {
    for (const raw of [
      "https://www.dropbox.com/scl/fi/abc/book.pdf?rlkey=k&dl=0",
      "https://www.dropbox.com/scl/fi/abc/book.pdf?rlkey=k&dl=1",
      "https://dropbox.com/s/abc/book.pdf",
    ]) {
      expect(rewriteDropbox(new URL(raw))!.url.searchParams.get("dl"), raw).toBe("1");
    }
  });

  it("explains that a folder link is not a file", () => {
    expect(() => rewriteDropbox(new URL("https://www.dropbox.com/scl/fo/xyz/folder?rlkey=k&dl=0"))).toThrow(
      /folder link/i,
    );
  });

  it("leaves other hosts alone", () => {
    expect(rewriteDropbox(new URL("https://example.com/book.pdf"))).toBeNull();
    expect(rewriteGoogleDrive(new URL("https://example.com/book.pdf"))).toBeNull();
  });

  it("turns a Google Drive viewer link into its download endpoint", () => {
    const rewritten = rewriteGoogleDrive(new URL("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing"))!;
    expect(rewritten.url.searchParams.get("id")).toBe("1AbCdEfGhIjKlMnOp");
    expect(rewritten.url.searchParams.get("export")).toBe("download");
  });
});

describe("finding the download link on a landing page", () => {
  const page = `
    <a href="/privacy-policy.pdf">Privacy Policy</a>
    <a href="/wp-content/uploads/2023/squeaky-clean-keto-challenge.pdf">Download the free ebook (PDF)</a>
    <a href="/about">About me</a>
    <a href="mailto:hi@example.com">Email</a>
    <a href="/terms.pdf">Terms &amp; Conditions</a>
  `;

  it("picks the ebook over the boilerplate PDFs", () => {
    const links = findPdfLinks(page, "https://www.example.com/free-ebook/");
    expect(links[0].href).toBe("https://www.example.com/wp-content/uploads/2023/squeaky-clean-keto-challenge.pdf");
    expect(links[0].text).toMatch(/Download the free ebook/);
    // Terms and privacy are found but ranked below, never chosen.
    expect(links.map((l) => l.href)).toContain("https://www.example.com/privacy-policy.pdf");
    expect(links[0].score).toBeGreaterThan(links[links.length - 1].score);
  });

  it("ignores links that cannot be a PDF at all", () => {
    const links = findPdfLinks(page, "https://www.example.com/free-ebook/");
    expect(links.map((l) => l.href)).not.toContain("https://www.example.com/about");
    expect(links.some((l) => l.href.startsWith("mailto:"))).toBe(false);
  });

  it("counts a Dropbox share as a candidate even without a .pdf path", () => {
    const links = findPdfLinks(
      `<a href="https://www.dropbox.com/scl/fi/abc/book?rlkey=k&amp;dl=0">Grab the cookbook</a>`,
      "https://www.example.com/x/",
    );
    expect(links).toHaveLength(1);
    // The entity in the href is decoded, so the rlkey survives intact.
    expect(links[0].href).toContain("rlkey=k");
    expect(links[0].href).toContain("dl=0");
  });

  it("returns nothing for a page with no downloads", () => {
    expect(findPdfLinks(`<a href="/about">About</a><p>no files here</p>`, "https://www.example.com/")).toEqual([]);
  });

  it("skips javascript and data URLs", () => {
    const links = findPdfLinks(
      `<a href="javascript:alert(1)">x.pdf</a><a href="data:application/pdf;base64,AAA">y.pdf</a>`,
      "https://www.example.com/",
    );
    expect(links).toEqual([]);
  });
});

describe("resolving what to download", () => {
  it("takes the Dropbox path without fetching anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolvePdfSource(DROPBOX_SHARE);

    expect(resolved.pdfUrl).toContain("dl=1");
    expect(resolved.landingUrl).toBeNull();
    expect(resolved.filename).toBe("2023-Squeaky-Clean-Keto-Challenge-small.pdf");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("takes a direct .pdf link without fetching anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolvePdfSource(`https://${HOST}/files/cookbook.pdf`);

    expect(resolved.pdfUrl).toBe(`https://${HOST}/files/cookbook.pdf`);
    expect(resolved.resolution).toBe("Direct PDF link.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a landing page once and reports which link it chose", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      html(`
        <a href="/privacy.pdf">Privacy</a>
        <a href="https://www.dropbox.com/scl/fi/abc/keto-challenge.pdf?rlkey=k&amp;st=old&amp;dl=0">Download the ebook</a>
      `),
    );
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolvePdfSource(`https://${HOST}/free-squeaky-clean-keto-ebook/`);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolved.landingUrl).toBe(`https://${HOST}/free-squeaky-clean-keto-ebook/`);
    expect(resolved.pdfUrl).toContain("dl=1");
    expect(resolved.pdfUrl).not.toContain("st=old");
    expect(resolved.resolution).toMatch(/picked “Download the ebook”/);
    // The user is told what else was on the page, so a wrong pick is visible.
    expect(resolved.alternatives).toContain(`https://${HOST}/privacy.pdf`);
  });

  it("says what to do when a page has no PDF on it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(html(`<p>Sign up for the newsletter to get the book.</p>`)));

    await expect(resolvePdfSource(`https://${HOST}/free-ebook/`)).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/No PDF download link was found/i),
    });
  });

  it("accepts a link that turns out to serve a PDF directly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } })),
    );

    const resolved = await resolvePdfSource(`https://${HOST}/download`);
    expect(resolved.resolution).toMatch(/served a PDF directly/);
  });

  it("refuses a link that is neither a page nor a PDF", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } })));

    await expect(resolvePdfSource(`https://${HOST}/api/thing`)).rejects.toMatchObject({ status: 415 });
  });
});

describe("SSRF protection on the ebook path", () => {
  it("refuses a landing page on the internal network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const url of [
      "http://192.168.1.10/book.pdf",
      "http://127.0.0.1:8123/book.pdf",
      "http://169.254.169.254/latest/meta-data/",
      "http://homeassistant/local/book.pdf",
      "http://supervisor/core/book.pdf",
      "http://nas.local/book.pdf",
      "file:///etc/passwd",
      "http://user:pass@example.com/book.pdf",
    ]) {
      await expect(resolvePdfSource(url), url).rejects.toBeInstanceOf(FetchRejected);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a redirect that points at the metadata service", async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirect("http://169.254.169.254/latest/meta-data/"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolvePdfSource(`https://${HOST}/free-ebook/`)).rejects.toBeInstanceOf(FetchRejected);
    // The hop was rejected before a second request went out.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect onto the Home Assistant host during the download", async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirect("http://homeassistant:8123/api/"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadPdf(`https://${HOST}/book.pdf`, path.join(dir, "never.pdf"))).rejects.toBeInstanceOf(
      FetchRejected,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than following redirects forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirect(`https://${HOST}/again`));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadPdf(`https://${HOST}/book.pdf`, path.join(dir, "loop.pdf"))).rejects.toMatchObject({
      message: expect.stringMatching(/too many redirects/i),
    });
  });
});

describe("downloading the PDF", () => {
  const pdf = makeTextPdf([["INGREDIENTS", "4 eggs", "INSTRUCTIONS", "1. Cook them."]]);

  function serve(body: Buffer | string, headers: Record<string, string>): void {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200, headers })));
  }

  it("writes the file and reports its size", async () => {
    serve(pdf, { "content-type": "application/pdf", "content-length": String(pdf.length) });
    const destination = path.join(dir, "ok.pdf");
    const seen: number[] = [];

    const result = await downloadPdf(`https://${HOST}/book.pdf`, destination, {
      onProgress: (bytes) => seen.push(bytes),
    });

    expect(result.bytes).toBe(pdf.length);
    expect((await fs.readFile(destination)).subarray(0, 5).toString()).toBe("%PDF-");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("accepts the vague content types a share host actually sends", async () => {
    // Dropbox serves the sample book as application/binary.
    for (const type of ["application/binary", "application/octet-stream", "application/x-pdf"]) {
      serve(pdf, { "content-type": type });
      const destination = path.join(dir, `${type.replace(/\W/g, "_")}.pdf`);
      await expect(downloadPdf(`https://${HOST}/book.pdf`, destination)).resolves.toMatchObject({
        bytes: pdf.length,
      });
    }
  });

  it("refuses a file whose declared size is over the cap", async () => {
    serve(pdf, { "content-type": "application/pdf", "content-length": String(MAX_PDF_BYTES + 1) });

    await expect(downloadPdf(`https://${HOST}/big.pdf`, path.join(dir, "big.pdf"))).rejects.toMatchObject({
      status: 413,
    });
  });

  it("stops a download that grows past the cap mid-stream", async () => {
    // No content-length, so the cap can only be enforced while streaming.
    const huge = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(MAX_PDF_BYTES + 1024, 0x41)]);
    serve(huge, { "content-type": "application/pdf" });
    const destination = path.join(dir, "huge.pdf");

    await expect(downloadPdf(`https://${HOST}/huge.pdf`, destination)).rejects.toMatchObject({ status: 413 });
    // The partial file is not left behind.
    await expect(fs.stat(destination)).rejects.toThrow();
  });

  it("recognises a sign-in page dressed up as a download", async () => {
    serve("<html><body>Please log in to continue</body></html>", { "content-type": "text/html" });

    await expect(downloadPdf(`https://${HOST}/book.pdf`, path.join(dir, "login.pdf"))).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/sign-in|email address/i),
    });
  });

  it("refuses content that is not a PDF however it was labelled", async () => {
    serve(Buffer.from("PK this is a zip"), { "content-type": "application/octet-stream" });
    const destination = path.join(dir, "zip.pdf");

    await expect(downloadPdf(`https://${HOST}/book.pdf`, destination)).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/not a PDF/i),
    });
    await expect(fs.stat(destination)).rejects.toThrow();
  });

  it("refuses an image or a video outright", async () => {
    serve(Buffer.from("PNG"), { "content-type": "image/png" });
    await expect(downloadPdf(`https://${HOST}/book.pdf`, path.join(dir, "png.pdf"))).rejects.toMatchObject({
      status: 415,
    });
  });
});
