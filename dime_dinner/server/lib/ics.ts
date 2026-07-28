/** Minimal RFC 5545 generator for the weekly meal plan. */

export type CalendarEvent = {
  uid: string;
  /** local date, YYYY-MM-DD */
  date: string;
  /** local time, HH:MM */
  time: string;
  durationMinutes: number;
  summary: string;
  description?: string;
  url?: string;
};

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function fold(line: string): string {
  if (line.length <= 73) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 73));
  rest = rest.slice(73);
  while (rest.length > 72) {
    parts.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  if (rest) parts.push(` ${rest}`);
  return parts.join("\r\n");
}

function localStamp(date: string, time: string): string {
  return `${date.replace(/-/g, "")}T${time.replace(":", "")}00`;
}

function addMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const base = Date.UTC(y, m - 1, d, hh, mm) + minutes * 60_000;
  const out = new Date(base);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${out.getUTCFullYear()}-${pad(out.getUTCMonth() + 1)}-${pad(out.getUTCDate())}`,
    time: `${pad(out.getUTCHours())}:${pad(out.getUTCMinutes())}`,
  };
}

export function buildIcs(events: CalendarEvent[], timezone: string, calendarName = "Dime Dinner meal plan"): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(
    now.getUTCHours(),
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Dime Dinner//Home Assistant Add-on//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-TIMEZONE:${escapeText(timezone)}`,
  ];

  for (const event of events) {
    const end = addMinutes(event.date, event.time, event.durationMinutes);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeText(event.uid)}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;TZID=${timezone}:${localStamp(event.date, event.time)}`);
    lines.push(`DTEND;TZID=${timezone}:${localStamp(end.date, end.time)}`);
    lines.push(`SUMMARY:${escapeText(event.summary)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.url) lines.push(`URL:${escapeText(event.url)}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
