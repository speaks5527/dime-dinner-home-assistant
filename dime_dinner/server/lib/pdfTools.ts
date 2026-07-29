/**
 * Thin wrappers around the Poppler and Tesseract command line tools.
 *
 * Every invocation goes through `run`, which spawns the binary directly with an
 * argument array — there is no shell, so a filename can never be interpreted as
 * a command. Each call is bounded by a timeout and an output cap, and callers
 * only ever pass paths inside a job's own temp directory.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Hard ceilings sized for a Home Assistant host, not a server farm. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_PAGES = 60;
/** 150–180 DPI is the band where Tesseract reads body text reliably. */
export const OCR_DPI = 165;
export const THUMBNAIL_WIDTH = 260;

const PDFINFO_TIMEOUT_MS = 20_000;
const PDFTOTEXT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 60_000;
const OCR_TIMEOUT_MS = 90_000;
/** OCR of one page is a few KB of text; anything near this is runaway output. */
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;

const TMP_PREFIX = "dime-dinner-import-";

export class PdfToolError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "PdfToolError";
    this.status = status;
  }
}

type RunResult = { code: number; stdout: Buffer; stderr: string };

/**
 * Spawn a tool with a fixed argument list. Rejects only when the binary is
 * missing, the timeout expires or the output cap is hit; a non-zero exit is
 * returned so callers can read stderr and raise a useful message.
 */
async function run(
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: 30_000 },
): Promise<RunResult> {
  if (options.signal?.aborted) throw new PdfToolError("Cancelled.", 499);

  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let errText = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new PdfToolError(`${path.basename(command)} took too long and was stopped.`, 504)));
    }, options.timeoutMs);

    const onAbort = () => {
      kill();
      finish(() => reject(new PdfToolError("Cancelled.", 499)));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.byteLength;
      if (outBytes > MAX_TOOL_OUTPUT_BYTES) {
        kill();
        finish(() => reject(new PdfToolError("That PDF produced an unreasonable amount of output.", 413)));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errText.length < 8000) errText += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      finish(() =>
        reject(
          missing
            ? new PdfToolError(`${path.basename(command)} is not installed in this add-on image.`, 503)
            : new PdfToolError(`${path.basename(command)} could not be started: ${err.message}`, 500),
        ),
      );
    });

    child.on("close", (code) => {
      finish(() => resolve({ code: code ?? 0, stdout: Buffer.concat(out), stderr: errText }));
    });
  });
}

/* ----------------------------- availability ------------------------------ */

export type ToolStatus = {
  poppler: boolean;
  tesseract: boolean;
  /** Tesseract is present and reports the English traineddata. */
  english: boolean;
  ocrAvailable: boolean;
  message: string;
};

let statusCache: ToolStatus | null = null;

export async function toolStatus(): Promise<ToolStatus> {
  if (statusCache) return statusCache;

  let poppler = false;
  let tesseract = false;
  let english = false;

  try {
    const info = await run("pdfinfo", ["-v"], { timeoutMs: 8000 });
    poppler = info.code === 0 || /pdfinfo version/i.test(info.stderr);
  } catch {
    poppler = false;
  }

  try {
    const langs = await run("tesseract", ["--list-langs"], { timeoutMs: 12_000 });
    // Older builds print the language list on stderr.
    const listed = `${langs.stdout.toString("utf-8")}\n${langs.stderr}`;
    tesseract = true;
    english = /^\s*eng\s*$/m.test(listed);
  } catch {
    tesseract = false;
  }

  const ocrAvailable = poppler && tesseract && english;
  statusCache = {
    poppler,
    tesseract,
    english,
    ocrAvailable,
    message: !poppler
      ? "Poppler (pdftotext) is missing from this add-on image, so PDFs cannot be read. Rebuild the add-on."
      : !tesseract
        ? "Tesseract is missing, so ebooks whose pages are images cannot be read. Rebuild the add-on."
        : !english
          ? "Tesseract is installed but has no English language data (tesseract-ocr-data-eng). Rebuild the add-on."
          : "PDF text extraction and OCR are both available.",
  };
  return statusCache;
}

export function resetToolStatus(): void {
  statusCache = null;
}

/* ------------------------------- temp files ------------------------------- */

function tmpRoot(): string {
  return process.env.DIME_DINNER_TMP || os.tmpdir();
}

export async function createJobDir(): Promise<string> {
  return await fs.mkdtemp(path.join(tmpRoot(), TMP_PREFIX));
}

