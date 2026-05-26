/**
 * Simple in-memory TTL cache for orders list and counts.
 *
 * Purpose: under burst load (many users hitting the same endpoint
 * simultaneously), serve all of them from a single DB result instead
 * of running N identical heavy JOIN queries.
 *
 * TTLs are intentionally short (3–5s) so stale data is never visible
 * for more than a few seconds. Writes (create/update/delete) call
 * invalidate() immediately so the next request always hits the DB fresh.
 */

interface CacheEntry {
  value: unknown
  expires: number
}

class OrdersCache {
  private store = new Map<string, CacheEntry>()

  get(key: string): unknown | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expires) {
      this.store.delete(key)
      return null
    }
    return entry.value
  }

  set(key: string, value: unknown, ttlMs: number): void {
    this.store.set(key, { value, expires: Date.now() + ttlMs })
  }

  /** Clear all cached orders and counts (call after any write) */
  invalidate(): void {
    this.store.clear()
  }
}

export const ordersCache = new OrdersCache()
