/**
 * Maps an EWC/ENC game to its Liquipedia wiki path.
 *
 * The list of games is NOT owned here — it comes from the event schedule in
 * client/src/constants/weeklyGames.ts, the same source the dashboard's game filter
 * uses. This module only answers "which wiki holds the rosters for that game", so
 * adding a game to the schedule needs a line here only if name checking is wanted
 * for it.
 *
 * The wiki path is the segment in liquipedia.net/<wiki>/ and often isn't derivable
 * from the title: Counter-Strike lives at /counterstrike, and every fighting game
 * (Tekken, Street Fighter, Fatal Fury) shares /fighters.
 *
 * A game with no entry here is not an error — the check runs without name
 * verification and says so.
 */

/** Compare names ignoring case, punctuation, spacing, and edition numbers. */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim()
}

/**
 * Liquipedia wiki per game. Keys are matched after normalisation, so
 * "Counter-Strike 2", "counter strike 2" and "CS2" all resolve.
 *
 * Aliases mirror those in weeklyGames.ts so a DB name variant still resolves.
 */
const WIKI_BY_GAME: Record<string, string[]> = {
  dota2: ["Dota 2"],
  valorant: ["Valorant", "VALORANT"],
  leagueoflegends: ["League of Legends", "LoL"],
  counterstrike: ["Counter-Strike 2", "CS2", "Counter Strike 2", "Counterstrike 2"],
  rainbowsix: ["R6 Siege", "Rainbow Six Siege", "Rainbow 6 Siege", "Rainbow Six", "R6"],
  rocketleague: ["Rocket League"],
  apexlegends: ["Apex Legends"],
  overwatch: ["Overwatch 2", "Overwatch"],
  callofduty: [
    "Call of Duty: Warzone Resurgence",
    "Call of Duty: Warzone",
    "COD Warzone",
    "Warzone",
    "Call of Duty: Black Ops 7",
    "COD BO7",
    "Black Ops 7",
  ],
  pubg: ["Pubg Battlegrounds", "PUBG", "PUBG Battlegrounds"],
  pubgmobile: ["Pubg Mobile", "PUBG Mobile", "PUBG: Mobile"],
  freefire: ["Free Fire"],
  honorofkings: ["Honor of Kings"],
  teamfighttactics: ["Teamfight Tactics", "TFT"],
  easportsfc: ["EA Sports FC 26", "EAFC 26", "EA FC 26", "EA Sports FC"],
  fortnite: ["Fortnite"],
  trackmania: ["Trackmania", "TrackMania"],
  crossfire: ["Crossfire", "CrossFire"],
  chess: ["Chess", "Chess.com"],
  // Mobile Legends competitions (Wildcard, MWI, MSC) share one wiki.
  mobilelegends: [
    "Mobile Legends: Bang Bang",
    "Mobile Legends Bang Bang",
    "MLBB",
    "Mobile Legends",
    "Mobile Legends: Wildcard",
    "Mobile Legends Women's International",
    "Mobile Legends Womens International",
    "Mobile Legends: MWI",
    "Mobile Legends: MSC",
    "Mobile Legends MSC",
    "MLBB MSC",
  ],
  // Every fighting game shares Liquipedia's /fighters wiki.
  fighters: ["Fatal Fury", "Street Fighter 6", "Tekken 8", "Street Fighter", "Tekken"],
}

const WIKI_LOOKUP = new Map<string, string>()
for (const [wiki, names] of Object.entries(WIKI_BY_GAME)) {
  for (const name of names) WIKI_LOOKUP.set(normalize(name), wiki)
}

/** Liquipedia wiki for a game name, or null when rosters aren't available for it. */
export function wikiForGame(game: string): string | null {
  if (!game.trim()) return null
  return WIKI_LOOKUP.get(normalize(game)) ?? null
}

/** Whether name checking is possible for this game. */
export function supportsNameCheck(game: string): boolean {
  return wikiForGame(game) !== null
}
