/**
 * Terminology glossary, read from the team's Google Sheet.
 *
 * The sheet is the single source of truth and is edited by hand, so this module is
 * deliberately defensive about its shape:
 *
 *   - Language columns are resolved by HEADER NAME, not position, because columns
 *     get reordered. The key column is the exception: it has an empty header, so
 *     it's taken positionally (column A) — documented below.
 *   - Which languages exist is discovered from the header rather than hardcoded, so
 *     adding a column to the sheet is enough to support a new language, and a
 *     language that isn't there reports "no glossary" instead of "no problems".
 *
 * Cached for 15 minutes, with the last good snapshot served if a later fetch fails —
 * a Sheets outage shouldn't take the feature down. A glossary edit taking up to
 * 15 minutes to appear is fine; the feature being unavailable is not.
 */
import { logger } from "./logger.js"
import {
  getServiceAccount,
  getGoogleAccessToken,
  googleRequest,
  SCOPE_SPREADSHEETS_READONLY,
} from "./googleSheets.js"

/** The glossary sheet. Shared as "anyone with the link can view". */
const SHEET_ID = process.env.GLOSSARY_SHEET_ID || "1EcTzPsA48ZVz3ANFW6rUDC42tIbooTS4tIXeVIY_w2c"

/** Read well past the known columns so added languages are picked up automatically. */
const RANGE = "A:Z"

const CACHE_TTL_MS = 15 * 60 * 1000

/**
 * The workbook has one tab per production ("Overview", "VAL", "LOL", "MLBB MSC26"),
 * and they do NOT share a column scheme: Overview and MLBB use `eng/ara/chi/...`,
 * while VAL and LOL use locale codes `EN_US/AR_AE/ZH_CN/...`. Headers are therefore
 * normalised through this alias table rather than trusted verbatim.
 *
 * A bare range like "A:Z" resolves to the FIRST tab only, which is why every tab has
 * to be requested by name.
 */
const HEADER_ALIASES: Record<string, string> = {
  eng: "eng", en: "eng", en_us: "eng", english: "eng",
  ara: "ara", ar: "ara", ar_ae: "ara", arabic: "ara",
  chi: "chi", zh: "chi", zh_cn: "chi", chinese: "chi",
  fra: "fra", fr: "fra", fr_fr: "fra", french: "fra",
  ind: "ind", id_id: "ind", indonesian: "ind",
  fil: "fil", tl_ph: "fil", filipino: "fil",
  hin: "hin", hi_in: "hin", hindi: "hin",
}

/** Bookkeeping columns that are never a language. */
const IGNORED_HEADERS = new Set([
  "key", "identifier", "context", "notes", "note", "comment",
  "expected length", "actual length", "length",
])

/**
 * A cell that looks filled but carries no translation.
 *
 * MLBB's French column is full of "À traduire. ID2" — the sheet's own marker for
 * "not translated yet". Treating that as approved terminology would have the
 * checker rewrite correct French into a placeholder, so these are dropped.
 */
const PLACEHOLDER_TARGET =
  // Prefix match, not exact: the real values carry a trailing row id, as in
  // "À traduire. ID2". Anchoring the end here silently let all 212 of them through.
  /^\s*(à\s*traduire|a\s*traduire|to\s*translate|untranslated|not\s*translated)\b/i

/** Markers that are only placeholders when they are the entire cell. */
const PLACEHOLDER_EXACT = /^\s*(tbc|tbd|n\/?a|none|-+|\?+)\s*$/i

/** Spreadsheet error values (LOL's length columns are full of #REF!). */
const SPREADSHEET_ERROR = /^#(ref|n\/a|value|name|div\/0|num|null)/i

function isUsableTarget(value: string): boolean {
  if (!value) return false
  if (SPREADSHEET_ERROR.test(value)) return false
  if (PLACEHOLDER_TARGET.test(value)) return false
  if (PLACEHOLDER_EXACT.test(value)) return false
  return true
}

export type GlossaryEntry = {
  /** Stable identifier from column A, e.g. "agent". Used to cite the rule in the UI. */
  key: string
  /** Disambiguating note, e.g. "from Valorant". Critical for avoiding false positives. */
  context: string
  /** The English source term. */
  source: string
  /** Approved translation per column code, e.g. { ara: "شخصية", chi: "英雄" }. */
  targets: Record<string, string>
  /** Which tab it came from ("Overview", "VAL", …) — shown so provenance is visible. */
  tab: string
}

