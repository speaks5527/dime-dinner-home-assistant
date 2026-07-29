/**
 * The background side of an ebook import.
 *
 * Reading a 50-page scanned cookbook means downloading several megabytes and
 * then running OCR on every page, which is minutes of work — far too long to
 * hold an HTTP request open, and long enough that the user needs to see it
 * moving and be able to give up. So the route starts a job and returns an id
 * immediately, and the client polls this module for progress.
 *
 * A job owns exactly one temp directory. The PDF and any page images live
 * there and nowhere else, and the directory is removed when the job finishes,
 * fails, is cancelled, or expires — the ebook itself is never kept. What
 * survives a job is only what the user later chooses to save.
 */
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { buildDocumentCandidate, detectRecipes, type RecipeCandidate } from "./ebookParser";
import { looksLikeRecimePdf, recimeFooterUrl } from "./recime";
import { downloadPdf, resolvePdfSource, type ResolvedPdfSource } from "./pdfSource";
import {
  createJobDir,
  extractTextPages,
  MAX_PDF_PAGES,
  ocrImage,
  PdfToolError,
  readPdfMeta,
  type PdfMeta,
  removeJobDir,
  renderPage,
  renderThumbnail,
  sanitizeFilename,
  textLayerIsSparse,
  toolStatus,
} from "./pdfTools";

/** Long enough to review 30 recipes without rushing, short enough to not hoard disk. */
const JOB_TTL_MS = 45 * 60_000;
const MAX_JOBS = 4;
/**
 * Two pages at a time. Tesseract is CPU-bound and this add-on shares a
 * Raspberry Pi with everything else Home Assistant is doing.
 */
const OCR_CONCURRENCY = 2;
/** Thumbnails are a review aid, so only the pages that produced a recipe get one. */
const MAX_THUMBNAILS = 40;

export type JobPhase =
  | "resolving"
  | "downloading"
  | "reading"
  | "extracting"
  | "ocr"
  | "detecting"
  | "ready"
  | "failed"
  | "cancelled";

export type ImportJobStatus = {
  id: string;
  phase: JobPhase;
  /** One line the UI can show verbatim. */
  message: string;
  /** 0–100, monotonic within a job. */
  percent: number;
  filename: string;
  sourceUrl: string | null;
  landingUrl: string | null;
  /** How the PDF was chosen, when it came from a link. */
  resolution: string | null;
  alternatives: string[];
  title: string | null;
  author: string | null;
  pageCount: number | null;
  /** True when the text layer was unusable and pages had to be recognised. */
  usedOcr: boolean;
  /** True when the PDF was recognised as a single-recipe export from ReciMe. */
  recime: boolean;
  candidates: RecipeCandidate[];
  skippedPages: number[];
  warnings: string[];
  error: string | null;
  errorStatus: number | null;
  expiresAt: number;
};

type Job = ImportJobStatus & {
  dir: string;
  controller: AbortController;
  /** page number → PNG bytes, dropped with the job. */
  thumbnails: Map<number, Buffer>;
};

const jobs = new Map<string, Job>();

function prune(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.expiresAt <= now) discard(id);
  }
}

function discard(id: string): void {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  job.controller.abort();
  job.thumbnails.clear();
  void removeJobDir(job.dir);
}

function project(job: Job): ImportJobStatus {
  const { dir: _dir, controller: _controller, thumbnails: _thumbnails, ...status } = job;
  return { ...status, candidates: status.candidates.map((c) => ({ ...c })) };
}

function touch(job: Job): void {
  job.expiresAt = Date.now() + JOB_TTL_MS;
}

function advance(job: Job, phase: JobPhase, message: string, percent: number): void {
  if (job.phase === "cancelled") return;
  job.phase = phase;
  job.message = message;
  job.percent = Math.max(job.percent, Math.min(100, Math.round(percent)));
  touch(job);
}

/* -------------------------------- lifecycle ------------------------------- */

export function getJob(id: string): ImportJobStatus | null {
  prune();
  const job = jobs.get(id);
  if (!job) return null;
  touch(job);
  return project(job);
}

export function getThumbnail(id: string, page: number): Buffer | null {
  const job = jobs.get(id);
  return job?.thumbnails.get(page) ?? null;
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.controller.abort();
  job.phase = "cancelled";
  job.message = "Import cancelled.";
  // The worker sees the abort and tears the directory down; the status stays
  // readable for a short while so the UI can show why polling stopped.
  job.expiresAt = Date.now() + 60_000;
  return true;
}

