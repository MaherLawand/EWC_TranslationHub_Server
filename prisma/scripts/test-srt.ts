/**
 * SRT SAFETY TESTS
 * ================
 * Proves the one guarantee the glossary checker rests on: editing a subtitle's TEXT
 * can never alter its TIMINGS, and a byte-exact file round-trips unchanged.
 *
 * No network, no API key, no database. Run it anywhere:
 *   npx tsx prisma/scripts/test-srt.ts
 *
 * Exits non-zero on the first failure so it can gate a build.
 */
import {
  parseSrt,
  serializeSrt,
  applyEdits,
  assertTimingsPreserved,
  serializeVerified,
  SrtParseError,
  SrtInvariantError,
  type SrtEdit,
} from "../../src/lib/srt.js"

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

function throws(fn: () => void, ctor: new (...a: any[]) => Error, what: string) {
  try {
    fn()
  } catch (error) {
    if (error instanceof ctor) return
    throw new Error(`${what}: threw ${(error as Error).name}, expected ${ctor.name}`)
  }
  throw new Error(`${what}: did not throw`)
}

/* ── Fixtures ───────────────────────────────────────────────────────────── */

const LF_BASIC = ["1", "00:00:01,000 --> 00:00:04,000", "The Agent pushes site B.", "", "2", "00:00:04,500 --> 00:00:07,250", "Nice awp kill by the", "second player.", ""].join("\n")

const CRLF = LF_BASIC.replace(/\n/g, "\r\n")

const BOM_FILE = "﻿" + LF_BASIC

const NO_TRAILING_NEWLINE = LF_BASIC.trimEnd()

// Non-sequential cue numbers + "." decimals + positioning coordinates.
const EXOTIC = [
  "7",
  "00:00:01.000 --> 00:00:04.000 X1:040 X2:600 Y1:050 Y2:100",
  "First cue, number seven.",
  "",
  "12",
  "01:02:03,456 -->  01:02:05,999",
  "Wide separator, hour timestamps.",
  "",
].join("\n")

const ARABIC = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "الوكيل يهاجم الموقع",
  "",
  "2",
  "00:00:03,500 --> 00:00:06,000",
  "لقطة رائعة",
  "",
].join("\n")

/* ── Round-trip: parse → serialize must be byte-identical ───────────────── */

console.log("\nRound-trip (byte-exact)")

const roundTripCases: [string, string][] = [
  ["LF, trailing newline", LF_BASIC],
  ["CRLF", CRLF],
  ["UTF-8 BOM", BOM_FILE],
  ["no trailing newline", NO_TRAILING_NEWLINE],
  ["non-sequential numbers, '.' decimals, positioning coords", EXOTIC],
  ["Arabic (RTL, multi-byte)", ARABIC],
]

for (const [name, source] of roundTripCases) {
  check(name, () => {
    const out = serializeSrt(parseSrt(source))
    eq(out, source, "serialize(parse(x)) !== x")
  })
}

check("CRLF file keeps CRLF, not normalized to LF", () => {
  const parsed = parseSrt(CRLF)
  eq(parsed.eol, "\r\n", "eol not detected as CRLF")
  if (serializeSrt(parsed).includes("\n") && !serializeSrt(parsed).includes("\r\n")) {
    throw new Error("CRLF was normalized away")
  }
})

check("BOM presence is preserved both ways", () => {
  eq(parseSrt(BOM_FILE).hasBom, true, "BOM not detected")
  eq(parseSrt(LF_BASIC).hasBom, false, "BOM falsely detected")
})

check("'.' decimal separator is not normalized to ','", () => {
  const parsed = parseSrt(EXOTIC)
  eq(parsed.cues[0].startRaw, "00:00:01.000", "start stamp was rewritten")
})

check("positioning coordinates survive on endRaw", () => {
  const parsed = parseSrt(EXOTIC)
  eq(parsed.cues[0].endRaw, "00:00:04.000 X1:040 X2:600 Y1:050 Y2:100", "coords lost")
})

check("non-sequential cue numbers are preserved, not renumbered", () => {
  const parsed = parseSrt(EXOTIC)
  eq(parsed.cues[0].index, 7, "first cue number")
  eq(parsed.cues[1].index, 12, "second cue number")
})

