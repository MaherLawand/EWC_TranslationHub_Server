/**
 * QC proofreader — mechanical grammar/spelling/punctuation fixes for subtitles in
 * a given language, via the model. It deliberately does NOT touch proper nouns
 * (player handles, team/org names, brands, game terms) or reword anything — it is
 * a proofread, not a rewrite or a translation.
 *
 * The prompt encodes the Netflix Timed Text Style Guide conventions (a general set
 * plus English- and Arabic-specific rule blocks), so fixes follow those norms for
 * capitalization, punctuation, numbers, spacing, and spelling.
 *
 * Requires OPENAI_API_KEY. Absent, it reports itself unavailable rather than
 * throwing an opaque error.
 */
import OpenAI from "openai"
import { z } from "zod"
import { zodTextFormat } from "openai/helpers/zod"
import { logger } from "./logger.js"

// Same default as the glossary checker; override independently if wanted.
const MODEL = process.env.OPENAI_QC_MODEL || process.env.OPENAI_MODEL || "gpt-5.4-mini"

// Cues per request — bounds each call's size for large files.
const BATCH = 40

export class ProofreadUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProofreadUnavailable"
  }
}

let client: OpenAI | null = null
function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new ProofreadUnavailable("The QC proofreader is not configured (OPENAI_API_KEY is missing).")
  }
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 5 })
  return client
}

export function isConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY)
}

const ChangeSchema = z.object({
  before: z.string().describe("The exact original substring that was wrong (verbatim from the cue)."),
  after: z.string().describe("What that substring was corrected to."),
  reason: z.string().describe("A very short reason, e.g. \"capitalize start of sentence\" or \"'i' should be 'I'\"."),
})
const CueSchema = z.object({
  index: z.number().int().describe("The cue number, exactly as given."),
  corrected: z.string().describe("The FULL corrected cue text, preserving line breaks as \\n."),
  changes: z.array(ChangeSchema).describe("Every mechanical fix made in this cue. Empty when nothing changed."),
})
const QcSchema = z.object({ cues: z.array(CueSchema) })

export type QcChange = z.infer<typeof ChangeSchema>
export type QcCorrection = { index: number; corrected: string; changes: QcChange[] }

