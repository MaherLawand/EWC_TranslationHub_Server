/**
 * Liquipedia reader — player handles and team names per game.
 *
 * Liquipedia is a community wiki with STRICT API terms, and violating them earns
 * an automated IP ban for the whole Railway instance. Everything here exists to
 * stay inside them:
 *
 *   - Identifying User-Agent with a contact URL and email. A generic agent
 *     ("node-fetch", "axios") is blocked on sight.
 *   - Hard 2.5s minimum gap between requests, GLOBALLY serialised — not per
 *     caller, or two concurrent checks would burst straight through it.
 *   - Long cache (12h) with stale-on-error. Rosters change slowly; their terms
 *     explicitly ask for results to be cached "as long as possible".
 *   - Only `action=query`, never `action=parse` (that one is limited to a single
 *     request per 30 seconds).
 *
 * Content is CC-BY-SA 3.0, which REQUIRES visible attribution wherever it is
 * shown — see the credit line rendered on the checker page.
 *
 * Terms: https://liquipedia.net/api-terms-of-use
 */
import { logger } from "./logger.js"

/**
 * Identifies this app to Liquipedia. Their terms require a project name, a URL,
 * and a contact address so they can reach someone before resorting to a ban.
 */
const USER_AGENT =
  process.env.LIQUIPEDIA_USER_AGENT ||
  "EWC-Translation-Hub/1.0 (https://ewc-translations.vercel.app; maher.lawand10@gmail.com)"

/** Their documented floor is 1 request / 2s. The extra 500ms is deliberate slack. */
const MIN_REQUEST_GAP_MS = 2_500

/** Rosters move slowly; a stale name is far cheaper than a ban. */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000

/** Page titles per request. 500 is the anonymous maximum. */
const PAGE_SIZE = 500

/** Ceiling on pagination per category, so a huge wiki can't run away. */
const MAX_PAGES_PER_CATEGORY = 12

export type Roster = {
  /** Player handles, e.g. "Noone", "33". */
  players: string[]
  /** Team names, e.g. "Team Falcons". */
  teams: string[]
  fetchedAt: number
}

/**
 * Serialises every outbound request and spaces them out.
 *
 * A per-request `await sleep()` is not enough: two checks running at once would
 * each sleep and then fire simultaneously. Chaining through one promise makes the
 * gap hold across the whole process.
 */
let requestChain: Promise<unknown> = Promise.resolve()
let lastRequestAt = 0

function schedule<T>(task: () => Promise<T>): Promise<T> {
  const result = requestChain.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - Date.now())
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastRequestAt = Date.now()
    return task()
  })
  // Keep the chain alive even when a link rejects.
  requestChain = result.catch(() => undefined)
  return result
}

type CategoryResponse = {
  query?: { categorymembers?: { title?: string; ns?: number }[] }
  continue?: { cmcontinue?: string }
  error?: { info?: string }
}

async function fetchCategory(wiki: string, category: string): Promise<string[]> {
  const titles: string[] = []
  let cmcontinue: string | undefined

  for (let page = 0; page < MAX_PAGES_PER_CATEGORY; page++) {
    const params = new URLSearchParams({
      action: "query",
      list: "categorymembers",
      cmtitle: `Category:${category}`,
      cmlimit: String(PAGE_SIZE),
      cmnamespace: "0", // article namespace only — skip talk/template/user pages
      format: "json",
    })
    if (cmcontinue) params.set("cmcontinue", cmcontinue)

    const url = `https://liquipedia.net/${encodeURIComponent(wiki)}/api.php?${params}`
    const body = await schedule(async () => {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" },
        signal: AbortSignal.timeout(20_000),
      })
      if (response.status === 429) {
        throw new Error("rate limited by Liquipedia (HTTP 429)")
      }
      // Liquipedia fronts the wiki with Cloudflare, which challenges or blocks
      // datacentre IP ranges. That is the usual reason this works from a laptop
      // and fails from a cloud host with identical code.
      if (response.status === 403) {
        throw new Error(
          "HTTP 403 — Liquipedia blocked this server's IP, which commonly happens to cloud hosts"
        )
      }
      if (!response.ok) throw new Error(`Liquipedia responded HTTP ${response.status}`)
      return (await response.json()) as CategoryResponse
    })

    if (body.error?.info) throw new Error(`Liquipedia: ${body.error.info}`)

    for (const member of body.query?.categorymembers ?? []) {
      const title = (member.title ?? "").trim()
      if (title) titles.push(title)
    }

    cmcontinue = body.continue?.cmcontinue
    if (!cmcontinue) break
  }

  return titles
}

/**
 * Wiki titles carry disambiguators that are not part of the name as spoken or
 * written in a subtitle: "Zai (American player)", "Faith/Results". Strip both, and
 * drop anything that is clearly not a name.
 */
function cleanTitle(title: string): string | null {
  if (title.includes("/")) return null // subpage: /Results, /Matches
  const withoutParens = title.replace(/\s*\([^)]*\)\s*$/u, "").trim()
  if (!withoutParens) return null
  if (withoutParens.length > 40) return null
  // Category listings include index and meta pages.
  if (/^(list of|category:|template:|portal:)/i.test(withoutParens)) return null
  return withoutParens
}

function dedupe(titles: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const title of titles) {
    const clean = cleanTitle(title)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out
}

type CacheEntry = { value: Roster; expiresAt: number }
const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<Roster>>()

async function fetchRoster(wiki: string): Promise<Roster> {
  const [players, teams] = [
    await fetchCategory(wiki, "Players"),
    await fetchCategory(wiki, "Teams"),
  ]
  const roster: Roster = {
    players: dedupe(players),
    teams: dedupe(teams),
    fetchedAt: Date.now(),
  }
  logger.info({
    action: "LIQUIPEDIA_ROSTER_FETCHED",
    wiki,
    players: roster.players.length,
    teams: roster.teams.length,
  })
  return roster
}

/**
 * Roster for one Liquipedia wiki, cached.
 *
 * Serves a stale snapshot if a refresh fails: a name list from this morning is
 * still overwhelmingly correct, and the alternative is failing the user's check.
 */
export async function getRoster(wiki: string): Promise<Roster> {
  const cached = cache.get(wiki)
  if (cached && Date.now() < cached.expiresAt) return cached.value

  const existing = inFlight.get(wiki)
  if (existing) return existing

  const promise = fetchRoster(wiki)
    .then((value) => {
      cache.set(wiki, { value, expiresAt: Date.now() + CACHE_TTL_MS })
      return value
    })
    .catch((error) => {
      if (cached) {
        logger.warn({
          action: "LIQUIPEDIA_FETCH_FAILED_USING_STALE",
          wiki,
          err: (error as Error).message,
          ageMs: Date.now() - cached.value.fetchedAt,
        })
        return cached.value
      }
      throw error
    })
    .finally(() => {
      inFlight.delete(wiki)
    })

  inFlight.set(wiki, promise)
  return promise
}