/* ── Editing: text changes, timings do not ──────────────────────────────── */

console.log("\nEditing")

check("applies a matching edit and leaves every timestamp identical", () => {
  const before = parseSrt(LF_BASIC)
  const edits: SrtEdit[] = [{ cueIndex: 1, find: "Agent", replace: "شخصية" }]
  const { next, applied, rejected } = applyEdits(before, edits)

  eq(applied.length, 1, "edit not applied")
  eq(rejected.length, 0, "unexpected rejection")
  eq(next.cues[0].textLines.join("\n"), "The شخصية pushes site B.", "text not replaced")

  for (let i = 0; i < before.cues.length; i++) {
    eq(next.cues[i].startRaw, before.cues[i].startRaw, `cue ${i} start changed`)
    eq(next.cues[i].endRaw, before.cues[i].endRaw, `cue ${i} end changed`)
    eq(next.cues[i].separatorRaw, before.cues[i].separatorRaw, `cue ${i} separator changed`)
  }
  assertTimingsPreserved(before, next, new Set([1]))
})

check("untouched cues keep their exact text", () => {
  const before = parseSrt(LF_BASIC)
  const { next } = applyEdits(before, [{ cueIndex: 1, find: "Agent", replace: "X" }])
  eq(next.cues[1].textLines.join("\n"), before.cues[1].textLines.join("\n"), "cue 2 was modified")
})

check("rejects an edit whose find string is absent (hallucination filter)", () => {
  const before = parseSrt(LF_BASIC)
  const { applied, rejected } = applyEdits(before, [
    { cueIndex: 1, find: "NOT_IN_THE_FILE", replace: "X" },
  ])
  eq(applied.length, 0, "applied a non-matching edit")
  eq(rejected.length, 1, "did not reject")
  eq(rejected[0].reason, "find_not_present", "wrong rejection reason")
})

check("rejects an edit pointing at a cue that does not exist", () => {
  const before = parseSrt(LF_BASIC)
  const { rejected } = applyEdits(before, [{ cueIndex: 999, find: "Agent", replace: "X" }])
  eq(rejected.length, 1, "did not reject")
  eq(rejected[0].reason, "cue_not_found", "wrong rejection reason")
})

check("matches a term that spans a line break within one cue", () => {
  const before = parseSrt(LF_BASIC)
  const { applied, next } = applyEdits(before, [
    { cueIndex: 2, find: "the\nsecond", replace: "the\nfirst" },
  ])
  eq(applied.length, 1, "cross-line edit not applied")
  eq(next.cues[1].textLines.length, 2, "line count changed")
  eq(next.cues[1].textLines[1], "first player.", "second line not updated")
})

check("applies two edits in one cue without corrupting offsets", () => {
  const before = parseSrt(LF_BASIC)
  const { applied, next } = applyEdits(before, [
    { cueIndex: 1, find: "Agent", replace: "AAAAAAAAAA" },
    { cueIndex: 1, find: "site B", replace: "B" },
  ])
  eq(applied.length, 2, "both edits should apply")
  eq(next.cues[0].textLines.join("\n"), "The AAAAAAAAAA pushes B.", "offsets corrupted")
})

check("drops the second of two overlapping edits", () => {
  const before = parseSrt(LF_BASIC)
  const { applied, rejected } = applyEdits(before, [
    { cueIndex: 1, find: "The Agent", replace: "X" },
    { cueIndex: 1, find: "Agent pushes", replace: "Y" },
  ])
  eq(applied.length, 1, "should apply only the first")
  eq(rejected.length, 1, "should reject the overlapping one")
  eq(rejected[0].reason, "overlaps_earlier_edit", "wrong rejection reason")
})

check("empty edit list is a no-op that still verifies", () => {
  const before = parseSrt(LF_BASIC)
  const { next, applied } = applyEdits(before, [])
  eq(applied.length, 0, "applied something")
  assertTimingsPreserved(before, next, new Set())
  eq(serializeSrt(next), LF_BASIC, "no-op changed the file")
})

/* ── The invariant guard must actually fire ─────────────────────────────── */

console.log("\nInvariant guard (must throw)")

