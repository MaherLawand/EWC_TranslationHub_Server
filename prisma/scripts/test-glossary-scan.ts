/**
 * LITERAL GLOSSARY SCAN TESTS
 * ===========================
 * The deterministic pass that finds untranslated glossary terms. No network, no
 * API key — this is pure string matching and must be exhaustive and repeatable.
 *
 *   npx tsx prisma/scripts/test-glossary-scan.ts
 */
import { parseSrt } from "../../src/lib/srt.js"
import {
  scanLiteralTerms,
  findUntranslatedRuns,
  relatedGlossaryRows,
  isMorphologicalVariant,
  absorbArabicArticle,
  type GlossaryRow,
} from "../../src/lib/glossaryCheck.js"

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

const GLOSSARY: GlossaryRow[] = [
  { key: "rampage", context: "5 kills in single game milestone", source: "Rampage", target: "موجة قتل" },
  { key: "hero", context: "", source: "Hero", target: "بطل" },
  // Approved translation IS the English word — nothing to enforce.
  { key: "agent", context: "from Valorant", source: "Agent", target: "Agent" },
  // Too short; would over-match.
  { key: "hp", context: "", source: "HP", target: "صحة" },
]

function cuesFrom(lines: string[][]): ReturnType<typeof parseSrt>["cues"] {
  const blocks = lines.map((text, i) => {
    const n = i + 1
    const s = String(n).padStart(2, "0")
    return [`${n}`, `00:00:${s},000 --> 00:00:${s},900`, ...text].join("\n")
  })
  return parseSrt(blocks.join("\n\n") + "\n").cues
}

console.log("\nLiteral term scan")

check("finds an untranslated term", () => {
  const cues = cuesFrom([["حقق Rampage في المباراة"]])
  const hits = scanLiteralTerms(cues, GLOSSARY)
  eq(hits.length, 1, "hit count")
  eq(hits[0].find, "Rampage", "matched text")
  eq(hits[0].replace, "موجة قتل", "replacement")
})

check("THE REPORTED BUG: finds the term on EVERY line it appears", () => {
  const cues = cuesFrom([
    ["حقق Rampage في المباراة"],
    ["مرة أخرى Rampage"],
    ["وهذا ثالث Rampage"],
  ])
  const hits = scanLiteralTerms(cues, GLOSSARY)
  eq(hits.length, 3, "should flag all three lines, not just the first")
  eq(hits.map((h) => h.cueIndex).join(","), "1,2,3", "cue indices")
})

check("is repeatable — identical input gives identical output", () => {
  const cues = cuesFrom([["Rampage و Hero هنا"]])
  const a = JSON.stringify(scanLiteralTerms(cues, GLOSSARY))
  const b = JSON.stringify(scanLiteralTerms(cues, GLOSSARY))
  eq(a, b, "two runs differed")
})

check("finds multiple different terms in one cue", () => {
  const cues = cuesFrom([["The Hero got a Rampage"]])
  const hits = scanLiteralTerms(cues, GLOSSARY)
  eq(hits.length, 2, "should flag both terms")
})

check("is case-insensitive but preserves the file's casing", () => {
  const cues = cuesFrom([["حقق rampage هنا"]])
  const hits = scanLiteralTerms(cues, GLOSSARY)
  eq(hits.length, 1, "hit count")
  eq(hits[0].find, "rampage", "must copy the casing found in the file")
})

check("skips rows whose approved term IS the English word", () => {
  const cues = cuesFrom([["The Agent is here"]])
  const hits = scanLiteralTerms(cues, GLOSSARY)
  eq(hits.length, 0, "Agent => Agent means nothing to change")
})

check("skips very short terms that would over-match", () => {
  const cues = cuesFrom([["HP is low"]])
  const hits = scanLiteralTerms(cues, GLOSSARY)
  eq(hits.length, 0, "two-character terms are excluded")
})

check("does not match inside a longer word", () => {
  const cues = cuesFrom([["Rampages and Superhero"]])
  const hits = scanLiteralTerms(cues, GLOSSARY)
  eq(hits.length, 0, "should not match substrings of larger words")
})