/** Called at startup so a crash mid-import cannot leave a job behind. */
export function shutdownJobs(): void {
  for (const id of [...jobs.keys()]) discard(id);
}

export type StartInput =
  | { kind: "url"; url: string }
  | { kind: "upload"; filename: string; data: Buffer };

export function startImport(input: StartInput): ImportJobStatus {
  prune();
  while (jobs.size >= MAX_JOBS) {
    const oldest = [...jobs.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (!oldest) break;
    discard(oldest[0]);
  }

  const id = crypto.randomBytes(18).toString("base64url");
  const job: Job = {
    id,
    phase: "resolving",
    message: input.kind === "url" ? "Working out which file that link points to…" : "Reading the uploaded file…",
    percent: 1,
    filename: input.kind === "upload" ? sanitizeFilename(input.filename) : "ebook.pdf",
    sourceUrl: input.kind === "url" ? input.url : null,
    landingUrl: null,
    resolution: null,
    alternatives: [],
    title: null,
    author: null,
    pageCount: null,
    usedOcr: false,
    recime: false,
    candidates: [],
    skippedPages: [],
    warnings: [],
    error: null,
    errorStatus: null,
    expiresAt: Date.now() + JOB_TTL_MS,
    dir: "",
    controller: new AbortController(),
    thumbnails: new Map(),
  };
  jobs.set(id, job);

  void runJob(job, input);
  return project(job);
}

/* --------------------------------- worker --------------------------------- */

async function runJob(job: Job, input: StartInput): Promise<void> {
  try {
    job.dir = await createJobDir();
    const pdfPath = path.join(job.dir, "source.pdf");

    if (input.kind === "url") {
      const resolved = await obtainByUrl(job, input.url, pdfPath);
      job.filename = resolved.filename;
    } else {
      await fs.writeFile(pdfPath, input.data);
      advance(job, "reading", "Reading the PDF…", 30);
    }
    throwIfCancelled(job);

    const pageTexts = await readPages(job, pdfPath);
    throwIfCancelled(job);

    advance(job, "detecting", "Looking for recipes…", 92);
    const { candidates, skippedPages } = detect(job, pageTexts);
    job.candidates = candidates;
    job.skippedPages = skippedPages;

    if (!candidates.length) {
      throw new PdfToolError(
        job.usedOcr
          ? "No recipes could be picked out of that PDF. The pages were read, but none of them had a recognisable ingredients list and method."
          : "No recipes were found in that PDF. It may be a menu, a meal plan or a scan whose text could not be read.",
        422,
      );
    }

    await addThumbnails(job, pdfPath, candidates);
    throwIfCancelled(job);

    advance(
      job,
      "ready",
      `Found ${candidates.length} recipe${candidates.length === 1 ? "" : "s"}. Choose the ones to import.`,
      100,
    );
  } catch (err) {
    if (job.phase === "cancelled" || job.controller.signal.aborted) {
      job.phase = "cancelled";
      job.message = "Import cancelled.";
    } else {
      job.phase = "failed";
      job.error = (err as Error).message;
      job.errorStatus = (err as { status?: number }).status ?? 500;
      job.message = job.error;
    }
  } finally {
    // The PDF and every rendered page go now. Thumbnails are already in memory
    // and expire with the job.
    if (job.dir) await removeJobDir(job.dir);
    job.dir = "";
  }
}

/**
 * A ReciMe export holds one recipe however many pages it runs to, so it is
 * read as a single document. Everything else — a cookbook, an ebook — is read
 * page by page as before. If the ReciMe layout turns out not to parse, the
 * generic detector still gets its turn rather than the import failing.
 */
function detect(job: Job, pageTexts: string[]): { candidates: RecipeCandidate[]; skippedPages: number[] } {
  const prefix = job.id.slice(0, 6);
  if (job.recime) {
    const candidate = buildDocumentCandidate(pageTexts, `${prefix}-1`);
    if (candidate) return { candidates: [candidate], skippedPages: [] };
  }
  return detectRecipes(pageTexts, prefix);
}

function throwIfCancelled(job: Job): void {
  if (job.controller.signal.aborted || job.phase === "cancelled") {
    throw new PdfToolError("Cancelled.", 499);
  }
}

async function obtainByUrl(job: Job, url: string, pdfPath: string): Promise<ResolvedPdfSource> {
  const resolved = await resolvePdfSource(url, job.controller.signal);
  job.landingUrl = resolved.landingUrl;
  job.sourceUrl = resolved.pdfUrl;
  job.resolution = resolved.resolution;
  job.alternatives = resolved.alternatives;
  advance(job, "downloading", `Downloading ${resolved.filename}…`, 5);

  await downloadPdf(resolved.pdfUrl, pdfPath, {
    signal: job.controller.signal,
    onProgress: (bytes, total) => {
      const share = total ? bytes / total : 0;
      advance(
        job,
        "downloading",
        total
          ? `Downloading ${resolved.filename} — ${(bytes / 1_048_576).toFixed(1)} of ${(total / 1_048_576).toFixed(1)} MB`
          : `Downloading ${resolved.filename} — ${(bytes / 1_048_576).toFixed(1)} MB`,
        5 + share * 20,
      );
    },
  });
  advance(job, "reading", "Reading the PDF…", 30);
  return resolved;
}

/**
 * Get one string of text per page: the embedded text layer when the PDF has a
 * real one, otherwise page images through OCR.
 */
async function readPages(job: Job, pdfPath: string): Promise<string[]> {
  const meta = await readPdfMeta(pdfPath, job.controller.signal);
  job.pageCount = meta.pages;
  job.title = meta.title;
  job.author = meta.author;
  advance(job, "extracting", `Reading text from ${meta.pages} pages…`, 34);

  const textPages = await extractTextPages(pdfPath, meta.pages, job.controller.signal);
  if (!textLayerIsSparse(textPages)) {
    noteRecime(job, meta, textPages);
    advance(job, "extracting", `Read text from all ${meta.pages} pages.`, 88);
    return textPages;
  }

  const tools = await toolStatus();
  if (!tools.ocrAvailable) {
    throw new PdfToolError(
      `The pages of that PDF are images rather than text, so they need OCR — and ${tools.message}`,
      503,
    );
  }

  job.usedOcr = true;
  job.warnings.push(
    "The pages of this PDF are images, so the text was recognised with OCR. Check each recipe before importing — OCR makes mistakes.",
  );
  advance(job, "ocr", `No text layer — recognising page 1 of ${meta.pages}…`, 36);
  const ocrPages = await ocrAllPages(job, pdfPath, meta.pages);
  // A ReciMe export that has been printed or scanned still says so on the page,
  // so the check is worth repeating once OCR has given us something to read.
  noteRecime(job, meta, ocrPages);
  return ocrPages;
}

/** Record that this PDF came from ReciMe, and keep the link it printed. */
function noteRecime(job: Job, meta: PdfMeta, pageTexts: string[]): void {
  if (!looksLikeRecimePdf(meta, pageTexts)) return;
  job.recime = true;
  job.sourceUrl = recimeFooterUrl(pageTexts) ?? job.sourceUrl;
}

async function ocrAllPages(job: Job, pdfPath: string, pages: number): Promise<string[]> {
  const out = new Array<string>(pages).fill("");
  let next = 1;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const page = next++;
      if (page > pages) return;
      throwIfCancelled(job);
      try {
        const image = await renderPage(pdfPath, page, job.dir, {
          signal: job.controller.signal,
        });
        out[page - 1] = await ocrImage(image, job.controller.signal);
        // Rendered pages are large; drop each one as soon as it is read so a
        // 60-page book never has 60 PNGs on disk at once.
        await fs.rm(image, { force: true }).catch(() => {});
      } catch (err) {
        if (job.controller.signal.aborted) throw err;
        // One unreadable page should not lose the other forty-nine.
        job.warnings.push(`Page ${page} could not be read: ${(err as Error).message}`);
      }
      done += 1;
      advance(job, "ocr", `Recognising page ${done} of ${pages}…`, 36 + (done / pages) * 52);
    }
  };

  await Promise.all(Array.from({ length: Math.min(OCR_CONCURRENCY, pages) }, worker));
  return out;
}

async function addThumbnails(job: Job, pdfPath: string, candidates: RecipeCandidate[]): Promise<void> {
  const pages = [...new Set(candidates.flatMap((c) => c.pages))].slice(0, MAX_THUMBNAILS);
  for (const page of pages) {
    if (job.controller.signal.aborted) return;
    const png = await renderThumbnail(pdfPath, page, job.dir, job.controller.signal);
    if (png) job.thumbnails.set(page, png);
  }
}

export { MAX_PDF_PAGES };