export type Glossary = {
  entries: GlossaryEntry[]
  /** Language column codes present in the sheet, excluding "eng". */
  languageColumns: string[]
  fetchedAt: number
}

type Cache = { value: Glossary; expiresAt: number }
let cache: Cache | null = null
let inFlight: Promise<Glossary> | null = null

/**
 * Parse one tab into entries. Returns [] rather than throwing when a tab has no
 * English column — a workbook can hold notes or scratch tabs, and one odd tab
 * must not take the whole glossary down.
 */
function parseTab(tab: string, rows: string[][]): GlossaryEntry[] {
  if (rows.length < 2) return []

  const header = rows[0].map((h) => (h ?? "").trim().toLowerCase())

  // Locate the columns by normalised header name.
  let sourceIndex = -1
  const languageIndices = new Map<string, number>()
  header.forEach((name, index) => {
    const code = HEADER_ALIASES[name]
    if (!code) return
    if (code === "eng") {
      // Keep the first English column; VAL repeats locale codes for length checks.
      if (sourceIndex === -1) sourceIndex = index
      return
    }
    if (!languageIndices.has(code)) languageIndices.set(code, index)
  })
  if (sourceIndex === -1) return []

  // The key/context layout differs per tab:
  //   Overview   column A is the key (blank header), plus a named "Context" column
  //   MLBB       named "Identifier" + "Context"
  //   VAL / LOL  named "KEY", and column A holds a section label ("Brackets")
  const namedKeyIndex = header.findIndex((h) => h === "key" || h === "identifier")
  const namedContextIndex = header.indexOf("context")
  const keyIndex = namedKeyIndex !== -1 ? namedKeyIndex : 0
  const contextIndex =
    namedContextIndex !== -1 ? namedContextIndex : keyIndex === 0 ? -1 : 0
  // A section label is written once and left blank on the rows beneath it, so it
  // has to be carried down. A real per-row Context column must NOT be filled this
  // way: a blank there means "no context", not "same as above".
  const forwardFillContext = contextIndex === 0 && namedContextIndex === -1

  const entries: GlossaryEntry[] = []
  let lastContext = ""

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row) continue

    const source = (row[sourceIndex] ?? "").trim()
    if (!source || SPREADSHEET_ERROR.test(source)) continue

    let context = contextIndex === -1 ? "" : (row[contextIndex] ?? "").trim()
    if (forwardFillContext) {
      if (context) lastContext = context
      else context = lastContext
    }

    const targets: Record<string, string> = {}
    for (const [code, index] of languageIndices) {
      const value = (row[index] ?? "").trim()
      if (isUsableTarget(value)) targets[code] = value
    }
    if (Object.keys(targets).length === 0) continue // nothing to check against

    // Keys are only unique within a tab, and VAL/LOL leave most of them blank, so
    // they're namespaced by tab. The key is an identifier for citing the rule, not
    // something the sheet guarantees.
    const rawKey = (row[keyIndex] ?? "").trim()
    const key = tab === "Overview" && rawKey ? rawKey : `${tab}:${rawKey || `row${r + 1}`}`

    entries.push({ key, context, source, targets, tab })
  }

  return entries
}

