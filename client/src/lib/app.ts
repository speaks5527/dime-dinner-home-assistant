import { apiRequest } from "./queryClient";
import type { GroceryResponse } from "@shared/schema";

/* ------------------------------- week math ------------------------------- */

const pad = (n: number) => String(n).padStart(2, "0");

export function toISODate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Monday of the week containing `date`. */
export function weekStartOf(date = new Date()): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - offset);
  return toISODate(d);
}

export function shiftWeek(weekStart: string, weeks: number): string {
  const [y, m, d] = weekStart.split("-").map(Number);
  const date = new Date(y, m - 1, d + weeks * 7);
  return toISODate(date);
}

export function dayDate(weekStart: string, day: number): Date {
  const [y, m, d] = weekStart.split("-").map(Number);
  return new Date(y, m - 1, d + day);
}

export function formatWeekRange(weekStart: string): string {
  const start = dayDate(weekStart, 0);
  const end = dayDate(weekStart, 6);
  const fmt = (date: Date, withYear = false) =>
    date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" } : {}),
    });
  return `${fmt(start)} – ${fmt(end, true)}`;
}

export function formatMinutes(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}

export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/* -------------------------------- mutate --------------------------------- */

export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await apiRequest("POST", url, body ?? {});
  return (await res.json()) as T;
}

export async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await apiRequest("PATCH", url, body);
  return (await res.json()) as T;
}

export async function deleteJson<T>(url: string): Promise<T> {
  const res = await apiRequest("DELETE", url);
  return (await res.json()) as T;
}

/* ------------------------------- exporting -------------------------------- */

export function groceryToText(data: GroceryResponse): string {
  const byAisle = new Map<string, string[]>();
  for (const line of data.lines) {
    const list = byAisle.get(line.aisle) ?? [];
    list.push(`${line.display ? `${line.display} ` : ""}${line.name}`.trim());
    byAisle.set(line.aisle, list);
  }
  const blocks: string[] = [`Grocery list — week of ${data.weekStart}`, ""];
  for (const [aisle, items] of byAisle) {
    blocks.push(aisle.toUpperCase());
    for (const item of items) blocks.push(`- ${item}`);
    blocks.push("");
  }
  if (data.manual.length) {
    blocks.push("OTHER");
    for (const item of data.manual) blocks.push(`- ${item.text}`);
    blocks.push("");
  }
  return blocks.join("\n").trim();
}

export function groceryToCsv(data: GroceryResponse): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = [["Aisle", "Item", "Amount", "Checked", "Pantry"].map(escape).join(",")];
  for (const line of data.lines) {
    rows.push(
      [line.aisle, line.name, line.display, line.checked ? "yes" : "no", line.pantry ? line.pantry.status : ""]
        .map(escape)
        .join(","),
    );
  }
  for (const item of data.manual) {
    rows.push(["Other", item.text, "", item.checked ? "yes" : "no", ""].map(escape).join(","));
  }
  return rows.join("\r\n");
}

export function downloadFile(filename: string, contents: string, mime: string): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Clipboard with a textarea fallback (clipboard API is restricted in iframes). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** Print a specific element by tagging it, then restoring the page. */
export function printElement(elementId: string): void {
  const node = document.getElementById(elementId);
  if (!node) return;
  document.body.classList.add("printing");
  node.classList.add("print-area");
  window.print();
  setTimeout(() => {
    node.classList.remove("print-area");
    document.body.classList.remove("printing");
  }, 500);
}
