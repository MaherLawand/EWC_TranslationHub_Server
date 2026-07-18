/**
 * Glossary-compliance check for subtitle text, via the OpenAI Responses API.
 *
 * SCOPE: terminology only. The model is asked to find places where a glossary
 * concept was translated with something other than the approved term — never
 * grammar, style, phrasing, or translation quality. A professional translator's
 * prose is not up for review here.
 *
 * SAFETY: the model never sees or emits a timestamp. It receives cue TEXT keyed by
 * cue number, and returns find/replace pairs. Anything it returns whose `find`
 * string isn't present verbatim in that cue is discarded downstream by
 * applyEdits() in srt.ts — so a hallucinated suggestion can't corrupt a file, it
 * simply fails to apply.
 *
 * Requires OPENAI_API_KEY. Absent, the feature reports itself unavailable rather
 * than taking the server down at boot.
 */
import OpenAI from "openai"
import { zodTextFormat } from "openai/helpers/zod"
import { z } from "zod"
import { logger } from "./logger.js"
import type { Cue, SrtEdit } from "./srt.js"
import { checkName, isKnownName, type RosterIndex } from "./nameCheck.js"

/**
 * This is constrained extraction against a strict schema, not open reasoning, so a
 * small model does the job at a fraction of the cost. The glossary dominates the
 * bill (~34k input tokens per request), which makes the input rate the thing that
 * matters:
 *
 *   gpt-5.6-sol    $5.00/1M in   ($0.50 cached)  — flagship, ~7x the cost
 *   gpt-5.6-luna   $1.00/1M in   ($0.10 cached)
 *   gpt-5.4-mini   $0.75/1M in   ($0.075 cached) — default
 *   gpt-5-nano     $0.05/1M in   ($0.005 cached) — cheapest, try if quality holds
 *
 * Override with OPENAI_MODEL to trade cost against accuracy on real files.
 */
const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini"

/** Approximate USD per 1M tokens, for the cost figure in the logs. */
const PRICING: Record<string, { in: number; cached: number; out: number }> = {
  "gpt-5.6-sol": { in: 5, cached: 0.5, out: 30 },
  "gpt-5.6-terra": { in: 2.5, cached: 0.25, out: 15 },
  "gpt-5.6-luna": { in: 1, cached: 0.1, out: 6 },
  "gpt-5.4-mini": { in: 0.75, cached: 0.075, out: 4.5 },
  "gpt-5.4-nano": { in: 0.2, cached: 0.02, out: 1.25 },
  "gpt-5-mini": { in: 0.25, cached: 0.025, out: 2 },
  "gpt-5-nano": { in: 0.05, cached: 0.005, out: 0.4 },
}

/** Usage accumulated across the chunks of one check. */
type Usage = { input: number; cached: number; output: number }

function estimateCost(usage: Usage): number | null {
  const price = PRICING[MODEL]
  if (!price) return null
  const fresh = Math.max(0, usage.input - usage.cached)
  return (
    (fresh / 1e6) * price.in + (usage.cached / 1e6) * price.cached + (usage.output / 1e6) * price.out
  )
}

/** Cues per request. Small enough that the model attends to each one properly. */
const CUES_PER_CHUNK = 120

/** Parallel requests. Beyond ~3 you're just queueing at the rate limiter. */
const MAX_CONCURRENCY = 3

export type GlossaryRow = { key: string; context: string; source: string; target: string }

/**
 * Where a suggestion came from, which is also how much authority it carries:
 *
 *   "glossary"     — backed by an approved glossary row. Verified against that row.
 *   "untranslated" — English left in the file with NO glossary row to cover it.
 *                    The replacement is the model's proposal, not approved
 *                    terminology, so the reviewer must decide. Surfaced distinctly
 *                    in the UI and never accepted by default.
 *   "name"         — a player or team name misspelled against the Liquipedia
 *                    roster for the selected game. Deterministic, no model.
 */
export type SuggestionKind = "glossary" | "untranslated" | "name"

/** A glossary row that mentions a term without defining it on its own. */
export type RelatedRow = { source: string; target: string }

/** One suggested terminology fix, as returned to the reviewer. */
export type Suggestion = SrtEdit & {
  kind: SuggestionKind
  glossaryKey: string
  sourceTerm: string
  approvedTerm: string
  confidence: "high" | "medium"
  context: string
  /**
   * For "untranslated" suggestions: glossary rows that contain this term inside a
   * longer phrase. "Aegis" has no row of its own, but "AEGIS POWER PLAY" and
   * "AEGIS EXPIRED" do — so the house rendering already exists and the reviewer
   * should see it rather than accept a fresh invention.
   */
  relatedRows?: RelatedRow[]
}