export async function removeJobDir(dir: string): Promise<void> {
  if (!dir || !path.basename(dir).startsWith(TMP_PREFIX)) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Drop temp directories orphaned by a crash or an add-on restart. */
export async function cleanupOrphanedJobDirs(): Promise<number> {
  let removed = 0;
  try {
    for (const entry of await fs.readdir(tmpRoot())) {
      if (!entry.startsWith(TMP_PREFIX)) continue;
      await fs.rm(path.join(tmpRoot(), entry), { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
  } catch {
    /* nothing to clean */
  }
  return removed;
}

/**
 * Reduce an untrusted name to something safe to show and to use as a leaf
 * filename: no separators, no traversal, no control characters.
 */
export function sanitizeFilename(raw: string, fallback = "document.pdf"): string {
  const base = path.basename(String(raw ?? "").replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/* --------------------------------- reading -------------------------------- */

export type PdfMeta = {
  pages: number;
  title: string | null;
  author: string | null;
  /** The app that laid the PDF out, and the library that wrote it. Used to
   *  recognise an export from a known recipe app. */
  creator: string | null;
  producer: string | null;
};

/** `pdfinfo`, mapped onto the specific failures worth telling the user about. */
export async function readPdfMeta(file: string, signal?: AbortSignal): Promise<PdfMeta> {
  const result = await run("pdfinfo", ["-enc", "UTF-8", file], { timeoutMs: PDFINFO_TIMEOUT_MS, signal });
  const text = result.stdout.toString("utf-8");
  const combined = `${text}\n${result.stderr}`;

  if (/incorrect password|encrypted/i.test(result.stderr) || /^Encrypted:\s*yes/im.test(text)) {
    throw new PdfToolError("That PDF is password protected. Remove the password and try again.", 422);
  }
  if (result.code !== 0 || !/^Pages:/im.test(text)) {
    if (/damaged|couldn't read|may not be a pdf|Syntax Error/i.test(combined)) {
      throw new PdfToolError("That file is not a readable PDF — it looks corrupt or is a different format.", 422);
    }
    throw new PdfToolError("That PDF could not be opened.", 422);
  }

  const pages = Number(text.match(/^Pages:\s*(\d+)/im)?.[1] ?? 0);
  if (!pages) throw new PdfToolError("That PDF reports no pages.", 422);
  if (pages > MAX_PDF_PAGES) {
    throw new PdfToolError(
      `That PDF has ${pages} pages. Dime Dinner reads up to ${MAX_PDF_PAGES} so a single import cannot tie up your Home Assistant host.`,
      413,
    );
  }

  const field = (name: string) => {
    const value = text.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim();
    return value ? value.slice(0, 200) : null;
  };
  return {
    pages,
    title: field("Title"),
    author: field("Author"),
    creator: field("Creator"),
    producer: field("Producer"),
  };
}

/** Embedded text layer, one entry per page. Empty strings for image-only pages. */
export async function extractTextPages(file: string, pages: number, signal?: AbortSignal): Promise<string[]> {
  const result = await run("pdftotext", ["-enc", "UTF-8", "-layout", "-q", file, "-"], {
    timeoutMs: PDFTOTEXT_TIMEOUT_MS,
    signal,
  });
  if (result.code !== 0 && !result.stdout.length) {
    throw new PdfToolError("That PDF could not be read — it looks corrupt.", 422);
  }
  const split = result.stdout.toString("utf-8").split("\f");
  const out: string[] = [];
  for (let i = 0; i < pages; i += 1) out.push((split[i] ?? "").trim());
  return out;
}

/** True when the text layer is too thin to be the real content of the book. */
export function textLayerIsSparse(pageTexts: string[]): boolean {
  const dense = pageTexts.filter((text) => text.replace(/\s+/g, "").length >= 200).length;
  const totalChars = pageTexts.reduce((sum, text) => sum + text.replace(/\s+/g, "").length, 0);
  if (totalChars < 400) return true;
  return dense < Math.max(1, Math.ceil(pageTexts.length * 0.3));
}

/** Render one page to a grayscale PNG inside `dir`; returns the file path. */
export async function renderPage(
  file: string,
  page: number,
  dir: string,
  options: { dpi?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const prefix = path.join(dir, `page-${page}`);
  const result = await run(
    "pdftoppm",
    ["-q", "-r", String(options.dpi ?? OCR_DPI), "-gray", "-png", "-singlefile", "-f", String(page), "-l", String(page), file, prefix],
    { timeoutMs: RENDER_TIMEOUT_MS, signal: options.signal },
  );
  const output = `${prefix}.png`;
  const ok = await fs
    .stat(output)
    .then((s) => s.size > 0)
    .catch(() => false);
  if (!ok) {
    throw new PdfToolError(`Page ${page} of that PDF could not be rendered${result.stderr ? `: ${result.stderr.trim().slice(0, 120)}` : "."}`, 422);
  }
  return output;
}

/** Small colour PNG of one page, for the review screen. Never persisted. */
export async function renderThumbnail(
  file: string,
  page: number,
  dir: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const prefix = path.join(dir, `thumb-${page}`);
  try {
    await run(
      "pdftoppm",
      ["-q", "-png", "-singlefile", "-scale-to", String(THUMBNAIL_WIDTH), "-f", String(page), "-l", String(page), file, prefix],
      { timeoutMs: RENDER_TIMEOUT_MS, signal },
    );
    return await fs.readFile(`${prefix}.png`);
  } catch {
    // A thumbnail is a nicety; losing one must not fail the import.
    return null;
  }
}

/** Tesseract, English, plain text on stdout. */
export async function ocrImage(imagePath: string, signal?: AbortSignal): Promise<string> {
  const result = await run("tesseract", [imagePath, "stdout", "-l", "eng", "--psm", "3"], {
    timeoutMs: OCR_TIMEOUT_MS,
    signal,
  });
  if (result.code !== 0 && !result.stdout.length) {
    if (/failed loading language|Could not initialize tesseract/i.test(result.stderr)) {
      throw new PdfToolError("Tesseract has no English language data installed. Rebuild the add-on.", 503);
    }
    throw new PdfToolError("OCR failed on that page.", 500);
  }
  return result.stdout.toString("utf-8").trim();
}
