/**
 * Finding recipes in the text of an ebook, one page at a time.
 *
 * The text this reads is usually OCR output from a cookbook laid out in a
 * design tool, so it arrives with the columns already flattened into one
 * stream and with characters the recogniser guessed wrong. Everything here is
 * therefore written to be forgiving about *shape* and strict about *content*:
 * a page becomes a candidate only when it really carries an ingredient list
 * and a method, and no field is ever filled in with something the page did not
 * say. A missing title comes back as null with a warning attached rather than
 * as a guess, because the user is going to see and correct these before
 * anything is saved.
 *
 * What that strictness buys, on the 51-page book this was built against: the
 * table of contents, five meal-plan spreads and the resources page all fail
 * the two-heading test and drop out, and the 32 real recipes come through.
 */
import { EBOOK_CONFIDENT, type InstructionGroup } from "@shared/schema";
import { sanitizeText } from "./recipeParser";

export type RecipeCandidate = {
  /** Stable within one job, so the client can address a candidate. */
  id: string;
  title: string | null;
  /** 1-based page numbers this candidate was read from. */
  pages: number[];
  ingredients: string[];
  instructions: InstructionGroup[];
  description: string | null;
  notes: string[];
  servings: string | null;
  totalMinutes: number | null;
  nutrition: Record<string, string> | null;
  /** 0–1. Below 0.7 the review screen shows the warnings prominently. */
  confidence: number;
  warnings: string[];
};

/**
 * Headings survive OCR well, but decorative artwork alongside them does not:
 * `INSTRUCTIONS gy Oa om` is one real line from the sample book. Allowing a
 * short tail of stub tokens keeps those pages from being thrown away, while
 * still refusing anything with a real word after the heading.
 */
const HEADING_TAIL = String.raw`(?:\s*:)?(?:\s+[A-Za-z|©%,."'’—-]{1,3}){0,4}\s*$`;
const INGREDIENTS_HEADING = new RegExp(
  String.raw`^[\s|]*(?:ingredients?|what\s+you(?:'|’)?ll\s+need)${HEADING_TAIL}`,
  "i",
);
const INSTRUCTIONS_HEADING = new RegExp(
  String.raw`^[\s|]*(?:instructions?|directions?|method|preparation|steps)${HEADING_TAIL}`,
  "i",
);
const ALTERNATIVE_HEADING = /^[\s|]*(alternative\s+method|variation|to\s+serve|for\s+the\s+\w+)\s*:?\s*$/i;
const NOTES_HEADING = /^[\s|]*notes?\s*:?\s*$/i;

/**
 * `©` is how Tesseract reads the little clock glyph, and `|` is the column
 * rule bleeding into the text; both reliably mark the servings/time strip.
 */
