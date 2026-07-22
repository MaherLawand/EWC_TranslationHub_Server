/**
 * High-priority Arabic glossary — a SECOND sheet that overrides the main one.
 *
 * The team maintains a separate Arabic termbase that takes precedence: where an
 * English term appears in both, this sheet's translation wins; terms only here
 * are added. It changes nothing for any other language.
 *
 * Layout differs from the main glossary and is fixed by column position, not
 * header name: English in column A, Arabic in column D (columns B/C are spacers,
 * a "Note" column may follow). One workbook, several tabs, all the same shape.
 *
 * Cached like the main glossary — 15-min TTL, stale-on-error — and applied as an
 * overlay at read time, so it stays a pure lookup with no bearing on the checker's
 * logic.
 */
import { logger } from "./logger.js"
import {
  getServiceAccount,
  getGoogleAccessToken,
  googleRequest,
  SCOPE_SPREADSHEETS_READONLY,
} from "./googleSheets.js"
import type { GlossaryRow } from "./glossaryCheck.js"

const SHEET_ID =
  process.env.ARABIC_PRIORITY_SHEET_ID || "14imXHabO0EkPIuUntJ7k_wA-U7ApTt3OU3nW-1LDMoI"

const RANGE = "A:Z"
const CACHE_TTL_MS = 15 * 60 * 1000

/** English in A, Arabic in D. */
const ENGLISH_COL = 0
const ARABIC_COL = 3

export type PriorityEntry = { source: string; target: string; tab: string }
export type ArabicPriority = {
  entries: PriorityEntry[]
  /** lowercased English source → entry, for O(1) override lookup. */
  bySource: Map<string, PriorityEntry>
  fetchedAt: number
}

type Cache = { value: ArabicPriority; expiresAt: number }
let cache: Cache | null = null
let inFlight: Promise<ArabicPriority> | null = null

/** A terminology term shouldn't span lines; collapse any internal whitespace. */
function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

async function fetchPriority(): Promise<ArabicPriority> {
  const token = await getGoogleAccessToken(getServiceAccount(), SCOPE_SPREADSHEETS_READONLY)

  const meta = await googleRequest<{ sheets?: { properties?: { title?: string } }[] }>(
    "GET",
    `spreadsheets/${encodeURIComponent(SHEET_ID)}?fields=sheets.properties.title`,
    token
  )
  const tabs = (meta.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => Boolean(t))
  if (tabs.length === 0) throw new Error("Arabic priority sheet has no tabs.")

  const ranges = tabs.map((t) => `ranges=${encodeURIComponent(`${t}!${RANGE}`)}`).join("&")
  const response = await googleRequest<{ valueRanges?: { values?: string[][] }[] }>(
    "GET",
    `spreadsheets/${encodeURIComponent(SHEET_ID)}/values:batchGet?${ranges}`,
    token
  )
  const valueRanges = response.valueRanges ?? []

  const entries: PriorityEntry[] = []
  const bySource = new Map<string, PriorityEntry>()

  tabs.forEach((tab, i) => {
    const rows = valueRanges[i]?.values ?? []
    // Skip the header row.
    for (let r = 1; r < rows.length; r++) {
      const rawSource = clean(rows[r]?.[ENGLISH_COL] ?? "")
      const target = clean(rows[r]?.[ARABIC_COL] ?? "")
      if (!rawSource || !target) continue

      // One cell can list several English forms of the same term, separated by a
      // slash ("Esports World Cup/EWC", "Riyadh City / RC"). Each form maps to
      // the same Arabic translation. Only the English side is split — the Arabic
      // may legitimately contain a slash.
      const forms = rawSource
        .split("/")
        .map((f) => f.trim())
        .filter(Boolean)

      for (const source of forms) {
        const key = source.toLowerCase()
        // First occurrence wins if a term recurs across tabs.
        if (bySource.has(key)) continue
        const entry: PriorityEntry = { source, target, tab }
        entries.push(entry)
        bySource.set(key, entry)
      }
    }
  })

  if (entries.length === 0) throw new Error("Arabic priority sheet returned no usable rows.")

  logger.info({ action: "ARABIC_PRIORITY_LOADED", tabs: tabs.length, entries: entries.length })
  return { entries, bySource, fetchedAt: Date.now() }
}

/** Get the priority glossary, serving a stale snapshot if a refresh fails. */
export async function getArabicPriority(): Promise<ArabicPriority> {
  if (cache && Date.now() < cache.expiresAt) return cache.value
  if (inFlight) return inFlight

  inFlight = fetchPriority()
    .then((value) => {
      cache = { value, expiresAt: Date.now() + CACHE_TTL_MS }
      return value
    })
    .catch((error) => {
      if (cache) {
        logger.warn({
          action: "ARABIC_PRIORITY_FETCH_FAILED_USING_STALE",
          err: (error as Error).message,
          ageMs: Date.now() - cache.value.fetchedAt,
        })
        return cache.value
      }
      throw error
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

/**
 * Overlay the priority glossary onto the main Arabic rows.
 *
 *   - A main row whose English source is in the priority sheet keeps its key and
 *     context but takes the priority translation.
 *   - Priority terms with no main-glossary row are appended.
 *
 * Priority rows are marked in their context so a reviewer can see the source.
 * Never throws — if the priority sheet is unreachable the caller passes the
 * unmodified rows, so Arabic checking degrades to the main glossary alone.
 */
export function applyArabicPriority(
  mainRows: GlossaryRow[],
  priority: ArabicPriority
): GlossaryRow[] {
  const PRIORITY_NOTE = "Priority Arabic glossary"
  const used = new Set<string>()

  const overlaid = mainRows.map((row) => {
    const hit = priority.bySource.get(row.source.trim().toLowerCase())
    if (!hit || hit.target === row.target) return row
    used.add(hit.source.toLowerCase())
    return {
      ...row,
      target: hit.target,
      context: row.context ? `${PRIORITY_NOTE} · ${row.context}` : PRIORITY_NOTE,
      priority: true,
    }
  })

  // Mark the sources that already existed (even where the translation matched,
  // so a duplicate row isn't appended).
  for (const row of mainRows) used.add(row.source.trim().toLowerCase())

  const additions: GlossaryRow[] = []
  for (const entry of priority.entries) {
    if (used.has(entry.source.toLowerCase())) continue
    additions.push({
      key: `arpri:${entry.source}`,
      context: entry.tab ? `${PRIORITY_NOTE} · ${entry.tab}` : PRIORITY_NOTE,
      source: entry.source,
      target: entry.target,
      priority: true,
    })
  }

  return [...overlaid, ...additions]
}

/** Warm at boot so the first Arabic check doesn't wait on Sheets. Never throws. */
export function warmArabicPriority(): void {
  getArabicPriority()
    .then((p) => logger.info({ action: "ARABIC_PRIORITY_WARMED", entries: p.entries.length }))
    .catch((error) =>
      logger.warn({ action: "ARABIC_PRIORITY_WARM_FAILED", err: (error as Error).message })
    )
}