export class GlossaryCheckUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GlossaryCheckUnavailable"
  }
}

const EditSchema = z.object({
  cueIndex: z.number().int().describe("The cue number this fix applies to."),
  find: z.string().describe("Exact text to replace. MUST appear character-for-character in that cue."),
  replace: z.string().describe("The approved glossary term."),
  glossaryKey: z.string().describe("The glossary row key this is based on."),
  sourceTerm: z.string().describe("The English source term from the glossary."),
  approvedTerm: z.string().describe("The approved translation from the glossary."),
  confidence: z.enum(["high", "medium"]),
})

const ResultSchema = z.object({ edits: z.array(EditSchema) })

let client: OpenAI | null = null
function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new GlossaryCheckUnavailable(
      "The glossary checker is not configured (OPENAI_API_KEY is missing)."
    )
  }
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return client
}

export function isConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY)
}

const INSTRUCTIONS = `You check subtitle translations for GLOSSARY TERM COMPLIANCE ONLY.

You are given an approved terminology glossary and a list of subtitle cues written in the target language. Your only job is to find places where a glossary concept was translated using something OTHER than its approved term, and propose replacing it with the approved term.

Report an edit ONLY when ALL of these are true:
1. The cue clearly refers to a concept that appears in the glossary.
2. The wording used differs from that concept's approved term.
3. The "find" value you output appears VERBATIM — character for character — as a contiguous substring of that cue's text. Copy it exactly from the cue. Never paraphrase, normalize, or reconstruct it.
4. "replace" is EXACTLY the approved term of the glossary row you cite, copied character for character from that row. Never substitute your own wording, a synonym, or a different translation.
5. "glossaryKey", "sourceTerm", and "approvedTerm" all come from the SAME single glossary row, copied exactly. Never mix fields from different rows.

Every edit must be internally consistent: replacing "find" with "replace" must be exactly the act of applying the one glossary row you cited. If you cannot satisfy that, omit the edit entirely. An edit that cites one rule but changes something unrelated is a serious error — worse than reporting nothing.

Never report:
- Grammar, spelling, punctuation, word order, line breaks, or style.
- Translation quality, naturalness, or better phrasing.
- A cue that already uses the approved term.
- A term whose glossary "context" clearly refers to a different game or domain than the cue.

Use the glossary "context" field to disambiguate. If a glossary row is marked as being from a specific game and the cue is plainly about something else, do not report it.

If you are uncertain, report nothing. Returning an empty list is a correct and very common answer — most subtitle files have no glossary violations at all. Do not invent problems to appear useful.

Set confidence to "high" only when the concept match is unambiguous; otherwise "medium".`

/**
 * Compact one glossary row. Kept terse because this block is ~34k tokens and is
 * resent with every chunk. Context is capped: many rows carry long asset
 * filenames that add tokens without helping disambiguation.
 */
const MAX_CONTEXT_CHARS = 60

function formatGlossary(rows: GlossaryRow[]): string {
  const lines = rows.map((r) => {
    const trimmed = r.context.length > MAX_CONTEXT_CHARS
      ? `${r.context.slice(0, MAX_CONTEXT_CHARS)}…`
      : r.context
    const context = trimmed ? ` (${trimmed})` : ""
    return `${r.key}${context}: "${r.source}" => "${r.target}"`
  })
  return `APPROVED GLOSSARY (${rows.length} terms)\n${lines.join("\n")}`
}

/**
 * Deterministic pass: find glossary source terms left verbatim in the file.
 *
 * The most common violation is simply not translating a term — "Rampage" sitting
 * untranslated in an Arabic subtitle. That's exact string matching, not a job for
 * a language model: this pass is exhaustive (every cue, every term, every time),
 * perfectly repeatable, and free. The model pass only has to handle the harder
 * case, where a term WAS translated but with the wrong wording.
 *
 * Skips rows where source and target are identical (nothing to change — many
 * languages keep "Agent" as "Agent") and very short terms, which over-match.
 */