const META_MARKER = /[©(]\s*\d|^\s*\|?\s*\d+\s+serving|^\s*\|/;
const SERVINGS_RE = /(\d+(?:\s*-\s*\d+)?)\s+servings?\b([^|©]*)/i;
const TIME_RE = /[©(]\s*([A-Za-z0-9]{1,3})\s*(minutes?|mins?|hours?|hrs?)\b/i;
const NUTRITION_RE =
  /(\d[\d.,]*)\s*(?:calories|cals?)\b|(\d+|[A-Za-z])\s*g\s+(fat|carbs?|fiber|fibre|protein|sugar)\b/i;

/** Step numbering that has been through OCR: `1.`, `§.`, `Tl.`, `2)`. */
const STEP_START = /^\s*(?:\d{1,2}|[A-Za-z§|\]{}]{1,2})\s*[.)]\s*(?=[A-Za-z("'“])/;
/** A leading amount, allowing `]`/`|`/`I`/`l` for a misread `1`. */
const QUANTITY_START =
  /^\s*(?:\d+[\d/.,\s-]*|[½¼¾⅓⅔⅛]|[\]|IlO]\s(?=[a-z])|a\s+(?:pinch|handful|few)\b|salt\b|pepper\b)/i;

/* ------------------------------ page slicing ------------------------------ */

/**
 * OCR of a two-column page can weld a body line onto the meta strip, e.g.
 * `cereal bowl and chill for 5 | 1 serving © 5 minutes`. Splitting there keeps
 * the instruction intact instead of letting the strip truncate it.
 */
function splitMergedMeta(line: string): { body: string; meta: string | null } {
  const at = line.search(/\s(?:\||©)\s*(?:\d|I\d|l\d)/);
  if (at <= 0) return { body: line, meta: null };
  const meta = line.slice(at).trim();
  if (!META_MARKER.test(meta)) return { body: line, meta: null };
  return { body: line.slice(0, at).trim(), meta };
}

type PageLines = { lines: string[]; metaLines: string[] };

function prepare(pageText: string): PageLines {
  const lines: string[] = [];
  const metaLines: string[] = [];
  for (const raw of pageText.split(/\r?\n/)) {
    if (!raw.trim()) {
      lines.push("");
      continue;
    }
    // A wide gap is the gutter between two columns that the page layout has
    // flattened into one line. The split has to happen before sanitizing,
    // which collapses runs of spaces and would hide the gutter.
    for (const piece of raw.split(/ {3,}|\t+/)) {
      const line = sanitizeText(piece);
      if (!line) continue;
      const { body, meta } = splitMergedMeta(line);
      if (meta) metaLines.push(meta);
      if (body) lines.push(body);
    }
  }
  return { lines, metaLines };
}

/* ------------------------------- field reads ------------------------------ */

function isHeading(line: string): boolean {
  return (
    INGREDIENTS_HEADING.test(line) ||
    INSTRUCTIONS_HEADING.test(line) ||
    ALTERNATIVE_HEADING.test(line) ||
    NOTES_HEADING.test(line)
  );
}

function looksLikeNutrition(line: string): boolean {
  return NUTRITION_RE.test(line) && /calories|cals?\b|\bg\s+(fat|carbs?|fiber|fibre|protein)/i.test(line);
}

/**
 * Ingredients wrap mid-phrase constantly (`psyllium husk` / `powder`). A line
 * continues the one above when it does not open with an amount and either
 * starts lowercase or follows a line that ended mid-clause.
 */
function collectIngredients(lines: string[], from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i < to; i += 1) {
    const line = lines[i];
    if (!line || isHeading(line)) continue;
    if (looksLikeNutrition(line)) continue;
    const previous = out[out.length - 1];
    const continues =
      previous &&
      !QUANTITY_START.test(line) &&
      (/^[a-z(]/.test(line) || /[,(]$/.test(previous) || /\b(or|and|of|with|for)$/i.test(previous));
    if (continues) {
      out[out.length - 1] = `${previous} ${line}`.replace(/\s+/g, " ");
    } else {
      out.push(line);
    }
  }
  return out.map((text) => text.replace(/^[-•*•]\s*/, "").trim()).filter((text) => text.length > 1);
}

function collectSteps(lines: string[], from: number, to: number): InstructionGroup[] {
  const groups: InstructionGroup[] = [{ steps: [] }];
  let current = groups[0];

  for (let i = from; i < to; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (NOTES_HEADING.test(line)) break;
    if (ALTERNATIVE_HEADING.test(line)) {
      current = { heading: line.replace(/[\s|]*:?\s*$/, "").trim(), steps: [] };
      groups.push(current);
      continue;
    }
    if (isHeading(line) || looksLikeNutrition(line)) continue;

    if (STEP_START.test(line)) {
      current.steps.push({ text: line.replace(STEP_START, "").trim() });
    } else if (current.steps.length) {
      const last = current.steps[current.steps.length - 1];
      last.text = `${last.text} ${line}`.replace(/\s+/g, " ").trim();
    }
  }

  return groups.filter((group) => group.steps.length);
}

/**
 * The title sits between the method and the servings strip. Take the last
 * title-like line before the first meta marker after the instructions — and
 * return null rather than reaching for a sentence out of the description.
 */
function findTitle(lines: string[], afterIndex: number): string | null {
  let limit = lines.length;
  for (let i = afterIndex; i < lines.length; i += 1) {
    if (lines[i] && META_MARKER.test(lines[i])) {
      limit = i;
      break;
    }
  }

  for (let i = limit - 1; i > afterIndex; i -= 1) {
    // A title set beside the method can land on the same line as the tail of a
    // step, with nothing but a space between them. When that tail is a clause
    // ending in a comma the boundary is unambiguous, so drop it; anything less
    // clear-cut is left alone and reported as a missing title instead.
    const line = (lines[i] ?? "").replace(/^[a-z][^,]{0,40},\s+(?=[A-Z])/, "");
    if (!line || line.length < 3 || line.length > 70) continue;
    if (isHeading(line) || looksLikeNutrition(line) || STEP_START.test(line)) continue;
    if (/[.,:;]$/.test(line)) continue;
    if (QUANTITY_START.test(line)) continue;
    if (!/[A-Za-z]{3}/.test(line)) continue;
    // Real titles are Capitalised Words, not a fragment of running prose.
    const words = line.split(/\s+/);
    if (words.length > 8) continue;
    const capitalised = words.filter((w) => /^[A-Z"“'‘]/.test(w)).length;
    if (capitalised < Math.ceil(words.length / 2)) continue;
    return line;
  }
  return null;
}

function readMeta(metaLines: string[]): { servings: string | null; totalMinutes: number | null } {
  const joined = metaLines.join(" ");
  const servingsMatch = joined.match(SERVINGS_RE);
  const servings = servingsMatch
    ? sanitizeText(`${servingsMatch[1]} servings${servingsMatch[2] ?? ""}`).replace(/\s+/g, " ").trim()
    : null;

  const timeMatch = joined.match(TIME_RE);
  let totalMinutes: number | null = null;
  if (timeMatch) {
    // `I5`, `go` and `1O` are what the recogniser makes of 15, 90 and 10.
    const digits = timeMatch[1].replace(/[Il|\]]/g, "1").replace(/[Oo]/g, "0").replace(/g0/i, "90");
    const value = Number(digits);
    if (Number.isFinite(value) && value > 0 && value < 1000) {
      totalMinutes = /hour|hr/i.test(timeMatch[2]) ? value * 60 : value;
    }
  }
  return { servings, totalMinutes };
}

function readNutrition(lines: string[]): Record<string, string> | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !looksLikeNutrition(line)) continue;
    const out: Record<string, string> = {};
    const calories = line.match(/(\d[\d.,]*)\s*(?:calories|cals?)\b/i);
    if (calories) out.calories = calories[1];
    for (const [, amount, nutrient] of line.matchAll(/([\dO][\dOg.,]*)\s*g\s+(fat|carbs?|fiber|fibre|protein|sugar)\b/gi)) {
      out[nutrient.toLowerCase().replace(/^carb$/, "carbs").replace(/^fibre$/, "fiber")] =
        `${amount.replace(/O/g, "0").replace(/g$/, "")}g`;
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

function readNotes(lines: string[]): string[] {
  const start = lines.findIndex((line) => NOTES_HEADING.test(line));
  if (start < 0) return [];
  const notes: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || looksLikeNutrition(line)) continue;
    if (STEP_START.test(line)) {
      notes.push(line.replace(STEP_START, "").trim());
    } else if (notes.length) {
      notes[notes.length - 1] = `${notes[notes.length - 1]} ${line}`.replace(/\s+/g, " ");
    }
  }
  return notes.filter((note) => note.length > 3).slice(0, 8);
}

/**
 * The paragraph between the servings strip and NOTES. Only kept when it reads
 * like a sentence, so a stray column fragment does not become the blurb.
 */
function readDescription(lines: string[], metaIndex: number): string | null {
  if (metaIndex < 0) return null;
  const stop = lines.findIndex((line, i) => i > metaIndex && NOTES_HEADING.test(line));
  const end = stop < 0 ? lines.length : stop;
  const parts: string[] = [];
  for (let i = metaIndex + 1; i < end; i += 1) {
    const line = lines[i];
    if (!line || isHeading(line) || looksLikeNutrition(line) || META_MARKER.test(line)) continue;
    if (STEP_START.test(line)) continue;
    parts.push(line);
  }
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  if (text.length < 25 || !/[.!?]/.test(text)) return null;
  return text.slice(0, 600);
}

/* ------------------------------- candidates ------------------------------- */

function score(candidate: {
  hasBothHeadings: boolean;
  ingredients: string[];
  steps: number;
  title: string | null;
}): { confidence: number; warnings: string[] } {
  const warnings: string[] = [];
  let confidence = 0.35;
  if (candidate.hasBothHeadings) confidence += 0.3;
  if (candidate.ingredients.length >= 3) confidence += 0.15;
  else warnings.push("Only a few ingredient lines were recognised — check nothing is missing.");
  if (candidate.steps >= 2) confidence += 0.15;
  else warnings.push("Few instruction steps were recognised — check the method is complete.");
  if (candidate.title) confidence += 0.05;
  else warnings.push("No title could be read from this page. Add one before importing.");

  // Anything we had to warn about is by definition not a confident read, so it
  // stays out of the band the review screen pre-selects from.
  if (warnings.length) confidence = Math.min(confidence, EBOOK_CONFIDENT - 0.05);
  return { confidence: Math.min(1, Number(confidence.toFixed(2))), warnings };
}

function buildCandidate(pageText: string, page: number, id: string): RecipeCandidate | null {
  const { lines, metaLines } = prepare(pageText);
  const ingredientsAt = lines.findIndex((line) => INGREDIENTS_HEADING.test(line));
  const instructionsAt = lines.findIndex((line, i) => i > ingredientsAt && INSTRUCTIONS_HEADING.test(line));
  if (ingredientsAt < 0 || instructionsAt < 0) return null;

  const ingredients = collectIngredients(lines, ingredientsAt + 1, instructionsAt);
  const instructions = collectSteps(lines, instructionsAt + 1, lines.length);
  const stepCount = instructions.reduce((sum, group) => sum + group.steps.length, 0);
  if (!ingredients.length || !stepCount) return null;

  const title = findTitle(lines, instructionsAt);
  const inlineMetaIndex = lines.findIndex((line, i) => i > instructionsAt && META_MARKER.test(line));
  const { servings, totalMinutes } = readMeta([
    ...metaLines,
    ...(inlineMetaIndex >= 0 ? [lines[inlineMetaIndex]] : []),
  ]);

  const { confidence, warnings } = score({ hasBothHeadings: true, ingredients, steps: stepCount, title });

  return {
    id,
    title,
    pages: [page],
    ingredients,
    instructions,
    description: readDescription(lines, inlineMetaIndex),
    notes: readNotes(lines),
    servings,
    totalMinutes,
    nutrition: readNutrition(lines),
    confidence,
    warnings,
  };
}

/**
 * Some text-layer PDFs print no INGREDIENTS/INSTRUCTIONS headings at all. Only
 * accept those when the page is unmistakably a recipe: a run of amount-led
 * lines followed by numbered steps, and a heading line to name it.
 */
function buildHeadlessCandidate(pageText: string, page: number, id: string): RecipeCandidate | null {
  const { lines, metaLines } = prepare(pageText);
  const firstStep = lines.findIndex((line) => STEP_START.test(line));
  if (firstStep < 1) return null;

  const quantityLines = lines.slice(0, firstStep).filter((line) => QUANTITY_START.test(line));
  if (quantityLines.length < 4) return null;

  const ingredientsStart = lines.findIndex((line) => QUANTITY_START.test(line));
  const ingredients = collectIngredients(lines, ingredientsStart, firstStep);
  const instructions = collectSteps(lines, firstStep, lines.length);
  const stepCount = instructions.reduce((sum, group) => sum + group.steps.length, 0);
  if (stepCount < 2) return null;

  const title = lines.slice(0, ingredientsStart).reverse().find((line) => {
    if (!line || line.length < 3 || line.length > 70) return false;
    return !isHeading(line) && !QUANTITY_START.test(line) && /[A-Za-z]{3}/.test(line) && !/[.,:;]$/.test(line);
  });
  if (!title) return null;

  const { servings, totalMinutes } = readMeta(metaLines);
  return {
    id,
    title,
    pages: [page],
    ingredients,
    instructions,
    description: null,
    notes: [],
    servings,
    totalMinutes,
    nutrition: readNutrition(lines),
    confidence: 0.55,
    warnings: [
      "This page has no INGREDIENTS/INSTRUCTIONS headings, so the split between them was inferred. Check it carefully.",
    ],
  };
}

/** Candidates at or above this are shown; the rest are counted and dropped. */
export const MIN_CONFIDENCE = 0.5;

export type DetectionResult = {
  candidates: RecipeCandidate[];
  /** Pages that parsed as something other than a recipe (contents, meal plans). */
  skippedPages: number[];
};

/**
 * Read every page and return the recipes found, best first. `idPrefix` keeps
 * candidate ids unique across jobs.
 */
export function detectRecipes(pageTexts: string[], idPrefix = "c"): DetectionResult {
  const candidates: RecipeCandidate[] = [];
  const skippedPages: number[] = [];

  pageTexts.forEach((text, index) => {
    const page = index + 1;
    if (!text || text.replace(/\s+/g, "").length < 60) {
      skippedPages.push(page);
      return;
    }
    const id = `${idPrefix}-${page}`;
    const candidate = buildCandidate(text, page, id) ?? buildHeadlessCandidate(text, page, id);
    if (candidate && candidate.confidence >= MIN_CONFIDENCE) {
      candidates.push(candidate);
    } else {
      skippedPages.push(page);
    }
  });

  return { candidates, skippedPages };
}

/** Merge candidates the user has grouped, in page order. */
export function mergeCandidates(candidates: RecipeCandidate[]): RecipeCandidate | null {
  if (!candidates.length) return null;
  const ordered = [...candidates].sort((a, b) => a.pages[0] - b.pages[0]);
  const first = ordered[0];
  if (ordered.length === 1) return first;

  return {
    ...first,
    pages: ordered.flatMap((c) => c.pages).sort((a, b) => a - b),
    ingredients: ordered.flatMap((c) => c.ingredients),
    instructions: ordered.flatMap((c) => c.instructions),
    notes: ordered.flatMap((c) => c.notes),
    confidence: Math.min(...ordered.map((c) => c.confidence)),
    warnings: [...new Set(ordered.flatMap((c) => c.warnings))],
  };
}
