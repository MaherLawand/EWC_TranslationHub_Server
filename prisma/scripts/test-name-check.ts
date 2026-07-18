/**
 * NAME SPELL-CHECK TESTS
 * ======================
 * Deterministic matching of subtitle fragments against a Liquipedia roster.
 * No network. The risk here is false positives — rewriting correct commentary
 * into a player's name — so most of these assert that nothing is reported.
 *
 *   npx tsx prisma/scripts/test-name-check.ts
 */
import { buildRosterIndex, checkName, boundedDistance, isKnownName } from "../../src/lib/nameCheck.js"

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (error) {
    failed++
    console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    console.log(`      ${(error as Error).message}`)
  }
}

function eq<T>(actual: T, expected: T, what: string) {
  if (actual !== expected) {
    throw new Error(`${what}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
  }
}

// Real names from the Dota 2 wiki, including the ones in the user's test file.
const INDEX = buildRosterIndex(
  ["Noone", "Chira", "33", "Satanic", "Yatoro", "Ammar_the_F", "Collapse", "Malady"],
  ["PVision", "Yandex", "1w Team", "Team Falcons", "Team Liquid"]
)

console.log("\nBounded edit distance")

check("identical strings are distance 0", () => {
  eq(boundedDistance("yandex", "yandex", 2), 0, "distance")
})

check("counts a single substitution", () => {
  eq(boundedDistance("yandax", "yandex", 2), 1, "distance")
})

check("counts a single deletion", () => {
  eq(boundedDistance("yandx", "yandex", 2), 1, "distance")
})

check("bails out past the limit rather than computing the true distance", () => {
  const d = boundedDistance("completely", "different", 2)
  eq(d > 2, true, "should exceed the bound")
})

console.log("\nCorrectly spelled names are left alone")

check("an exact match reports nothing", () => {
  eq(checkName("Yandex", INDEX), null, "correct spelling needs no fix")
})

check("an exact player handle reports nothing", () => {
  eq(checkName("Noone", INDEX), null, "correct")
})

check("a very short exact handle reports nothing", () => {
  eq(checkName("33", INDEX), null, "correct, and too short to fuzzy-match")
})

console.log("\nMisspellings are caught")

check("catches a one-letter team misspelling", () => {
  const hit = checkName("Yandx", INDEX)
  eq(hit?.correct, "Yandex", "correction")
  eq(hit?.kind, "spelling", "kind")
  eq(hit?.entity, "team", "entity")
})

check("catches a one-letter player misspelling", () => {
  const hit = checkName("Yataro", INDEX)
  eq(hit?.correct, "Yatoro", "correction")
  eq(hit?.entity, "player", "entity")
})

check("catches a wrong-case team name", () => {
  const hit = checkName("PVISION", INDEX)
  eq(hit?.correct, "PVision", "correction")
  eq(hit?.kind, "casing", "should be reported as a casing fix")
})

console.log("\nFalse-positive guards")

check("THE MAIN RISK: an ordinary word is not rewritten into a name", () => {
  // "Collapse" is a real handle; the English word must not become a correction
  // for something merely similar.
  eq(checkName("Collide", INDEX), null, "two edits on a 7-char word must not match")
})

check("short fragments get no fuzzy tolerance", () => {
  eq(checkName("Noon", INDEX), null, "4 chars is below the fuzzy floor")
})

check("refuses to choose between two equally close names", () => {
  const ambiguous = buildRosterIndex(["Sumail", "Sumair"], [])
  eq(checkName("Sumaid", ambiguous), null, "tie must not be resolved arbitrarily")
})

check("an unknown word far from every name reports nothing", () => {
  eq(checkName("Overgrowth", INDEX), null, "not a name at all")
})

check("a long name tolerates two edits but not three", () => {
  eq(checkName("Team Falcon", INDEX)?.correct, "Team Falcons", "one deletion, should match")
  eq(checkName("Tm Falcn", INDEX), null, "too many edits")
})

check("does not match across a large length gap", () => {
  eq(checkName("Team", INDEX), null, "prefix of a team name is not a misspelling")
})

check("THE LIVE BUG: a shortened real name is not corrected to a similar one", () => {
  // Straight from the user's file. "Chira" has no page of its own — the player is
  // "CHIRA JUNIOR" — and "China" is a national-team page one edit away, so the
  // checker offered "Chira" -> "China" on real commentary.
  const live = buildRosterIndex(["CHIRA JUNIOR"], ["China", "PVision"])
  eq(checkName("Chira", live), null, "a word of a real name must not be 'corrected'")
})

check("THE LIVE BUG: an ALL-CAPS wiki title is not a casing correction", () => {
  const live = buildRosterIndex(["CHIRA JUNIOR"], [])
  eq(checkName("Chira Junior", live), null, "shouted page titles are a wiki style")
})

check("a genuine casing fix still works when the name is not shouted", () => {
  eq(checkName("PVISION", INDEX)?.correct, "PVision", "still corrected")
})

check("a word shared with a team name does not block translation elsewhere", () => {
  const live = buildRosterIndex([], ["Rolling Thunder Gaming"])
  eq(checkName("Rolling Thunder", live), null, "reports no misspelling")
})

console.log("\nKnown names (never translated)")

check("THE LIVE BUG: a shortened team name counts as a known name", () => {
  // "Nigma" has no page of its own — the org is "Nigma Galaxy" — so it was sent
  // to the model, which translated a team name into Arabic.
  const live = buildRosterIndex([], ["Nigma Galaxy", "Nigma Galaxy SEA"])
  eq(isKnownName("Nigma", live), true, "must be recognised and left alone")
  eq(isKnownName("nigma", live), true, "case-insensitive")
})

check("a full roster entry is a known name", () => {
  eq(isKnownName("PVision", INDEX), true, "exact team")
  eq(isKnownName("Noone", INDEX), true, "exact player")
})

check("a multi-word term is NOT swallowed by a shared word", () => {
  // The word index holds single tokens, so multi-word terminology can never
  // match one — this is what makes the rule above safe.
  const live = buildRosterIndex([], ["Rolling Thunder Gaming"])
  eq(isKnownName("Rolling Thunder", live), false, "still eligible for translation")
})

check("an ordinary word is not a known name", () => {
  eq(isKnownName("Overgrowth", INDEX), false, "not in the roster")
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
