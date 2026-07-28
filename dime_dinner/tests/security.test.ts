import { describe, expect, it } from "vitest";
import { FetchRejected, isBlockedAddress, validateUrlShape, assertPublicHost } from "../server/lib/safeFetch";
import { buildIcs } from "../server/lib/ics";

describe("SSRF protection", () => {
  it("blocks loopback, private, link-local and metadata addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "127.10.0.1",
      "10.0.0.5",
      "172.16.4.1",
      "172.31.255.254",
      "192.168.1.10",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "104.18.32.7", "2606:4700::1111"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("rejects non-http(s) schemes", () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com", "javascript:alert(1)"]) {
      expect(() => validateUrlShape(url)).toThrow(FetchRejected);
    }
  });

  it("rejects internal hostnames and raw private IPs", () => {
    for (const url of [
      "http://localhost/recipe",
      "http://127.0.0.1:8123/recipe",
      "http://192.168.1.4/recipe",
      "http://homeassistant/recipe",
      "http://supervisor/core/api",
      "http://printer.local/x",
      "http://thing.internal/x",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      expect(() => validateUrlShape(url), url).toThrow(FetchRejected);
    }
  });

  it("rejects embedded credentials and odd ports", () => {
    expect(() => validateUrlShape("http://user:pass@example.com/r")).toThrow(FetchRejected);
    expect(() => validateUrlShape("http://example.com:8123/r")).toThrow(FetchRejected);
  });

  it("accepts a normal public recipe URL", () => {
    const url = validateUrlShape("https://www.eatingonadime.com/crockpot-chicken-and-noodles/");
    expect(url.hostname).toBe("www.eatingonadime.com");
    expect(validateUrlShape("https://www.allrecipes.com/recipe/12345/").protocol).toBe("https:");
  });

  it("rejects hostnames that resolve to private space", async () => {
    await expect(assertPublicHost("localtest.me")).rejects.toBeInstanceOf(FetchRejected);
  });
});

describe("ics export", () => {
  it("produces a valid calendar with local times", () => {
    const ics = buildIcs(
      [
        {
          uid: "a@dime-dinner",
          date: "2026-07-27",
          time: "18:00",
          durationMinutes: 60,
          summary: "Dinner: Crockpot Chicken; Noodles",
          description: "Source: https://example.com",
        },
      ],
      "America/New_York",
    );
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART;TZID=America/New_York:20260727T180000");
    expect(ics).toContain("DTEND;TZID=America/New_York:20260727T190000");
    expect(ics).toContain("SUMMARY:Dinner: Crockpot Chicken\\; Noodles");
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics).toContain("\r\n");
  });
});