function instructions(language: string): string {
  const isEnglish = /english/i.test(language)
  const isArabic = /arabic|العربية/i.test(language)
  const isFrench = /french|fran[çc]ais/i.test(language)

  // English (USA) Timed Text Style Guide — text-level conventions only.
  const englishRules = `
${language.toUpperCase()} STYLE (Netflix English Timed Text Style Guide):
- Use consistent U.S. English spelling and vocabulary; do not mix in British spellings.
- The pronoun "i" must be "I". Start every sentence with a capital letter; keep proper nouns capitalized.
- If a cue ends a complete sentence, make sure it has terminal punctuation — add a period to a declarative sentence that ends with none. Do NOT add end punctuation when the sentence continues into the next cue (the line is cut mid-sentence), or for non-sentence fragments (labels, on-screen text, song-lyric lines).
- Prefer "okay" over "OK"/"Ok".
- Use a single smart ellipsis character "…" (U+2026), never three dots "...".
- Never leave double spaces; exactly one space between words.
- Numbers: spell out zero–ten; use numerals for 11 and above. Always use numerals for ages. Spell out a number that begins a sentence (unless it is a year/date). Times use numerals with lowercase "a.m."/"p.m." (e.g. 9:30 a.m.).
- Titles like Mr., Mrs., Dr., Prof. take a period; acronyms take no periods (UNICEF, NASA).
- Direct quotes use double quotes, nested quotes use single quotes; place commas and periods inside the closing quote.
- Exclamation marks only for shouting/surprise — do not overuse. An emphatically asked question ends with "?!".
- Do not censor wording that is not already censored.`

  // Arabic Timed Text Style Guide — text-level conventions only.
  const arabicRules = `
${language.toUpperCase()} STYLE (Netflix Arabic Timed Text Style Guide):
- Use Modern Standard Arabic orthography. Correct spelling of hamza (ء أ إ ؤ ئ), alef forms (ا أ إ آ), and taa marbuta (ة) vs haa (ه) — but do NOT rewrite dialect into MSA or change wording.
- Use Arabic punctuation: comma "،", question mark "؟", semicolon "؛". Never put a space BEFORE a punctuation mark; put one space after.
- Do NOT combine question and exclamation marks (no "؟!" or "!؟").
- Use a single smart ellipsis "…" (U+2026), not three dots.
- Never leave double spaces.
- Numbers: write 1–10 in words (except in times/dates), 11 and above as numerals. Four-plus-digit numbers use a comma as the thousands separator, EXCEPT years (1940, not 1,940). Decimals use "." with a leading zero (0.5).
- Keep the definite article "الـ" OUTSIDE quotation marks, e.g. الـ"برونكس".
- Do NOT use italics in Arabic.
- Do NOT add a period (or other terminal punctuation) at the end of a cue just because a sentence ends — that end-of-sentence-period rule does NOT apply to Arabic.
- Do NOT reproduce deliberate misspellings unless they are plot-relevant.`

  // French subtitle conventions (no dedicated Netflix guide supplied — general
  // French orthography + the sentence-ending-period rule, which does NOT apply to
  // Arabic).
  const frenchRules = `
${language.toUpperCase()} STYLE (French subtitle conventions):
- Use correct French spelling, accents (é è ê ë à â ç ï î ô û ù), and grammar; fix missing or wrong accents.
- Start sentences with a capital letter; keep proper nouns capitalized.
- If a cue ends a complete sentence, make sure it has terminal punctuation — add a period to a declarative sentence that ends with none. Do NOT add end punctuation when the sentence continues into the next cue (the line is cut mid-sentence), or for non-sentence fragments (labels, on-screen text, song-lyric lines).
- Use a single smart ellipsis "…" (U+2026), not three dots; never leave double spaces.
- Follow standard French usage for numbers and punctuation.`

  const languageBlock = isEnglish ? englishRules : isArabic ? arabicRules : isFrench ? frenchRules : `
${language.toUpperCase()} STYLE:
- Apply the standard grammar, spelling, capitalization, and punctuation conventions of ${language}, following Netflix Timed Text Style Guide norms for that language.
- Use a single smart ellipsis "…" (U+2026) rather than three dots; never leave double spaces; start sentences with a capital where the script has case.`

  return `You are a meticulous subtitle proofreader working to the Netflix Timed Text Style Guide for ${language}.

Fix ONLY objective, mechanical issues in each cue — grammar, spelling, capitalization, punctuation, spacing, number formatting — and bring them in line with the style rules below. This is a proofread, not a rewrite or a translation.

STRICT RULES — follow every one:
- Do NOT change PROPER NOUNS: player handles / gamertags, team names, organization names, sponsor/brand names, game titles, hero/champion/agent names, or other in-game terminology. Leave them EXACTLY as written even if they look misspelled or lowercase.
- Do NOT translate, reword, rephrase, paraphrase, or change meaning. Do NOT change dialect or word choice. Only correct mechanical errors and apply the style rules.
- Do NOT change the number of lines. Preserve every line break (\\n) exactly where it is.
- Do NOT add or remove markup or tags (e.g. <i>). Work on the text only.
- When unsure whether something is a proper noun or an intentional choice, leave it unchanged.
${languageBlock}

For each cue that HAS at least one fix, return the full corrected text plus the list of changes (exact 'before' substring, the 'after', and a very short reason — cite the rule briefly, e.g. "smart ellipsis" or "spell out numbers ≤10"). For a cue with no issues, return an empty changes array.`
}

/**
 * Proofread the given cues. Returns only cues that actually changed, each with the
 * corrected full text and the list of individual fixes (before/after/reason).
 */
export async function proofreadCues(
  cues: { index: number; text: string }[],
  language: string
): Promise<QcCorrection[]> {
  const openai = getClient()
  const out: QcCorrection[] = []

  for (let i = 0; i < cues.length; i += BATCH) {
    const batch = cues.slice(i, i + BATCH)
    const payload = batch.map((c) => ({ index: c.index, text: c.text }))

    const response = await openai.responses.parse({
      model: MODEL,
      instructions: instructions(language),
      input: [{ role: "user", content: `Language: ${language}\n\nCues (JSON):\n${JSON.stringify(payload)}` }],
      text: { format: zodTextFormat(QcSchema, "qc_corrections") },
    })

    // Surface a refusal rather than silently returning nothing.
    for (const output of response.output ?? []) {
      if (output.type !== "message") continue
      for (const item of output.content ?? []) {
        if (item.type === "refusal") throw new Error(`The model declined to proofread this file: ${item.refusal}`)
      }
    }

    const parsed = response.output_parsed
    for (const c of parsed?.cues ?? []) {
      if (c.changes && c.changes.length > 0) {
        out.push({ index: c.index, corrected: c.corrected, changes: c.changes })
      }
    }
  }

  logger.info({ action: "SRT_QC_DONE", language, cues: cues.length, changedCues: out.length })
  return out
}
