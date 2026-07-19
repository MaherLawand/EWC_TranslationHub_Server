/**
 * Liquipedia reader — player handles and team names per game.
 *
 * Liquipedia is a community wiki with STRICT API terms, and violating them earns
 * an automated IP ban for the whole Railway instance. Everything here exists to
 * stay inside them:
 *
 *   - Identifying User-Agent with a contact URL and email. A generic agent
 *     ("node-fetch", "axios") is blocked on sight.
 *   - Hard 3s minimum gap between requests, GLOBALLY serialised — not per
 *     caller, or two concurrent checks would burst straight through it.
 *   - 24h cache, persisted to DISK so restarts and redeploys don't refetch, with
 *     stale-on-error. Their terms explicitly ask for results to be cached "as
 *     long as possible".
 *   - A cooldown honouring Retry-After after a 429, so being throttled doesn't
 *     turn into a retry loop.
 *   - Only `action=query`, never `action=parse` (that one is limited to a single
 *     request per 30 seconds).
 *
 * SCOPE: rosters are narrowed to the competitors linked from the event page (see
 * EVENT_PAGE), not the whole wiki. For Dota 2 that is 130 players rather than
 * 1287 — a much smaller target for the fuzzy spelling match, and far fewer
 * chances to "correct" a word into an unrelated retired player's handle.
 *
 * Content is CC-BY-SA 3.0, which REQUIRES visible attribution wherever it is
 * shown — see the credit line rendered on the checker page.
 *
 * Terms: https://liquipedia.net/api-terms-of-use
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { logger } from "./logger.js"

/**
 * Identifies this app to Liquipedia. Their terms require a project name, a URL,
 * and a contact address so they can reach someone before resorting to a ban.
 */
const USER_AGENT =
  process.env.LIQUIPEDIA_USER_AGENT ||
  "EWC-Translation-Hub/1.0 (https://ewc-translations.vercel.app; maher.lawand10@gmail.com)"

/** Their documented floor is 1 request / 2s. The extra second is deliberate slack. */
const MIN_REQUEST_GAP_MS = 3_000

/** Rosters move slowly; a stale name is far cheaper than a ban. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Where the roster cache is persisted between processes.
 *
 * The in-memory cache alone is not enough. Every CLI run, every dev restart and
 * every redeploy starts a cold process, and a cold fetch is ~10 requests per
 * game — which is how this got rate limited in the first place. Writing the
 * roster to disk means a restart costs nothing.
 *
 * The directory is ephemeral on Railway, which is fine: worst case it behaves
 * exactly like the old in-memory-only cache.
 */
const CACHE_DIR = process.env.LIQUIPEDIA_CACHE_DIR || join(tmpdir(), "ewc-liquipedia-cache")

/** Cooldown applied when Liquipedia says we are going too fast. */
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000

/**
 * The tournament page used to scope rosters to actual participants.
 *
 * Every Liquipedia wiki hosts the event at the same title, so one setting covers
 * all games. Update it for next year's event.
 */
const EVENT_PAGE = process.env.LIQUIPEDIA_EVENT_PAGE || "Esports World Cup/2026"

/**
 * Below this many teams, the scoped roster is treated as a failed lookup and the
 * full wiki roster is used instead. A renamed or not-yet-created event page must
 * degrade to broader checking, never to none.
 */
const MIN_SCOPED_TEAMS = 5

/** Page titles per request. 500 is the anonymous maximum. */
const PAGE_SIZE = 500

/** Ceiling on pagination per category, so a huge wiki can't run away. */
const MAX_PAGES_PER_CATEGORY = 12