check("does not flag a line already using the approved term", () => {
  const cues = cuesFrom([["حقق موجة قتل في المباراة"]])
  const hits = scanLiteralTerms(cues, GLOSSARY)
  eq(hits.length, 0, "already correct")
})

check("matches when the term sits directly against Arabic text", () => {
  const cues = cuesFrom([["Rampage!"]])
  const hits = scanLiteralTerms(cues, GLOSSARY)
  eq(hits.length, 1, "punctuation should not block the match")
})

check("every suggestion is internally consistent with its glossary row", () => {
  const cues = cuesFrom([["Rampage و Hero"]])
  const hits = scanLiteralTerms(cues, GLOSSARY)
  for (const hit of hits) {
    const row = GLOSSARY.find((r) => r.key === hit.glossaryKey)
    if (!row) throw new Error(`cited unknown key ${hit.glossaryKey}`)
    eq(hit.replace, row.target, "replace must equal the row's approved term")
    eq(hit.approvedTerm, row.target, "approvedTerm must equal the row's target")
  }
})

check("empty and whitespace-only cues are skipped", () => {
  const cues = cuesFrom([[""], ["   "]])
  eq(scanLiteralTerms(cues, GLOSSARY).length, 0, "no hits expected")
})

console.log("\nScript boundaries (Arabic against Latin)")

const AEGIS: GlossaryRow[] = [{ key: "aegis", context: "Dota 2", source: "Aegis", target: "الأيجيز" }]

check("matches a Latin term joined by the Arabic article + tatweel (الـAegis)", () => {
  // U+0640 TATWEEL is categorised Lm (a letter), so a naive \p{L} boundary
  // treats "Aegis" as mid-word and skips it entirely.
  const cues = cuesFrom([["يخطف Chira الـAegis"]])
  const hits = scanLiteralTerms(cues, AEGIS)
  eq(hits.length, 1, "tatweel must not block the match")
  eq(hits[0].find, "Aegis", "matched text")
})

check("matches a Latin term directly preceded by Arabic letters", () => {
  const cues = cuesFrom([["حاملAegis هنا"]])
  eq(scanLiteralTerms(cues, AEGIS).length, 1, "Arabic does not join Latin")
})

check("matches a Latin term directly followed by Arabic letters", () => {
  const cues = cuesFrom([["Aegisحامل هنا"]])
  eq(scanLiteralTerms(cues, AEGIS).length, 1, "Arabic does not join Latin")
})

check("still refuses to match inside a longer LATIN word", () => {
  const cues = cuesFrom([["AegisCarrier and preAegis"]])
  eq(scanLiteralTerms(cues, AEGIS).length, 0, "same-script boundary must still hold")
})

check("multi-word Latin terms keep their boundaries", () => {
  const rows: GlossaryRow[] = [
    { key: "gs", context: "", source: "Global Silence", target: "الصمت الشامل" },
  ]
  eq(scanLiteralTerms(cuesFrom([["مع Global Silence"]]), rows).length, 1, "should match")
  eq(scanLiteralTerms(cuesFrom([["Global Silences"]]), rows).length, 0, "trailing s must block")
})

console.log("\nUntranslated-English detection")

function runs(lines: string[][], rows: GlossaryRow[] = []) {
  return findUntranslatedRuns(cuesFrom(lines), rows).map((c) => c.text)
}

check("finds English terms that have no glossary row at all", () => {
  // The whole point: these are absent from the glossary, so the literal scan
  // can never see them.
  const found = runs([["ضرر هائل باستخدام Laguna Blade"]])
  eq(found.join("|"), "Laguna Blade", "should find the multi-word term as ONE span")
})

check("keeps multi-word terms together rather than splitting them", () => {
  eq(runs([["مع Global Silence"]]).join("|"), "Global Silence", "one span")
  eq(runs([["بـ Rolling Thunder!"]]).join("|"), "Rolling Thunder", "one span")
})

check("finds several distinct terms in one cue", () => {
  const found = runs([["دخل Malady ثم Satanic"]])
  eq(found.join("|"), "Malady|Satanic", "both terms, in order")
})

