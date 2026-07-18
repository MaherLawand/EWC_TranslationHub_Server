/**
 * Player and team name spell-check against a Liquipedia roster.
 *
 * Entirely deterministic — no model involved. Given the Latin fragments already
 * extracted from the subtitle, each one is compared against the roster for the
 * selected game and classified:
 *
 *   exact match              -> correct; confirmed, never reported
 *   same letters, wrong case -> report a casing fix ("PVISION" -> "PVision")
 *   one clear near-match     -> report a spelling fix ("Yandx" -> "Yandex")
 *   anything else            -> not a name we know; left alone
 *
 * NOTE ON SCOPE: a subtitle file is text, so this catches MISSPELLINGS only.
 * Mispronunciation isn't observable here — that would need the audio.
 *
 * FALSE POSITIVES ARE THE WHOLE PROBLEM. A roster is thousands of handles, many
 * of them ordinary words ("Satanic", "33", "Faith"), so a loose edit-distance
 * rule would rewrite correct commentary into player names. The thresholds below
 * are deliberately strict and every one of them is covered by a test.
 */

/** Below this, near-matching is pure noise: "GG" is one edit from dozens of handles. */
const MIN_FUZZY_LENGTH = 5

/** Names this short get no fuzzy tolerance at all. */
const MIN_EXACT_LENGTH = 2

export type NameHit = {
  /** The text as it appears in the subtitle. */
  found: string
  /** The correctly spelled name from Liquipedia. */
  correct: string
  kind: "casing" | "spelling"
  /** "player" or "team" — shown so the reviewer knows what they're approving. */
  entity: "player" | "team"
  confidence: "high" | "medium"
}

/**
 * Levenshtein distance, abandoned as soon as it provably exceeds `max`.
 *
 * Bounded because this runs over every fragment against a few thousand names;
 * the early exit turns most comparisons into a couple of cheap row scans.
 */
export function boundedDistance(a: string, b: string, max: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  let current = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    let rowMin = current[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      if (current[j] < rowMin) rowMin = current[j]
    }
    if (rowMin > max) return max + 1
    const swap = previous
    previous = current
    current = swap
  }

  return previous[b.length]
}

/** How many edits are tolerable for a name of this length. */
function toleranceFor(length: number): number {
  if (length < MIN_FUZZY_LENGTH) return 0
  if (length <= 7) return 1
  return 2
}

export type RosterIndex = {
  /** lowercased name -> canonical spelling */
  byLower: Map<string, { name: string; entity: "player" | "team" }>
  /**
   * Every individual word appearing in a roster name, lowercased.
   *
   * Commentary shortens names constantly — "Chira" for "CHIRA JUNIOR", "Falcons"
   * for "Team Falcons". Those are correct, but they have no exact roster entry, so
   * fuzzy matching would happily "correct" Chira to China (a national-team page
   * one edit away). A fragment that is a word of some real name is therefore never
   * treated as a misspelling.
   *
   * These count as known names, so they are never translated either — a subtitle
   * saying "Nigma" means the org, not a word to render in Arabic.
   *
   * Only SINGLE-WORD fragments can match, because the set holds single tokens. A
   * multi-word ability like "Rolling Thunder" is unaffected even if some org is
   * called "Rolling Thunder Gaming", so this cannot swallow real terminology.
   */
  words: Set<string>
  players: string[]
  teams: string[]
}

export function buildRosterIndex(players: string[], teams: string[]): RosterIndex {
  const byLower = new Map<string, { name: string; entity: "player" | "team" }>()
  // Teams first, then players, so a collision resolves to the player handle —
  // commentary says a player's name far more often than an identically named org.
  for (const name of teams) byLower.set(name.toLowerCase(), { name, entity: "team" })
  for (const name of players) byLower.set(name.toLowerCase(), { name, entity: "player" })

  const words = new Set<string>()
  for (const name of [...teams, ...players]) {
    const parts = name.toLowerCase().split(/[\s._-]+/u).filter(Boolean)
    if (parts.length < 2) continue // single-word names are already in byLower
    for (const part of parts) {
      if (part.length >= MIN_EXACT_LENGTH) words.add(part)
    }
  }

  return { byLower, words, players, teams }
}

/** Wiki page titles are often stored shouted ("CHIRA JUNIOR"); that's a title style, not a spelling. */
function isShouted(name: string): boolean {
  return name === name.toUpperCase() && /\p{Lu}/u.test(name)
}

/**
 * Check one fragment against the roster.
 *
 * Returns null when the fragment is correct, unknown, or too ambiguous to call.
 * Silence is the expected answer for most fragments.
 */
export function checkName(
  fragment: string,
  index: RosterIndex,
  /**
   * Disables fuzzy matching, allowing only an exact roster hit.
   *
   * Used for fragments split out of a longer phrase. Splitting is a recovery
   * heuristic — it exists so a name glued to the word before it is still seen —
   * and its output is weak evidence. Left fuzzy, it rewrites pieces of ordinary
   * phrases into player handles: "Laguna Blade" yielded "Blade" -> "Blaze", and
   * "Lone Druid" yielded "Druid" -> "Druidz", both nonsense.
   */
  exactOnly = false
): NameHit | null {
  const found = fragment.trim()
  if (found.length < MIN_EXACT_LENGTH) return null

  const lower = found.toLowerCase()
  const exact = index.byLower.get(lower)

  if (exact) {
    // Spelled right, possibly cased differently.
    if (exact.name === found) return null
    // An ALL-CAPS wiki title says nothing about how the name is written in prose,
    // so "Chira Junior" must not be "corrected" to "CHIRA JUNIOR".
    if (isShouted(exact.name)) return null
    return {
      found,
      correct: exact.name,
      kind: "casing",
      entity: exact.entity,
      // Handles are stylised on purpose ("iceiceice", "N0tail"), so a casing
      // difference is a nudge, not a certainty.
      confidence: "medium",
    }
  }

  // A shortened form of a real name ("Chira" from "CHIRA JUNIOR") is correct, and
  // must never be fuzzy-matched onto some unrelated name.
  if (index.words.has(lower)) return null

  if (exactOnly) return null

  const tolerance = toleranceFor(found.length)
  if (tolerance === 0) return null

  // Find the single best near-match, and require it to be unambiguous.
  let best: { name: string; entity: "player" | "team"; distance: number } | null = null
  let runnerUpDistance = Infinity

  for (const [candidateLower, entry] of index.byLower) {
    const distance = boundedDistance(lower, candidateLower, tolerance)
    if (distance > tolerance) continue
    if (!best || distance < best.distance) {
      if (best) runnerUpDistance = best.distance
      best = { name: entry.name, entity: entry.entity, distance }
    } else if (distance < runnerUpDistance) {
      runnerUpDistance = distance
    }
  }

  if (!best) return null
  // Two roster names equally close to the fragment: no basis to pick one.
  if (runnerUpDistance === best.distance) return null

  return {
    found,
    correct: best.name,
    kind: "spelling",
    entity: best.entity,
    // One edit on a long name is a likely typo; two is a guess.
    confidence: best.distance === 1 && found.length >= 6 ? "high" : "medium",
  }
}

/**
 * Whether a fragment is a known name, spelled correctly — so it must be left
 * exactly as written and never translated.
 *
 * Covers both a full roster entry ("Nigma Galaxy") and the shortened form
 * commentary actually uses ("Nigma"), which is how a team name reached the model
 * and came back as Arabic.
 */
export function isKnownName(fragment: string, index: RosterIndex): boolean {
  const lower = fragment.trim().toLowerCase()
  return index.byLower.has(lower) || index.words.has(lower)
}