export type Roster = {
  /** Player handles, e.g. "Noone", "33". */
  players: string[]
  /** Team names, e.g. "Team Falcons". */
  teams: string[]
  /**
   * The event page these were narrowed to, or null when the whole wiki is used.
   * Surfaced so the UI can say which set a name was checked against.
   */
  scopedTo: string | null
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

/**
 * Set when Liquipedia rate limits us. Until it passes, requests fail immediately
 * rather than being sent.
 *
 * Without this, being throttled makes things worse: the roster fetch fails, the
 * cache stays empty, and the next check starts the whole ~10-request sequence
 * again. Backing off is the only way out of that loop.
 */
let blockedUntil = 0

export class LiquipediaRateLimited extends Error {
  constructor(public readonly retryAt: number) {
    const minutes = Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000))
    super(`Liquipedia rate limit reached — name checking resumes in about ${minutes} minute(s)`)
    this.name = "LiquipediaRateLimited"
  }
}

function schedule<T>(task: () => Promise<T>): Promise<T> {
  const result = requestChain.then(async () => {
    if (Date.now() < blockedUntil) throw new LiquipediaRateLimited(blockedUntil)
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - Date.now())
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastRequestAt = Date.now()
    return task()
  })
  // Keep the chain alive even when a link rejects.
  requestChain = result.catch(() => undefined)
  return result
}

/** Honour Retry-After when present; otherwise back off for a fixed window. */
function beginCooldown(retryAfterHeader: string | null): void {
  const seconds = Number(retryAfterHeader)
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_COOLDOWN_MS
  blockedUntil = Date.now() + ms
  logger.warn({
    action: "LIQUIPEDIA_RATE_LIMITED",
    cooldownMs: ms,
    retryAt: new Date(blockedUntil).toISOString(),
  })
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
        beginCooldown(response.headers.get("retry-after"))
        throw new LiquipediaRateLimited(blockedUntil)
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

type LinksResponse = {
  query?: { pages?: Record<string, { missing?: string; links?: { title?: string }[] }> }
  continue?: { plcontinue?: string }
  error?: { info?: string }
}

/**
 * Every article linked from the event page.
 *
 * Intersecting these with the wiki's Players and Teams categories yields the
 * competitors actually at the tournament, which is a far tighter set than the
 * whole game: for Dota 2 it is 130 players instead of 1287, and 41 teams instead
 * of 960. That matters because the roster is used for fuzzy spelling matches —
 * a smaller, relevant set means far fewer chances to "correct" an ordinary word
 * into some retired player's handle.
 *
 * Returns null when the page does not exist, so the caller can fall back.
 */
async function fetchEventLinks(wiki: string, title: string): Promise<string[] | null> {
  const titles: string[] = []
  let plcontinue: string | undefined

  for (let page = 0; page < 6; page++) {
    const params = new URLSearchParams({
      action: "query",
      prop: "links",
      titles: title,
      plnamespace: "0",
      pllimit: String(PAGE_SIZE),
      format: "json",
    })
    if (plcontinue) params.set("plcontinue", plcontinue)

    const url = `https://liquipedia.net/${encodeURIComponent(wiki)}/api.php?${params}`
    const body = await schedule(async () => {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" },
        signal: AbortSignal.timeout(20_000),
      })
      if (response.status === 429) {
        beginCooldown(response.headers.get("retry-after"))
        throw new LiquipediaRateLimited(blockedUntil)
      }
      if (!response.ok) throw new Error(`Liquipedia responded HTTP ${response.status}`)
      return (await response.json()) as LinksResponse
    })

    const entry = Object.values(body.query?.pages ?? {})[0]
    if (!entry || entry.missing !== undefined) return null

    for (const link of entry.links ?? []) {
      if (link.title) titles.push(link.title)
    }

    plcontinue = body.continue?.plcontinue
    if (!plcontinue) break
  }

  return titles
}

type CacheEntry = { value: Roster; expiresAt: number }
const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<Roster>>()

function cacheFile(wiki: string): string {
  return join(CACHE_DIR, `${wiki.replace(/[^a-z0-9]/gi, "_")}.json`)
}