check("skips terms the glossary already governs", () => {
  const rows: GlossaryRow[] = [
    { key: "rampage", context: "", source: "Rampage", target: "موجة قتل" },
  ]
  eq(runs([["حقق Rampage"]], rows).length, 0, "the literal pass owns this one")
})

check("skips text already written in the approved term", () => {
  const rows: GlossaryRow[] = [
    { key: "agent", context: "", source: "Agent", target: "Agent" },
  ]
  eq(runs([["The Agent is here"]], rows).length, 0, "approved rendering is Latin here")
})

check("skips fragments too short to be a term", () => {
  eq(runs([["اللاعب X هنا"]]).length, 0, "single letters are not terms")
})

check("skips a whole untranslated line — that is not a terminology fix", () => {
  const long = [["this entire subtitle line was never translated at all by anyone"]]
  eq(runs(long).length, 0, "beyond the word/char cap")
})

check("strips trailing punctuation from the span", () => {
  eq(runs([["استخدم Overgrowth."]]).join("|"), "Overgrowth", "no trailing period")
})

check("does not report the same span twice within a cue", () => {
  eq(runs([["Malady و Malady"]]).join("|"), "Malady", "deduped per cue")
})

check("reports the same term separately on different lines", () => {
  const found = findUntranslatedRuns(cuesFrom([["دخل Malady"], ["ثم Malady"]]), [])
  eq(found.length, 2, "each cue is its own edit site")
  eq(found.map((c) => c.cueIndex).join(","), "1,2", "cue indices")
})

check("does not re-report something the literal scan already flagged", () => {
  const rows: GlossaryRow[] = [
    { key: "treant", context: "", source: "Treant", target: "تريانت" },
  ]
  const cues = cuesFrom([["بينما Treant Protector في موقف صعب"]])
  const literal = scanLiteralTerms(cues, rows)
  eq(literal.length, 1, "literal scan finds Treant")
  // "Treant Protector" is a different span than "Treant", so it may still be
  // offered — but the exact flagged span must not be duplicated.
  const found = findUntranslatedRuns(cues, rows, literal).map((c) => c.text)
  eq(found.includes("Treant"), false, "must not duplicate the glossary hit")
})

check("finds the real-file terms that were previously invisible", () => {
  // Straight from the user's test file. None of these are in the glossary, and
  // every one of them was silently passing before this pass existed.
  const found = runs([
    ["ضرر هائل باستخدام Laguna Blade"],
    ["يسقط Lone Druid مباشرة"],
    ["وما تمكن من استخدام Overgrowth"],
  ])
  eq(found.join("|"), "Laguna Blade|Lone Druid|Overgrowth", "all three found")
})

console.log("\nRelated glossary rows (term inside a longer phrase)")

const AEGIS_PHRASES: GlossaryRow[] = [
  { key: "app", context: "", source: "AEGIS POWER PLAY", target: "قوة الأيجيز" },
  { key: "ape", context: "", source: "AEGIS EXPIRED", target: "انتهت صلاحية الأيجيز" },
  { key: "apu", context: "", source: "AEGIS USED", target: "استخدم الأيجيز" },
  { key: "bld", context: "", source: "BUILDINGS", target: "المباني" },
]

check("THE REPORTED GAP: finds phrases that govern a term with no row of its own", () => {
  const related = relatedGlossaryRows("Aegis", AEGIS_PHRASES)
  eq(related.length, 3, "the three AEGIS phrases, not BUILDINGS")
  eq(related[0].target, "قوة الأيجيز", "carries the approved rendering")
})

check("does not match a term inside a longer word", () => {
  eq(relatedGlossaryRows("Aegis", [
    { key: "x", context: "", source: "AEGISCARRIER", target: "س" },
  ]).length, 0, "boundary must hold")
})

check("ignores a row whose source IS the term — the literal pass owns that", () => {
  eq(relatedGlossaryRows("Aegis", [
    { key: "a", context: "", source: "Aegis", target: "الأيجيز" },
  ]).length, 0, "standalone row is not 'related'")
})

