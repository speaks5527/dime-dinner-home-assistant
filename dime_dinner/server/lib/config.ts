/**
 * Effective configuration = Home Assistant add-on options (/data/options.json)
 * overlaid by anything the user set in the in-app Settings tab.
 */
import fs from "node:fs";
import { storage } from "../storage";
import type { KrogerConfig } from "./kroger";

export type AddonOptions = {
  kroger_enabled?: boolean;
  kroger_client_id?: string;
  kroger_client_secret?: string;
  kroger_zip?: string;
  kroger_location_id?: string;
  lunch_time?: string;
  dinner_time?: string;
  timezone?: string;
};

let cachedOptions: AddonOptions | null = null;
let cachedAt = 0;

export function readAddonOptions(): AddonOptions {
  if (cachedOptions && Date.now() - cachedAt < 30_000) return cachedOptions;
  const path = process.env.DIME_DINNER_OPTIONS ?? "/data/options.json";
  try {
    cachedOptions = JSON.parse(fs.readFileSync(path, "utf-8")) as AddonOptions;
  } catch {
    cachedOptions = {};
  }
  cachedAt = Date.now();
  return cachedOptions;
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export function krogerConfig(): KrogerConfig & { managedByAddonOptions: boolean } {
  const options = readAddonOptions();
  const fromOptions =
    options.kroger_enabled === true ||
    !!nonEmpty(options.kroger_client_id) ||
    !!nonEmpty(options.kroger_client_secret);

  const enabled =
    options.kroger_enabled === true || storage.getSetting("kroger.enabled") === "true";

  return {
    enabled,
    clientId: nonEmpty(options.kroger_client_id) ?? storage.getSetting("kroger.clientId") ?? "",
    clientSecret:
      nonEmpty(options.kroger_client_secret) ?? storage.getSetting("kroger.clientSecret") ?? "",
    zip: nonEmpty(options.kroger_zip) ?? storage.getSetting("kroger.zip") ?? "",
    locationId: nonEmpty(options.kroger_location_id) ?? storage.getSetting("kroger.locationId") ?? "",
    managedByAddonOptions: fromOptions,
  };
}

export type MealTimes = { lunch: string; dinner: string; timezone: string };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function mealTimes(): MealTimes {
  const options = readAddonOptions();
  const lunch = storage.getSetting("meal.lunchTime") ?? nonEmpty(options.lunch_time) ?? "12:00";
  const dinner = storage.getSetting("meal.dinnerTime") ?? nonEmpty(options.dinner_time) ?? "18:00";
  const timezone =
    storage.getSetting("app.timezone") ??
    nonEmpty(options.timezone) ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    "UTC";
  return {
    lunch: TIME_RE.test(lunch) ? lunch : "12:00",
    dinner: TIME_RE.test(dinner) ? dinner : "18:00",
    timezone,
  };
}

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

export function resetConfigCache(): void {
  cachedOptions = null;
  cachedAt = 0;
}
