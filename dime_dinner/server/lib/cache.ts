/** Tiny in-memory TTL cache + polite per-host rate limiter. */

type Entry<T> = { value: T; expires: number };

export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();
  constructor(private ttlMs: number, private maxEntries = 200) {}

  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, ttlMs = this.ttlMs): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}

const lastRequestAt = new Map<string, number>();
const windowCounts = new Map<string, { count: number; resetAt: number }>();

export class RateLimited extends Error {
  status = 429;
}

/**
 * Space out outbound requests to a host and cap them per minute so the add-on
 * is never mistaken for a crawler.
 */
export async function politeGate(host: string, minGapMs = 1200, maxPerMinute = 20): Promise<void> {
  const now = Date.now();
  const win = windowCounts.get(host);
  if (!win || win.resetAt < now) {
    windowCounts.set(host, { count: 1, resetAt: now + 60_000 });
  } else {
    if (win.count >= maxPerMinute) {
      throw new RateLimited(`Too many requests to ${host} right now — try again in a moment.`);
    }
    win.count += 1;
  }
  const last = lastRequestAt.get(host) ?? 0;
  const wait = last + minGapMs - now;
  lastRequestAt.set(host, Math.max(now, last + minGapMs));
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 3000)));
}

export function resetRateLimiter(): void {
  lastRequestAt.clear();
  windowCounts.clear();
}