/** Load a previously persisted roster. Any failure just means "no cache". */
function readDiskCache(wiki: string): Roster | null {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(wiki), "utf8")) as Roster
    if (!Array.isArray(parsed.players) || !Array.isArray(parsed.teams)) return null
    return parsed
  } catch {
    return null
  }
}

function writeDiskCache(wiki: string, roster: Roster): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(cacheFile(wiki), JSON.stringify(roster))
  } catch (error) {
    // A cache that can't be written is a performance problem, not a failure.
    logger.warn({ action: "LIQUIPEDIA_CACHE_WRITE_FAILED", wiki, err: (error as Error).message })
  }
}

async function fetchRoster(wiki: string): Promise<Roster> {
  const allPlayers = dedupe(await fetchCategory(wiki, "Players"))
  const allTeams = dedupe(await fetchCategory(wiki, "Teams"))

  // Narrow to the competitors actually at the event. The categories give every
  // player and org the wiki has ever had, most of whom are irrelevant to a
  // broadcast of this tournament and only add chances for a wrong match.
  let players = allPlayers
  let teams = allTeams
  let scopedTo: string | null = null

  try {
    const linked = await fetchEventLinks(wiki, EVENT_PAGE)
    if (linked) {
      const linkedSet = new Set(linked.map((title) => title.toLowerCase()))
      const scopedPlayers = allPlayers.filter((name) => linkedSet.has(name.toLowerCase()))
      const scopedTeams = allTeams.filter((name) => linkedSet.has(name.toLowerCase()))
      // Too few teams means the page exists but isn't a participant list yet —
      // early in an event, or a layout change. Broader checking beats none.
      if (scopedTeams.length >= MIN_SCOPED_TEAMS) {
        players = scopedPlayers
        teams = scopedTeams
        scopedTo = EVENT_PAGE
      }
    }
  } catch (error) {
    if (error instanceof LiquipediaRateLimited) throw error
    // Scoping is an optimisation; the full roster is still perfectly usable.
    logger.warn({ action: "LIQUIPEDIA_EVENT_SCOPE_FAILED", wiki, err: (error as Error).message })
  }

  const roster: Roster = { players, teams, scopedTo, fetchedAt: Date.now() }
  logger.info({
    action: "LIQUIPEDIA_ROSTER_FETCHED",
    wiki,
    scopedTo: scopedTo ?? "entire wiki",
    players: roster.players.length,
    teams: roster.teams.length,
    ofAllPlayers: allPlayers.length,
    ofAllTeams: allTeams.length,
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

  // Warm memory from disk before considering a fetch — this is what makes a
  // restart free rather than another ~10 requests.
  const onDisk = readDiskCache(wiki)
  if (onDisk && Date.now() - onDisk.fetchedAt < CACHE_TTL_MS) {
    cache.set(wiki, { value: onDisk, expiresAt: onDisk.fetchedAt + CACHE_TTL_MS })
    return onDisk
  }

  // In cooldown: serve whatever we have rather than making the throttling worse.
  if (Date.now() < blockedUntil) {
    const stale = cached?.value ?? onDisk
    if (stale) {
      logger.warn({ action: "LIQUIPEDIA_COOLDOWN_USING_STALE", wiki, ageMs: Date.now() - stale.fetchedAt })
      return stale
    }
    throw new LiquipediaRateLimited(blockedUntil)
  }

  const promise = fetchRoster(wiki)
    .then((value) => {
      cache.set(wiki, { value, expiresAt: Date.now() + CACHE_TTL_MS })
      writeDiskCache(wiki, value)
      return value
    })
    .catch((error) => {
      // An expired disk copy still beats no name checking at all.
      if (!cached && onDisk) {
        logger.warn({ action: "LIQUIPEDIA_FETCH_FAILED_USING_DISK", wiki, err: (error as Error).message })
        cache.set(wiki, { value: onDisk, expiresAt: Date.now() + 60 * 60 * 1000 })
        return onDisk
      }
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