check("returns nothing when no phrase mentions the term", () => {
  eq(relatedGlossaryRows("Overgrowth", AEGIS_PHRASES).length, 0, "no match")
})


console.log("\nMorphological variants (must not be 'corrected')")

check("THE LIVE BUG: restoring the definite article inside an idafa", () => {
  // File: "في تشكيلة NIGMA الرسمية" — the article MUST drop in a possessive
  // construction, so proposing the glossary's dictionary form breaks grammar.
  eq(isMorphologicalVariant("تشكيلة", "التشكيلة"), true, "same word, article differs")
})

check("THE LIVE BUG: a generic word upgraded into a proper event name", () => {
  // File: "من البطولة كلها" = "the whole tournament", not the Main Tournament.
  eq(isMorphologicalVariant("البطولة", "البطولة الرئيسية"), true, "one contains the other")
})

check("ignores diacritics and tatweel when comparing", () => {
  eq(isMorphologicalVariant("مُوجَة", "موجة"), true, "same word, vowelled")
})

check("treats alef and ta-marbuta variants as the same word", () => {
  eq(isMorphologicalVariant("إعادة", "اعادة"), true, "alef variants")
})

check("a genuinely different term is STILL reported", () => {
  // The whole point of the model pass: wrong word, not wrong inflection.
  eq(isMorphologicalVariant("بطل", "شخصية"), false, "unrelated words must pass through")
  eq(isMorphologicalVariant("موجة قتل", "الأيجيز"), false, "unrelated terms")
})

check("an English-to-Arabic fix is unaffected", () => {
  eq(isMorphologicalVariant("Rampage", "موجة قتل"), false, "different scripts entirely")
})


console.log("\nArabic article already attached to the term")

function after(line: string, find: string, replace: string) {
  const fixed = absorbArabicArticle(line, find, replace)
  const at = line.indexOf(fixed.find)
  return line.slice(0, at) + fixed.replace + line.slice(at + fixed.find.length)
}

check("THE LIVE BUG: does not double the article on الـcreeps", () => {
  // From the user's file. Replacing only "creeps" left "الـ" stranded in front of
  // a replacement that carries its own article: الـالكريبس.
  const line = "كنت بس أـfarm الـcreeps، وفجأة معه Tiny Shadow Blade"
  const result = after(line, "creeps", "الكريبس")
  eq(result.includes("الـالكريبس"), false, "must not produce a doubled article")
  eq(result.includes("الكريبس"), true, "the approved term is still applied")
})

check("keeps an existing article when the replacement has none", () => {
  // ال stays and joins the new word directly, with no dangling connector.
  const line = "الـcreeps هنا"
  eq(after(line, "creeps", "كريبس"), "الكريبس هنا", "article reused, tatweel absorbed")
})

check("absorbs a bare connector with no article", () => {
  const line = "كنت بس أـfarm هنا"
  eq(after(line, "farm", "فارم").includes("ـفارم"), false, "no dangling tatweel")
})

check("handles the article joined with no tatweel", () => {
  eq(after("الcreeps هنا", "creeps", "الكريبس"), "الكريبس هنا", "single article")
})

check("leaves a term with no attached article alone", () => {
  const line = "حقق Rampage في المباراة"
  const fixed = absorbArabicArticle(line, "Rampage", "موجة قتل")
  eq(fixed.find, "Rampage", "find unchanged")
  eq(fixed.replace, "موجة قتل", "replace unchanged")
})

check("does NOT treat a word ending in ال as an article", () => {
  // "قال" ends in those letters. Absorbing them would corrupt real Arabic text.
  const line = "قال creeps هنا"
  const fixed = absorbArabicArticle(line, "creeps", "الكريبس")
  eq(fixed.find, "creeps", "must not absorb the end of a real word")
})

check("the adjusted find still exists verbatim in the line", () => {
  // applyEdits rejects any find it cannot locate, so this must always hold.
  const line = "كنت بس أـfarm الـcreeps، وفجأة"
  const fixed = absorbArabicArticle(line, "creeps", "الكريبس")
  eq(line.includes(fixed.find), true, "find must remain applicable")
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