const MIN_LITERAL_TERM_CHARS = 3

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Word boundaries for a term, aware of which script it's written in.
 *
 * A naive `\p{L}` boundary breaks on real subtitles: Arabic text attaches the
 * definite article directly to Latin words, as in "الـAegis". The tatweel there
 * (U+0640) is categorised Lm — a letter — so a `\p{L}` lookbehind decides "Aegis"
 * is mid-word and skips it. Arabic script doesn't join to Latin, so for a
 * Latin-script term only adjacent LATIN characters should block a match.
 *
 * This keeps "Rampages" from matching "Rampage" while letting "الـAegis" match.
 */
const LATIN_EDGE = /[\p{Script=Latin}\p{N}]/u

function boundariesFor(term: string): { before: string; after: string } {
  const latinStart = LATIN_EDGE.test(term[0] ?? "")
  const latinEnd = LATIN_EDGE.test(term[term.length - 1] ?? "")
  return {
    before: latinStart ? "(?<![\\p{Script=Latin}\\p{N}])" : "(?<![\\p{L}\\p{N}])",
    after: latinEnd ? "(?![\\p{Script=Latin}\\p{N}])" : "(?![\\p{L}\\p{N}])",
  }
}

export function scanLiteralTerms(cues: Cue[], rows: GlossaryRow[]): Suggestion[] {
  const candidates = rows.filter((row) => {
    const source = row.source.trim()
    const target = row.target.trim()
    if (source.length < MIN_LITERAL_TERM_CHARS) return false
    // Nothing to enforce when the approved translation IS the English term.
    if (source.toLowerCase() === target.toLowerCase()) return false
    return true
  })

  const out: Suggestion[] = []

  for (const cue of cues) {
    const text = cue.textLines.join("\n")
    if (!text.trim()) continue

    for (const row of candidates) {
      const source = row.source.trim()
      const target = row.target.trim()
      // Script-aware boundaries: a term isn't matched inside a longer word of the
      // same script, but Arabic text sitting directly against a Latin term (the
      // "الـAegis" case) still matches.
      const { before, after } = boundariesFor(source)
      const pattern = new RegExp(`${before}${escapeRegex(source)}${after}`, "iu")
      const match = pattern.exec(text)
      if (!match) continue

      const found = match[0]
      if (found === target) continue // already correct

      out.push({
        kind: "glossary",
        cueIndex: cue.index,
        // Preserve the file's own casing so the edit applies verbatim.
        find: found,
        replace: target,
        glossaryKey: row.key,
        sourceTerm: row.source,
        approvedTerm: target,
        confidence: "high",
        context: row.context,
      })
    }
  }

  return out
}

/**
 * Deterministic pass: find English left sitting in a non-Latin-script subtitle.
 *
 * The glossary only covers terms someone thought to add to it. A real file is full
 * of game vocabulary that was never written down — "Laguna Blade", "Rolling
 * Thunder", "Global Silence" — and a checker that can only enforce existing rows
 * will keep reporting a clean file while English sits in plain view.
 *
 * DETECTION is deterministic and exhaustive: in an Arabic/Chinese/Hindi subtitle,
 * a run of Latin script is objectively foreign text, no judgement required. That
 * makes it free, repeatable, and impossible to hallucinate.
 *
 * The JUDGEMENT — should this be translated, and to what? — is the part that
 * genuinely needs a model, because plenty of Latin runs must stay as they are:
 * player handles ("Noone", "Chira"), team names ("PVision", "Yandex"). The model
 * is only ever allowed to choose among the runs found here; it cannot introduce a
 * span of its own.
 */

/** A contiguous run of Latin script, including internal single spaces. */
const LATIN_RUN =
  /[\p{Script=Latin}][\p{Script=Latin}\p{N}'’.-]*(?:[ ][\p{Script=Latin}][\p{Script=Latin}\p{N}'’.-]*)*/gu

/** Shorter than this over-matches initials and stray letters. */
const MIN_RUN_CHARS = 3

/** Longer than this is a whole untranslated line, not a term — out of scope. */
const MAX_RUN_CHARS = 40
const MAX_RUN_WORDS = 4

export type UntranslatedCandidate = { cueIndex: number; text: string }