async function fetchGlossary(): Promise<Glossary> {
  const token = await getGoogleAccessToken(getServiceAccount(), SCOPE_SPREADSHEETS_READONLY)

  // Discover the tabs rather than hardcoding them: productions get added per event.
  const meta = await googleRequest<{ sheets?: { properties?: { title?: string } }[] }>(
    "GET",
    `spreadsheets/${encodeURIComponent(SHEET_ID)}?fields=sheets.properties.title`,
    token
  )
  const tabs = (meta.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => Boolean(t))
  if (tabs.length === 0) throw new Error("Glossary spreadsheet has no tabs.")

  // One batched call for every tab.
  const ranges = tabs.map((t) => `ranges=${encodeURIComponent(`${t}!${RANGE}`)}`).join("&")
  const response = await googleRequest<{ valueRanges?: { values?: string[][] }[] }>(
    "GET",
    `spreadsheets/${encodeURIComponent(SHEET_ID)}/values:batchGet?${ranges}`,
    token
  )
  const valueRanges = response.valueRanges ?? []

  const entries: GlossaryEntry[] = []
  const perTab: Record<string, number> = {}
  // Identical term pairs recur across productions; keep the first and move on.
  const seen = new Set<string>()

  tabs.forEach((tab, i) => {
    const parsed = parseTab(tab, valueRanges[i]?.values ?? [])
    let kept = 0
    for (const entry of parsed) {
      const fingerprint = `${entry.source.toLowerCase()}::${Object.entries(entry.targets)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([code, value]) => `${code}=${value.toLowerCase()}`)
        .join("|")}`
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      entries.push(entry)
      kept++
    }
    perTab[tab] = kept
  })

  if (entries.length === 0) throw new Error("Glossary sheet returned no usable rows.")

  const languageColumns = [...new Set(entries.flatMap((e) => Object.keys(e.targets)))].sort()

  logger.info({ action: "GLOSSARY_LOADED", tabs: perTab, entries: entries.length, languageColumns })

  return { entries, languageColumns, fetchedAt: Date.now() }
}

/**
 * Get the glossary, using the cache when warm.
 *
 * If a refresh fails but a previous snapshot exists, the stale snapshot is returned
 * and the failure logged — availability beats freshness for a termbase.
 */
export async function getGlossary(): Promise<Glossary> {
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
          action: "GLOSSARY_FETCH_FAILED_USING_STALE",
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
 * The glossary rows relevant to one target language: entries that actually have an
 * approved term in that column. Everything else is noise for this check.
 */
export function entriesForColumn(
  glossary: Glossary,
  column: string
): { key: string; context: string; source: string; target: string }[] {
  const out: { key: string; context: string; source: string; target: string }[] = []
  for (const entry of glossary.entries) {
    const target = entry.targets[column]
    if (!target) continue
    // Prefix the production so a reviewer can see a term came from another game's
    // sheet — the main reason to reject an otherwise plausible suggestion.
    const context =
      entry.tab && entry.tab !== "Overview"
        ? entry.context
          ? `${entry.tab} · ${entry.context}`
          : entry.tab
        : entry.context
    out.push({ key: entry.key, context, source: entry.source, target })
  }
  return out
}

/**
 * Turn a glossary failure into a short, actionable hint.
 *
 * The four ways this breaks in production look identical from the UI — a 503 —
 * but need completely different fixes, and the difference is only visible in the
 * server logs. Google's own messages are safe to pass on: they name the problem
 * and never contain the credentials.
 */
export function describeGlossaryFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  if (/Missing Google service-account credentials/i.test(message)) {
    return "The server has no Google credentials. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY."
  }
  if (/invalid_grant|Invalid JWT|Invalid Signature|DECODER|PEM|asn1|unsupported/i.test(message)) {
    return "The Google private key was rejected. It is likely mangled — the \\n sequences must survive as literal backslash-n, and the surrounding quotes must not be included."
  }
  if (/not valid JSON/i.test(message)) {
    return "GOOGLE_SERVICE_ACCOUNT_JSON is set but isn't valid JSON."
  }
  // Token exchange failed without a specific reason from Google. In practice this
  // is a malformed key or an email that doesn't match it — both are copy-paste
  // damage, and the raw message ("...: OK") says nothing useful.
  if (/Could not authenticate the Google service account/i.test(message)) {
    return "Google rejected the service-account sign-in. Re-copy GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY — the key must keep its literal \\n sequences and carry no surrounding quotes."
  }
  if (/permission|forbidden|403/i.test(message)) {
    return "Google refused access to the glossary sheet. Share it (view access is enough) or check the spreadsheet id."
  }
  if (/not found|404/i.test(message)) {
    return "The glossary spreadsheet was not found. Check GLOSSARY_SHEET_ID."
  }
  return message
}

/** Warm the cache at boot so the first user doesn't wait on Sheets. Never throws. */
export function warmGlossary(): void {
  getGlossary()
    .then((g) =>
      logger.info({
        action: "GLOSSARY_WARMED",
        entries: g.entries.length,
        languages: g.languageColumns.join(","),
      })
    )
    .catch((error) => logger.warn({ action: "GLOSSARY_WARM_FAILED", err: (error as Error).message }))
}
