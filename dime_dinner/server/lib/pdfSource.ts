/**
 * Turning a link the user pasted into exactly one PDF to download.
 *
 * Two shapes are supported, and the resolved target is always reported back so
 * the user can see which file is about to be read:
 *   - a direct PDF, including a Dropbox share, rewritten to its download form
 *   - an HTML landing page carrying a clear PDF download link
 *
 * Everything goes through the same SSRF guards as the single-recipe importer:
 * the landing page, every redirect hop and the PDF download each re-validate the
 * URL shape and re-resolve the hostname, so no hop can reach a private,
 * link-local or metadata address.
 */
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { FetchRejected, safeFetch, safeRequest, validateUrlShape } from "./safeFetch";
import { MAX_PDF_BYTES, sanitizeFilename } from "./pdfTools";
import { decodeEntities, sanitizeText } from "./recipeParser";

/** Content types a PDF is realistically served with, plus the vague ones. */
const PDF_CONTENT_TYPES = [
  "application/pdf",
  "application/x-pdf",
  "application/octet-stream",
  "application/binary",
  "application/download",
  "application/force-download",
  "binary/octet-stream",
];

const DROPBOX_HOSTS = new Set(["www.dropbox.com", "dropbox.com", "dl.dropboxusercontent.com"]);
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Share links bounce through a CDN host, so allow a couple more hops than a page fetch. */
const DOWNLOAD_MAX_REDIRECTS = 5;

export type ResolvedPdfSource = {
  /** The URL that will be downloaded. */
  pdfUrl: string;
  /** The page the link was found on, when the user gave a landing page. */
  landingUrl: string | null;
  /** Filename to show and to use on disk. */
  filename: string;
  /** Plain-language account of how this file was chosen. */
  resolution: string;
  /** Other PDF links that were passed over, for the "not this one?" hint. */
  alternatives: string[];
};

/* ------------------------------- rewriting -------------------------------- */