export function findUntranslatedRuns(
  cues: Cue[],
  rows: GlossaryRow[],
  alreadyFlagged: Suggestion[] = []
): UntranslatedCandidate[] {
  // Anything the glossary already governs belongs to the literal pass, which
  // proposes an APPROVED term. Never let this pass second-guess it.
  const known = new Set<string>()
  const knownPatterns: RegExp[] = []
  for (const row of rows) {
    for (const term of [row.source.trim(), row.target.trim()]) {
      if (!term) continue
      known.add(term.toLowerCase())
      // A run is matched greedily, so a multi-word span can swallow a glossary
      // term ("The Agent is here" contains "Agent"). Those belong to the
      // glossary pass, which proposes an APPROVED term rather than a guess.
      if (term.length >= MIN_RUN_CHARS && LATIN_EDGE.test(term[0] ?? "")) {
        const { before, after } = boundariesFor(term)
        knownPatterns.push(new RegExp(`${before}${escapeRegex(term)}${after}`, "iu"))
      }
    }
  }
  const flagged = new Set(
    alreadyFlagged.map((s) => `${s.cueIndex}::${s.find.trim().toLowerCase()}`)
  )

  const out: UntranslatedCandidate[] = []
  const seen = new Set<string>()

  for (const cue of cues) {
    const text = cue.textLines.join("\n")
    if (!text.trim()) continue

    for (const match of text.matchAll(LATIN_RUN)) {
      // Trailing punctuation is part of the sentence, not the term.
      const run = match[0].replace(/[.'’-]+$/u, "").trim()
      if (run.length < MIN_RUN_CHARS || run.length > MAX_RUN_CHARS) continue
      if (run.split(/\s+/).length > MAX_RUN_WORDS) continue
      // A bare number or version string isn't a translatable term.
      if (!/\p{Script=Latin}/u.test(run)) continue

      const lower = run.toLowerCase()
      if (known.has(lower)) continue
      if (flagged.has(`${cue.index}::${lower}`)) continue
      // Defer to the glossary pass for anything it already has a rule for.
      if (knownPatterns.some((pattern) => pattern.test(run))) continue

      const key = `${cue.index}::${lower}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ cueIndex: cue.index, text: run })
    }
  }

  return out
}

/** Cap on related rows shown/sent per term — enough to establish the convention. */
const MAX_RELATED_ROWS = 4

/**
 * Glossary rows that mention a term inside a longer phrase.
 *
 * A term can be all over the glossary without ever having a row of its own:
 * "AEGIS POWER PLAY", "AEGIS EXPIRED", "AEGIS USED" all fix how Aegis is rendered
 * in Arabic, but none of them match the bare word in a subtitle. Reporting "not in
 * the glossary" there is technically true and practically misleading — and worse,
 * it invites a fresh translation that contradicts the established one.
 */
export function relatedGlossaryRows(term: string, rows: GlossaryRow[]): RelatedRow[] {
  const clean = term.trim()
  if (clean.length < MIN_RUN_CHARS) return []
  const { before, after } = boundariesFor(clean)
  const pattern = new RegExp(`${before}${escapeRegex(clean)}${after}`, "iu")

  const out: RelatedRow[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const source = row.source.trim()
    const target = row.target.trim()
    if (!source || !target) continue
    // A row whose source IS the term would have been caught by the literal pass.
    if (source.toLowerCase() === clean.toLowerCase()) continue
    if (!pattern.test(source)) continue
    const key = `${source}::${target}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ source, target })
    if (out.length >= MAX_RELATED_ROWS) break
  }
  return out
}

const UNTRANSLATED_INSTRUCTIONS = `You review subtitles that have been translated OUT of English, and decide what to do with English text still left in the file.

You are given subtitle cues in the target language, and a list of English fragments that were found in them. For EACH fragment, decide exactly one of:

- TRANSLATE — it is game vocabulary, an ability, an item, a mechanic, a stat, or a common noun that a viewer would expect in their own language. Provide the correct translation in the target language.
- KEEP — it must stay in English. Provide no translation.

KEEP applies to, and this is the majority of what you will see:
- Player names, handles, and nicknames (e.g. "Noone", "Chira", "33").
- Team and organisation names (e.g. "PVision", "Yandex", "Team Liquid").
- Tournament, product, and brand names.
- Anything that functions as a proper name of a person or organisation.

TRANSLATE applies to in-game terminology: hero abilities, spells, items, buffs, objectives, roles, and match events.

Hero and character names are a judgement call: translate them only when the target language has an established, widely used rendering. If in doubt, KEEP.

Some fragments come with "Glossary uses:" — approved entries where that term already appears inside a longer phrase. These show how the team already renders it. When present, follow that rendering exactly rather than composing your own, so the file stays consistent with existing material. Extract the part corresponding to the fragment; do not copy the whole phrase.

Rules:
1. Only report fragments from the list you were given. Never invent one, never alter its spelling, never merge or split fragments. "text" must be copied character for character from the list.
2. Only report fragments you chose to TRANSLATE. Omit every KEEP — silence means keep.
3. "translation" must be written in the target language's own script. Never return the English word back, transliterated or otherwise, as the translation.
4. Use the surrounding cue to disambiguate. The same word can be a player's handle in one cue and an item in another.
5. If you are unsure, omit the fragment. A missed term is a small problem; telling a translator to rename a player is a serious one.

Returning an empty list is a correct and common answer.

Set confidence to "high" only when the term is unmistakably game vocabulary with a standard translation; otherwise "medium".`

const UntranslatedSchema = z.object({
  items: z.array(
    z.object({
      cueIndex: z.number().int().describe("The cue number the fragment was found in."),
      text: z.string().describe("The English fragment, copied exactly from the supplied list."),
      translation: z.string().describe("The translation, in the target language's script."),
      confidence: z.enum(["high", "medium"]),
    })
  ),
})

/** Script of the target language, used to reject an untranslated 'translation'. */
const NON_LATIN_SCRIPT = /[\p{Script=Arabic}\p{Script=Han}\p{Script=Devanagari}]/u

async function checkUntranslatedChunk(
  cues: Cue[],
  candidates: UntranslatedCandidate[],
  languageLabel: string,
  relatedByTerm: Map<string, RelatedRow[]>
): Promise<{ suggestions: Suggestion[]; usage: Usage }> {
  const openai = getClient()

  const byCue = new Map<number, string[]>()
  for (const candidate of candidates) {
    const list = byCue.get(candidate.cueIndex) ?? []
    list.push(candidate.text)
    byCue.set(candidate.cueIndex, list)
  }

  const block = cues
    .filter((cue) => byCue.has(cue.index))
    .map((cue) => {
      const terms = byCue.get(cue.index)!
      const lines = terms.map((term) => {
        const related = relatedByTerm.get(term.toLowerCase()) ?? []
        // Show the house rendering where one exists, so the model matches it.
        const hint = related.length
          ? `  — Glossary uses: ${related.map((r) => `"${r.source}" => "${r.target}"`).join("; ")}`
          : ""
        return `      "${term}"${hint}`
      })
      return `[${cue.index}] ${cue.textLines.join("\n")}\n    English found:\n${lines.join("\n")}`
    })
    .join("\n\n")

  const response = await openai.responses.parse({
    model: MODEL,
    instructions: UNTRANSLATED_INSTRUCTIONS,
    input: [
      { role: "user", content: `Target language: ${languageLabel}\n\nCues:\n\n${block}` },
    ],
    text: { format: zodTextFormat(UntranslatedSchema, "untranslated_terms") },
  })

  for (const output of response.output ?? []) {
    if (output.type !== "message") continue
    for (const item of output.content ?? []) {
      if (item.type === "refusal") {
        throw new Error(`The model declined to check this file: ${item.refusal}`)
      }
    }
  }

  const parsed = response.output_parsed
  if (!parsed) throw new Error("The untranslated-term check returned no usable result.")

  const usage: Usage = {
    input: response.usage?.input_tokens ?? 0,
    cached: response.usage?.input_tokens_details?.cached_tokens ?? 0,
    output: response.usage?.output_tokens ?? 0,
  }

  // The model may only speak about spans the deterministic pass actually found.
  const allowed = new Set(
    candidates.map((c) => `${c.cueIndex}::${c.text.trim().toLowerCase()}`)
  )

  const suggestions: Suggestion[] = []
  const rejected: { reason: string; text: string; translation: string }[] = []

  for (const item of parsed.items) {
    const text = item.text.trim()
    const translation = item.translation.trim()

    if (!allowed.has(`${item.cueIndex}::${text.toLowerCase()}`)) {
      rejected.push({ reason: "span_not_detected", text, translation })
      continue
    }
    if (!translation || translation.toLowerCase() === text.toLowerCase()) {
      rejected.push({ reason: "no_op", text, translation })
      continue
    }
    // A "translation" still written in Latin script is the English word back.
    if (!NON_LATIN_SCRIPT.test(translation)) {
      rejected.push({ reason: "translation_not_in_target_script", text, translation })
      continue
    }

    const related = relatedByTerm.get(text.toLowerCase()) ?? []
    suggestions.push({
      kind: "untranslated",
      cueIndex: item.cueIndex,
      find: text,
      replace: translation,
      glossaryKey: "",
      sourceTerm: text,
      approvedTerm: "",
      confidence: item.confidence,
      context: "",
      relatedRows: related.length ? related : undefined,
    })
  }

  if (rejected.length > 0) {
    logger.warn({
      action: "UNTRANSLATED_SUGGESTIONS_REJECTED",
      rejected: rejected.length,
      of: parsed.items.length,
      model: MODEL,
      samples: rejected.slice(0, 5),
    })
  }

  return { suggestions, usage }
}

function formatCues(cues: Cue[]): string {
  return cues
    .map((cue) => `[${cue.index}] ${cue.textLines.join("\n")}`)
    .join("\n\n")
}

async function checkChunk(
  cues: Cue[],
  glossaryBlock: string,
  languageLabel: string
): Promise<{ suggestions: Suggestion[]; usage: Usage }> {
  const openai = getClient()

  const response = await openai.responses.parse({
    model: MODEL,
    // Static prefix first so OpenAI's automatic prompt caching can reuse it
    // across chunks and across requests. Nothing volatile (dates, counts, ids)
    // goes in `instructions` or the glossary block.
    instructions: `${INSTRUCTIONS}\n\n${glossaryBlock}`,
    input: [
      {
        role: "user",
        content: `Target language: ${languageLabel}\n\nSubtitle cues:\n\n${formatCues(cues)}`,
      },
    ],
    text: { format: zodTextFormat(ResultSchema, "glossary_edits") },
  })

  // A refusal doesn't follow the schema, so check for it before reading parsed.
  for (const output of response.output ?? []) {
    if (output.type !== "message") continue
    for (const item of output.content ?? []) {
      if (item.type === "refusal") {
        throw new Error(`The model declined to check this file: ${item.refusal}`)
      }
    }
  }

  const parsed = response.output_parsed
  if (!parsed) throw new Error("The glossary check returned no usable result.")

  // cached_tokens is the slice of input served from OpenAI's automatic prompt
  // cache — 10x cheaper. The glossary is a stable prefix, so this should be large
  // on every request after the first within the cache window.
  const usage: Usage = {
    input: response.usage?.input_tokens ?? 0,
    cached: response.usage?.input_tokens_details?.cached_tokens ?? 0,
    output: response.usage?.output_tokens ?? 0,
  }

  // `context` is filled in by the caller, which holds the glossary rows.
  const suggestions = parsed.edits.map((edit) => ({
    kind: "glossary" as const,
    cueIndex: edit.cueIndex,
    find: edit.find,
    replace: edit.replace,
    glossaryKey: edit.glossaryKey,
    sourceTerm: edit.sourceTerm,
    approvedTerm: edit.approvedTerm,
    confidence: edit.confidence,
    context: "",
  }))

  return { suggestions, usage }
}

/** Run tasks with bounded concurrency, preserving input order in the result. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Check every cue against the glossary for one target language.
 *
 * Throws on failure rather than returning partial results — a check that silently
 * covered only half the file would read as "clean" and is worse than an error.
 */
export async function checkGlossary(
  cues: Cue[],
  glossaryRows: GlossaryRow[],
  languageLabel: string,
  /**
   * Enables the untranslated-English pass. Only meaningful when the target
   * language uses a non-Latin script, where a run of Latin letters is
   * unambiguously foreign text. In French or Indonesian it would flag the whole
   * file, so the caller gates on script.
   */
  detectUntranslated = false,
  /**
   * Player/team names for the selected game. When present, fragments that are
   * known names are spell-checked instead of translated — and correctly spelled
   * ones are dropped before the model pass, which both removes the main source of
   * bad "translate a player's name" suggestions and shrinks the prompt.
   */
  roster?: RosterIndex
): Promise<{ suggestions: Suggestion[]; chunks: number; usage: Usage; cost: number | null }> {
  const empty: Usage = { input: 0, cached: 0, output: 0 }
  if (cues.length === 0 || glossaryRows.length === 0) {
    return { suggestions: [], chunks: 0, usage: empty, cost: 0 }
  }

  const glossaryBlock = formatGlossary(glossaryRows)
  const contextByKey = new Map(glossaryRows.map((r) => [r.key, r.context]))

  // Pass 1 — free, exhaustive, deterministic. Catches every untranslated term.
  const literal = scanLiteralTerms(cues, glossaryRows)

  // Every Latin fragment in the file, before anything is decided about it.
  const allCandidates = detectUntranslated ? findUntranslatedRuns(cues, glossaryRows, literal) : []

  // Pass 2 — names, resolved against the roster. Deterministic and free, so it
  // runs before the model gate. The three outcomes are mutually exclusive: a
  // known name is never a translation problem.
  const nameSuggestions: Suggestion[] = []
  const candidates: UntranslatedCandidate[] = []
  for (const candidate of allCandidates) {
    if (roster) {
      const hit = checkName(candidate.text, roster)
      if (hit) {
        nameSuggestions.push({
          kind: "name",
          cueIndex: candidate.cueIndex,
          find: hit.found,
          replace: hit.correct,
          glossaryKey: "",
          sourceTerm: hit.found,
          approvedTerm: hit.correct,
          confidence: hit.confidence,
          context:
            hit.kind === "casing"
              ? `${hit.entity === "team" ? "Team" : "Player"} name — Liquipedia spells it this way`
              : `${hit.entity === "team" ? "Team" : "Player"} name — looks misspelled`,
        })
        continue
      }
      // Correctly spelled name: nothing to fix, and it must not be translated.
      if (isKnownName(candidate.text, roster)) continue
    }
    candidates.push(candidate)
  }

  const deterministic = [...literal, ...nameSuggestions].sort((a, b) => a.cueIndex - b.cueIndex)

  // Pass 3 — the model, for terms that WERE translated but with wrong wording,
  // and for English with no glossary rule. Skippable via GLOSSARY_MODEL_PASS=off
  // to run the checker at zero cost.
  const modelPassEnabled = process.env.GLOSSARY_MODEL_PASS !== "off"
  if (!modelPassEnabled) {
    logger.info({
      action: "GLOSSARY_CHECK_COMPLETED",
      mode: "deterministic-only",
      cues: cues.length,
      suggestions: deterministic.length,
      fromLiteralScan: literal.length,
      fromNameCheck: nameSuggestions.length,
      estimatedCostUsd: 0,
    })
    return { suggestions: deterministic, chunks: 0, usage: empty, cost: 0 }
  }

  const chunks: Cue[][] = []
  for (let i = 0; i < cues.length; i += CUES_PER_CHUNK) {
    chunks.push(cues.slice(i, i + CUES_PER_CHUNK))
  }

  // Run the first chunk alone so its prompt prefix is cached before the rest fan
  // out — concurrent requests with an identical prefix would all miss the cache.
  const head = await checkChunk(chunks[0], glossaryBlock, languageLabel)
  const rest =
    chunks.length > 1
      ? await mapWithConcurrency(chunks.slice(1), MAX_CONCURRENCY, (chunk) =>
          checkChunk(chunk, glossaryBlock, languageLabel)
        )
      : []

  // Pass 3 — English with no glossary row at all. Detection is deterministic
  // (see findUntranslatedRuns); the model only decides translate-or-keep. It
  // carries no glossary block, so it is far cheaper per chunk than pass 2.
  // A term with no row of its own may still be governed by longer phrases that
  // contain it. Resolved once per distinct term, then shared by every occurrence.
  const relatedByTerm = new Map<string, RelatedRow[]>()
  for (const candidate of candidates) {
    const key = candidate.text.toLowerCase()
    if (relatedByTerm.has(key)) continue
    relatedByTerm.set(key, relatedGlossaryRows(candidate.text, glossaryRows))
  }

  const untranslatedResults = candidates.length
    ? await mapWithConcurrency(
        chunks.filter((chunk) =>
          chunk.some((cue) => candidates.some((c) => c.cueIndex === cue.index))
        ),
        MAX_CONCURRENCY,
        (chunk) =>
          checkUntranslatedChunk(
            chunk,
            candidates.filter((c) => chunk.some((cue) => cue.index === c.cueIndex)),
            languageLabel,
            relatedByTerm
          )
      )
    : []

  const all = [head, ...rest, ...untranslatedResults]
  const untranslated = untranslatedResults.flatMap((r) => r.suggestions)
  // Only the glossary passes are validated against glossary rows below. The
  // untranslated pass has no row to cite and is verified by its own rules.
  const raw = [head, ...rest]
    .flatMap((r) => r.suggestions)
    .map((s) => ({ ...s, context: contextByKey.get(s.glossaryKey) ?? "" }))

  // Verify every suggestion against the glossary row it claims to be based on.
  //
  // Models will occasionally cite a real glossary rule and then propose an edit
  // that has nothing to do with it — e.g. citing "Hero => بطل" while replacing an
  // unrelated word with a term that isn't بطل at all. That looks authoritative in
  // the UI and is completely wrong, so it gets filtered here rather than trusted.
  //
  // The check is deterministic: look up the cited row, and require that the
  // replacement actually contains that row's approved term.
  const rowByKey = new Map(glossaryRows.map((r) => [r.key.trim().toLowerCase(), r]))
  const invalid: { reason: string; glossaryKey: string; replace: string }[] = []

  const suggestions = raw.filter((s) => {
    const row = rowByKey.get((s.glossaryKey || "").trim().toLowerCase())
    if (!row) {
      invalid.push({ reason: "unknown_glossary_key", glossaryKey: s.glossaryKey, replace: s.replace })
      return false
    }
    // The model misquoted the approved translation for the row it cited.
    if (s.approvedTerm.trim() !== row.target.trim()) {
      invalid.push({ reason: "approved_term_mismatch", glossaryKey: s.glossaryKey, replace: s.replace })
      return false
    }
    // The proposed replacement isn't the approved term. `includes` rather than
    // equality so a fix may carry surrounding words from the cue.
    if (!s.replace.includes(row.target.trim())) {
      invalid.push({ reason: "replacement_is_not_approved_term", glossaryKey: s.glossaryKey, replace: s.replace })
      return false
    }
    // Replacing the approved term with itself is a no-op.
    if (s.find.trim() === s.replace.trim()) {
      invalid.push({ reason: "no_op", glossaryKey: s.glossaryKey, replace: s.replace })
      return false
    }
    // The rules above verify the model QUOTED its glossary row correctly, but not
    // that the row has anything to do with the text being replaced — so citing
    // "Ace => إيس" while rewriting "الـAegis" passed all of them.
    //
    // When the replaced text still contains English, that English is checkable:
    // it must be the row's source term. (A genuinely mistranslated span is in the
    // target script and has no English to compare, so this only applies here.)
    const latin = s.find.match(LATIN_RUN)
    if (latin && latin.length > 0) {
      const source = row.source.trim().toLowerCase()
      const related = latin.some((run) => {
        const term = run.trim().toLowerCase()
        return term.length > 0 && (source.includes(term) || term.includes(source))
      })
      if (!related) {
        invalid.push({
          reason: "find_unrelated_to_source_term",
          glossaryKey: s.glossaryKey,
          replace: s.replace,
        })
        return false
      }
    }
    return true
  })

  if (invalid.length > 0) {
    logger.warn({
      action: "GLOSSARY_SUGGESTIONS_REJECTED",
      rejected: invalid.length,
      of: raw.length,
      model: MODEL,
      samples: invalid.slice(0, 5),
    })
  }

  // Merge the two passes. The deterministic hits go first and win any tie — they
  // are exact matches, so where both passes found the same thing, the free and
  // repeatable one is the keeper.
  // Approved terminology outranks a proposal, so glossary hits come first and win
  // any tie: where both passes touched the same span, the approved term is kept.
  const seen = new Set<string>()
  const merged: Suggestion[] = []
  for (const suggestion of [...literal, ...nameSuggestions, ...suggestions, ...untranslated]) {
    const key = `${suggestion.cueIndex}::${suggestion.find.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(suggestion)
  }
  // Present in file order so the reviewer reads top to bottom.
  merged.sort((a, b) => a.cueIndex - b.cueIndex)

  const usage = all.reduce<Usage>(
    (acc, r) => ({
      input: acc.input + r.usage.input,
      cached: acc.cached + r.usage.cached,
      output: acc.output + r.usage.output,
    }),
    { input: 0, cached: 0, output: 0 }
  )
  const cost = estimateCost(usage)

  logger.info({
    action: "GLOSSARY_CHECK_COMPLETED",
    model: MODEL,
    cues: cues.length,
    chunks: chunks.length,
    glossaryTerms: glossaryRows.length,
    suggestions: merged.length,
    fromLiteralScan: literal.length,
    fromModel: suggestions.length,
    untranslatedCandidates: candidates.length,
    fromUntranslated: untranslated.length,
    // Fragments the roster resolved, so the model never saw them.
    nameFragments: allCandidates.length - candidates.length,
    fromNameCheck: nameSuggestions.length,
    inputTokens: usage.input,
    cachedTokens: usage.cached,
    outputTokens: usage.output,
    // Share of input served from cache. Low on a first run, high on repeats.
    cacheHitPct: usage.input ? Math.round((usage.cached / usage.input) * 100) : 0,
    estimatedCostUsd: cost === null ? null : Number(cost.toFixed(4)),
  })

  return { suggestions: merged, chunks: chunks.length, usage, cost }
}