check("throws when a timestamp is tampered with", () => {
  const before = parseSrt(LF_BASIC)
  const { next } = applyEdits(before, [{ cueIndex: 1, find: "Agent", replace: "X" }])
  // Force a timing change past the readonly type, the way a real bug would.
  const tampered = {
    ...next,
    cues: next.cues.map((c, i) => (i === 0 ? { ...c, startRaw: "00:00:99,999" } : c)),
  }
  throws(() => assertTimingsPreserved(before, tampered, new Set([1])), SrtInvariantError, "tampered timestamp")
})

check("throws when a cue is dropped", () => {
  const before = parseSrt(LF_BASIC)
  const short = { ...before, cues: before.cues.slice(0, 1) }
  throws(() => assertTimingsPreserved(before, short, new Set()), SrtInvariantError, "dropped cue")
})

check("throws when a cue changed that was not supposed to", () => {
  const before = parseSrt(LF_BASIC)
  const { next } = applyEdits(before, [{ cueIndex: 1, find: "Agent", replace: "X" }])
  // Claim nothing should have changed, while cue 1 did.
  throws(() => assertTimingsPreserved(before, next, new Set()), SrtInvariantError, "unexpected change")
})

check("throws when an expected change did not happen", () => {
  const before = parseSrt(LF_BASIC)
  const { next } = applyEdits(before, [])
  throws(() => assertTimingsPreserved(before, next, new Set([1])), SrtInvariantError, "missing change")
})

check("throws when the cue number is altered", () => {
  const before = parseSrt(LF_BASIC)
  const renumbered = { ...before, cues: before.cues.map((c, i) => (i === 0 ? { ...c, index: 42 } : c)) }
  throws(() => assertTimingsPreserved(before, renumbered, new Set()), SrtInvariantError, "renumbered cue")
})

/* ── serializeVerified: the end-to-end export path ──────────────────────── */

console.log("\nserializeVerified (export path)")

check("produces a file differing only on the edited line", () => {
  const before = parseSrt(LF_BASIC)
  const { next } = applyEdits(before, [{ cueIndex: 1, find: "Agent", replace: "شخصية" }])
  const out = serializeVerified(before, next, new Set([1]))

  const beforeLines = LF_BASIC.split("\n")
  const afterLines = out.split("\n")
  eq(afterLines.length, beforeLines.length, "line count changed")

  const differing = beforeLines
    .map((line, i) => (line === afterLines[i] ? -1 : i))
    .filter((i) => i !== -1)
  eq(differing.length, 1, `expected exactly 1 differing line, got ${differing.length}`)
  eq(afterLines[differing[0]], "The شخصية pushes site B.", "wrong line changed")
})

check("preserves CRLF and BOM through a real edit", () => {
  const source = "﻿" + CRLF
  const before = parseSrt(source)
  const { next } = applyEdits(before, [{ cueIndex: 1, find: "Agent", replace: "X" }])
  const out = serializeVerified(before, next, new Set([1]))
  eq(out.startsWith("﻿"), true, "BOM lost")
  eq(out.includes("\r\n"), true, "CRLF lost")
  eq(out.includes("00:00:01,000 --> 00:00:04,000"), true, "timestamp altered")
})

/* ── Parse errors ───────────────────────────────────────────────────────── */

console.log("\nParse errors")

check("throws SrtParseError on a malformed timestamp line", () => {
  const bad = ["1", "00:00:01,000 ??? 00:00:04,000", "Text.", ""].join("\n")
  throws(() => parseSrt(bad), SrtParseError, "malformed timestamp")
})

check("reports the offending line number", () => {
  const bad = ["1", "00:00:01,000 --> 00:00:04,000", "Fine.", "", "2", "NOT A TIMESTAMP", "Text.", ""].join("\n")
  try {
    parseSrt(bad)
    throw new Error("did not throw")
  } catch (error) {
    if (!(error instanceof SrtParseError)) throw error
    eq(error.line, 6, "wrong line number reported")
  }
})

check("tolerates a cue with no text", () => {
  const empty = ["1", "00:00:01,000 --> 00:00:04,000", "", "2", "00:00:05,000 --> 00:00:06,000", "Text.", ""].join("\n")
  const parsed = parseSrt(empty)
  eq(parsed.cues.length, 2, "cue count")
  eq(parsed.cues[0].textLines.length, 0, "empty cue should have no text lines")
})

/* ── Summary ────────────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
