/**
 * GAME -> LIQUIPEDIA WIKI MAPPING TESTS
 * ====================================
 * The game names come from client/src/constants/weeklyGames.ts. This asserts
 * every scheduled game either resolves to a wiki or is knowingly unsupported —
 * a silent miss would mean name checking quietly does nothing.
 *
 *   npx tsx prisma/scripts/test-games.ts
 */
import { wikiForGame } from "../../src/lib/games.js"

let passed = 0
let failed = 0
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${(e as Error).message}`) }
}
function eq<T>(a: T, b: T, what: string) {
  if (a !== b) throw new Error(`${what}\n      expected: ${JSON.stringify(b)}\n      actual:   ${JSON.stringify(a)}`)
}

// Canonical `game` values, copied verbatim from weeklyGames.ts.
const SCHEDULED = [
  "Valorant", "Fatal Fury", "Apex Legends", "Dota 2", "League of Legends",
  "Free Fire", "EA Sports FC 26", "Pubg Battlegrounds", "Pubg Mobile",
  "Teamfight Tactics", "Street Fighter 6", "Overwatch 2", "Honor of Kings",
  "Tekken 8", "Chess", "Rocket League", "Counter-Strike 2", "Fortnite",
  "Trackmania", "Crossfire", "Call of Duty: Warzone Resurgence",
  "Call of Duty: Black Ops 7", "R6 Siege", "Mobile Legends: Bang Bang",
  "Mobile Legends Women's International", "Mobile Legends: MSC",
]

console.log("\nEvery scheduled game resolves to a wiki")
for (const game of SCHEDULED) {
  check(game, () => {
    const wiki = wikiForGame(game)
    if (!wiki) throw new Error("no Liquipedia wiki mapped — name checking would silently do nothing")
  })
}

console.log("\nMapping specifics")
check("fighting games share the /fighters wiki", () => {
  eq(wikiForGame("Tekken 8"), "fighters", "Tekken")
  eq(wikiForGame("Street Fighter 6"), "fighters", "SF6")
  eq(wikiForGame("Fatal Fury"), "fighters", "Fatal Fury")
})
check("all Mobile Legends competitions share one wiki", () => {
  eq(wikiForGame("Mobile Legends: MSC"), "mobilelegends", "MSC")
  eq(wikiForGame("Mobile Legends Women's International"), "mobilelegends", "MWI")
})
check("both Call of Duty titles share one wiki", () => {
  eq(wikiForGame("Call of Duty: Black Ops 7"), "callofduty", "BO7")
  eq(wikiForGame("Call of Duty: Warzone Resurgence"), "callofduty", "Warzone")
})
check("aliases and punctuation variants resolve", () => {
  eq(wikiForGame("CS2"), "counterstrike", "CS2")
  eq(wikiForGame("counter strike 2"), "counterstrike", "spacing")
  eq(wikiForGame("R6"), "rainbowsix", "R6")
  eq(wikiForGame("MLBB"), "mobilelegends", "MLBB")
})
check("an unknown game returns null rather than guessing", () => {
  eq(wikiForGame("Some New Title"), null, "unknown")
  eq(wikiForGame(""), null, "empty")
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