function looksLikePdfPath(url: URL): boolean {
  return /\.pdf($|[?#])/i.test(url.pathname) || /\.pdf($|[?#])/i.test(`${url.pathname}${url.search}`);
}

/**
 * Dropbox serves the file itself only when `dl=1`; `dl=0` (the shape the share
 * button produces) returns a preview page. The rewrite keeps the durable share
 * URL — including its `rlkey` — rather than the short-lived CDN URL the preview
 * page embeds, which expires within minutes.
 */
export function rewriteDropbox(url: URL): { url: URL; note: string } | null {
  if (!DROPBOX_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (/^\/scl\/fo\//.test(url.pathname)) {
    throw new FetchRejected(
      "That is a Dropbox folder link. Open the folder, then copy the share link of the PDF itself.",
      422,
    );
  }
  const rewritten = new URL(url.toString());
  rewritten.searchParams.set("dl", "1");
  // `st` is a short-lived signature that goes stale; the rlkey is the durable part.
  rewritten.searchParams.delete("st");
  return { url: rewritten, note: "Dropbox share link rewritten to its direct download form (dl=1)." };
}

/** Google Drive viewer URL → its download endpoint. */
export function rewriteGoogleDrive(url: URL): { url: URL; note: string } | null {
  const host = url.hostname.toLowerCase();
  if (host !== "drive.google.com" && host !== "docs.google.com") return null;
  const id = url.pathname.match(/\/(?:file|d)\/d?\/?([A-Za-z0-9_-]{10,})/)?.[1] ?? url.searchParams.get("id");
  if (!id) return null;
  return {
    url: new URL(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`),
    note: "Google Drive link rewritten to its direct download form. Drive files that are not shared publicly will be refused.",
  };
}

function filenameFor(url: URL, fallback = "ebook.pdf"): string {
  const fromPath = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  const named = sanitizeFilename(fromPath, fallback);
  return /\.pdf$/i.test(named) ? named : `${named.replace(/\.[^.]*$/, "")}.pdf`;
}

/* ---------------------------- landing page scan ---------------------------- */

type LinkCandidate = { href: string; text: string; score: number };

const LINK_RE = /<a\b([^>]*)>([\s\S]{0,400}?)<\/a>/gi;

/**
 * Rank the PDF-ish links on a landing page. Nothing is fetched here — the
 * winner is only a proposal, and the user is told which one it was.
 */
export function findPdfLinks(html: string, pageUrl: string): LinkCandidate[] {
  const seen = new Map<string, LinkCandidate>();
  let match: RegExpExecArray | null;

  while ((match = LINK_RE.exec(html))) {
    const attrs = match[1];
    const rawHref = attrs.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i);
    if (!rawHref) continue;
    const href = decodeEntities((rawHref[1] ?? rawHref[2] ?? rawHref[3] ?? "").trim());
    if (!href || /^(#|javascript:|mailto:|data:)/i.test(href)) continue;

    let absolute: URL;
    try {
      absolute = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") continue;

    const text = sanitizeText(match[2]).slice(0, 120);
    const haystack = `${absolute.pathname}${absolute.search} ${text}`.toLowerCase();
    const isDropbox = DROPBOX_HOSTS.has(absolute.hostname.toLowerCase());
    const isDrive = /(?:drive|docs)\.google\.com$/.test(absolute.hostname.toLowerCase());
    const isPdfPath = looksLikePdfPath(absolute);
    if (!isPdfPath && !isDropbox && !isDrive) continue;

    let score = isPdfPath ? 6 : 3;
    if (/download|get\s|grab|free|ebook|e-book|guide|cookbook|challenge|recipe|printable/.test(haystack)) score += 3;
    if (/\b(pdf)\b/.test(haystack)) score += 1;
    // Boilerplate links to terms and privacy PDFs are never the ebook.
    if (/privacy|terms|policy|disclaimer|affidavit|invoice|w-?9/.test(haystack)) score -= 6;
    if (text) score += 1;

    const key = absolute.toString();
    const existing = seen.get(key);
    if (!existing || existing.score < score) seen.set(key, { href: key, text, score });
  }

  return [...seen.values()].sort((a, b) => b.score - a.score || a.href.length - b.href.length);
}

/* -------------------------------- resolving ------------------------------- */

/**
 * Work out the single PDF a pasted link refers to. One landing page fetch at
 * most; the PDF itself is downloaded separately.
 */
export async function resolvePdfSource(rawUrl: string, signal?: AbortSignal): Promise<ResolvedPdfSource> {
  const url = validateUrlShape(rawUrl);

  const dropbox = rewriteDropbox(url);
  if (dropbox) {
    return {
      pdfUrl: dropbox.url.toString(),
      landingUrl: null,
      filename: filenameFor(dropbox.url),
      resolution: dropbox.note,
      alternatives: [],
    };
  }

  const drive = rewriteGoogleDrive(url);
  if (drive) {
    return {
      pdfUrl: drive.url.toString(),
      landingUrl: null,
      filename: filenameFor(url),
      resolution: drive.note,
      alternatives: [],
    };
  }

  if (looksLikePdfPath(url)) {
    return {
      pdfUrl: url.toString(),
      landingUrl: null,
      filename: filenameFor(url),
      resolution: "Direct PDF link.",
      alternatives: [],
    };
  }

  // Otherwise treat it as a landing page and look for one download link.
  const page = await safeFetch(url.toString(), { timeoutMs: 15_000, signal });
  if (page.contentType && /application\/pdf/.test(page.contentType)) {
    return {
      pdfUrl: page.url,
      landingUrl: null,
      filename: filenameFor(new URL(page.url)),
      resolution: "That link served a PDF directly.",
      alternatives: [],
    };
  }
  if (page.contentType && !/text\/html|application\/xhtml|text\/plain/.test(page.contentType)) {
    throw new FetchRejected("That link is neither a PDF nor a web page.", 415);
  }

  const links = findPdfLinks(page.body, page.url);
  if (!links.length) {
    throw new FetchRejected(
      "No PDF download link was found on that page. Open the page in your browser, copy the link to the PDF itself (or its Dropbox share link), and paste that instead.",
      422,
    );
  }

  const winner = links[0];
  const winnerUrl = validateUrlShape(winner.href);
  const rewrite = rewriteDropbox(winnerUrl) ?? rewriteGoogleDrive(winnerUrl);
  const target = rewrite ? rewrite.url : winnerUrl;
  const label = winner.text ? `“${winner.text}”` : "the only PDF link";

  return {
    pdfUrl: target.toString(),
    landingUrl: page.url,
    filename: filenameFor(target),
    resolution: [
      `Found ${links.length} download link${links.length === 1 ? "" : "s"} on that page and picked ${label}.`,
      rewrite?.note,
    ]
      .filter(Boolean)
      .join(" "),
    alternatives: links.slice(1, 4).map((l) => l.href),
  };
}

/* -------------------------------- download -------------------------------- */

/**
 * Stream a PDF to `destination` under a hard byte cap, verifying it really is a
 * PDF rather than a sign-in page dressed up as one.
 */
export async function downloadPdf(
  pdfUrl: string,
  destination: string,
  options: { signal?: AbortSignal; onProgress?: (bytes: number, total: number | null) => void } = {},
): Promise<{ bytes: number; finalUrl: string }> {
  const { response, url } = await safeRequest(pdfUrl, {
    accept: "application/pdf,*/*;q=0.8",
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    maxRedirects: DOWNLOAD_MAX_REDIRECTS,
    signal: options.signal,
  });

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared && declared > MAX_PDF_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new FetchRejected(
      `That file is ${(declared / 1_048_576).toFixed(1)} MB. Dime Dinner reads PDFs up to ${MAX_PDF_BYTES / 1_048_576} MB.`,
      413,
    );
  }
  if (/^text\/html|^application\/xhtml/.test(contentType)) {
    await response.body?.cancel().catch(() => {});
    throw new FetchRejected(
      "That link returned a web page instead of a PDF — it most likely needs a sign-in, an email address, or a confirmation click. Download the PDF in your browser and upload the file instead.",
      422,
    );
  }
  if (contentType && !PDF_CONTENT_TYPES.includes(contentType)) {
    await response.body?.cancel().catch(() => {});
    throw new FetchRejected(`That link served ${contentType}, which is not a PDF.`, 415);
  }
  if (!response.body) throw new FetchRejected("That download returned no content.", 502);

  let bytes = 0;
  let head = Buffer.alloc(0);
  let tooBig = false;

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  const capped = new Readable({ read() {} });
  source.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (head.length < 8) head = Buffer.concat([head, chunk.subarray(0, 8)]);
    if (bytes > MAX_PDF_BYTES) {
      tooBig = true;
      source.destroy();
      capped.destroy();
      return;
    }
    capped.push(chunk);
    options.onProgress?.(bytes, declared || null);
  });
  source.on("end", () => capped.push(null));
  source.on("error", (err) => capped.destroy(err));

  try {
    await pipeline(capped, createWriteStream(destination), { signal: options.signal });
  } catch (err) {
    await fs.promises.rm(destination, { force: true }).catch(() => {});
    if (tooBig) {
      throw new FetchRejected(
        `That file is larger than the ${MAX_PDF_BYTES / 1_048_576} MB limit, so the download was stopped.`,
        413,
      );
    }
    if (options.signal?.aborted) throw new FetchRejected("Cancelled.", 499);
    throw new FetchRejected(`The download failed: ${(err as Error).message}`, 502);
  }

  if (!head.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    await fs.promises.rm(destination, { force: true }).catch(() => {});
    throw new FetchRejected(
      "That download is not a PDF. If the page needs a sign-in or an email address, download the file in your browser and upload it instead.",
      422,
    );
  }
  return { bytes, finalUrl: url };
}
