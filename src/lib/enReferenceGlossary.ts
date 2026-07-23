/**
 * English → Arabic/French reference glossary.
 *
 * A standalone termbase (separate sheet from the main glossary) used by the SRT
 * checker's "EN reference" tab: a translator drops in an ENGLISH subtitle, and we
 * surface every glossary term found in it together with its approved Arabic or
 * French translation. It is a lookup aid, not a correction pass — nothing is
 * changed, nothing is exported.
 *
 * Layout is fixed by column position: EN in A, AR in B, FR in C. One tab today,
 * but read across every tab so the sheet can be split into category tabs later
 * without any code change.
 *
 * DUPLICATES: the sheet is append-only and lower rows are the authoritative ones,
 * so when a term repeats the LAST occurrence wins.
 *
 * Cached 15 min, stale-on-error, warmed at boot — same contract as the other
 * glossaries.
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
  process.env.EN_REFERENCE_SHEET_ID || "1Oo7wK8tLJbuJUtFgOCz6tpo1h3v0YFKSuEUXPO3f-ys"

const RANGE = "A:C"
const CACHE_TTL_MS = 15 * 60 * 1000

const EN_COL = 0
const AR_COL = 1
const FR_COL = 2

/**
 * Tabs the loader ignores. The glossary is organised into category tabs; the
 * "Duplicates (old)" tab holds superseded rows kept only for reference and must
 * NOT feed the checker, or removed duplicates would come back.
 */
const EXCLUDED_TABS = new Set(["duplicates (old)", "duplicates"])

export type EnReferenceTarget = "ar" | "fr"

export type EnReferenceEntry = { source: string; ar: string; fr: string }
export type EnReferenceGlossary = {
  entries: EnReferenceEntry[]
  /** lowercased English → entry, last-occurrence-wins. */
  bySource: Map<string, EnReferenceEntry>
  fetchedAt: number
}

type Cache = { value: EnReferenceGlossary; expiresAt: number }
let cache: Cache | null = null
let inFlight: Promise<EnReferenceGlossary> | null = null

/** A term shouldn't span lines; collapse any internal whitespace. */
function clean(value: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim()
}

async function fetchGlossary(): Promise<EnReferenceGlossary> {
  const token = await getGoogleAccessToken(getServiceAccount(), SCOPE_SPREADSHEETS_READONLY)

  const meta = await googleRequest<{ sheets?: { properties?: { title?: string } }[] }>(
    "GET",
    `spreadsheets/${encodeURIComponent(SHEET_ID)}?fields=sheets.properties.title`,
    token
  )
  const tabs = (meta.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => Boolean(t))
    .filter((t) => !EXCLUDED_TABS.has(t.trim().toLowerCase()))
  if (tabs.length === 0) throw new Error("EN reference sheet has no usable tabs.")

  const ranges = tabs.map((t) => `ranges=${encodeURIComponent(`${t}!${RANGE}`)}`).join("&")
  const response = await googleRequest<{ valueRanges?: { values?: string[][] }[] }>(
    "GET",
    `spreadsheets/${encodeURIComponent(SHEET_ID)}/values:batchGet?${ranges}`,
    token
  )
  const valueRanges = response.valueRanges ?? []

  const bySource = new Map<string, EnReferenceEntry>()

  valueRanges.forEach((vr) => {
    const rows = vr.values ?? []
    for (let r = 1; r < rows.length; r++) {
      const source = clean(rows[r]?.[EN_COL] ?? "")
      const ar = clean(rows[r]?.[AR_COL] ?? "")
      const fr = clean(rows[r]?.[FR_COL] ?? "")
      if (!source || (!ar && !fr)) continue
      // Last occurrence wins — lower rows are authoritative.
      bySource.set(source.toLowerCase(), { source, ar, fr })
    }
  })

  const entries = [...bySource.values()]
  if (entries.length === 0) throw new Error("EN reference sheet returned no usable rows.")

  logger.info({ action: "EN_REFERENCE_LOADED", tabs: tabs.length, entries: entries.length })
  return { entries, bySource, fetchedAt: Date.now() }
}

export async function getEnReference(): Promise<EnReferenceGlossary> {
  if (cache && Date.now() < cache.expiresAt) return cache.value
  if (inFlight) return inFlight

  inFlight = fetchGlossary()
    .then((value) => {
      cache = { value, expiresAt: Date.now() + CACHE_TTL_MS }
      return value
    })
    .catch((error) => {
      if (cache) {
        logger.warn({
          action: "EN_REFERENCE_FETCH_FAILED_USING_STALE",
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
 * Rows for one target language, in the {key, context, source, target} shape the
 * deterministic scanner (scanLiteralTerms) consumes. Terms with no translation in
 * the requested language are omitted.
 */
export function entriesForTarget(
  glossary: EnReferenceGlossary,
  target: EnReferenceTarget
): GlossaryRow[] {
  const out: GlossaryRow[] = []
  for (const entry of glossary.entries) {
    const value = target === "ar" ? entry.ar : entry.fr
    if (!value) continue
    out.push({ key: entry.source, context: "", source: entry.source, target: value })
  }
  return out
}

/** Warm at boot so the first reference check doesn't wait on Sheets. Never throws. */
export function warmEnReference(): void {
  getEnReference()
    .then((g) => logger.info({ action: "EN_REFERENCE_WARMED", entries: g.entries.length }))
    .catch((error) =>
      logger.warn({ action: "EN_REFERENCE_WARM_FAILED", err: (error as Error).message })
    )
}
