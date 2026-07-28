/**
 * SRT glossary checker — standalone (not tied to an order).
 *
 * Access is restricted to the in-house TRANSLATOR position and admins. Note this
 * deliberately does NOT use isTranslatorPosition(), which also matches the
 * TRANSPERFECT and TARJAMA vendor roles — this tool is in-house only.
 *
 * Two endpoints, both stateless:
 *   POST /srt/check   text + language  -> suggested terminology fixes
 *   POST /srt/export  text + accepted  -> corrected file
 *
 * Export re-parses the original text and re-verifies from scratch, so the file the
 * user downloads is provably derived from the bytes they uploaded. Nothing about a
 * check is persisted between the two calls.
 */
import type { Response } from "express"
import type { AuthRequest } from "../middleware/auth.middleware.js"
import { logger } from "../lib/logger.js"
import {
  parseSrt,
  applyEdits,
  serializeVerified,
  SrtParseError,
  SrtInvariantError,
  type SrtEdit,
} from "../lib/srt.js"
import { describeGlossaryFailure } from "../lib/glossary.js"
import { getArabicPriority, applyArabicPriority } from "../lib/arabicPriorityGlossary.js"
import { glossaryColumnFor, COLUMN_TO_LABEL, usesNonLatinScript } from "../lib/glossaryLanguages.js"
import { checkGlossary, scanLiteralTerms, alignEnglishToTarget, isConfigured, GlossaryCheckUnavailable } from "../lib/glossaryCheck.js"
import { proofreadCues, isConfigured as qcConfigured, ProofreadUnavailable } from "../lib/proofread.js"

/** "HH:MM:SS,mmm" (or ".mmm") → milliseconds. NaN if unparseable. */
function tsToMs(t: string): number {
  const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(t || "")
  if (!m) return NaN
  return +m[1] * 3600000 + +m[2] * 60000 + +m[3] * 1000 + Number(m[4].padEnd(3, "0"))
}
import { getEnReference, entriesForTarget, type EnReferenceTarget } from "../lib/enReferenceGlossary.js"
import { wikiForGame } from "../lib/games.js"
import { getRoster, LiquipediaRateLimited } from "../lib/liquipedia.js"
import { buildRosterIndex, type RosterIndex } from "../lib/nameCheck.js"
import { applyLearnedDecisions, recordDecisions, type TermDecision } from "../lib/termMemory.js"

/**
 * express.json() caps bodies at 1mb. UTF-8 Arabic/CJK runs 2-3 bytes per
 * character, so cap well under that in characters.
 */
const MAX_SRT_CHARS = 400_000
const MAX_CUES = 3000

/**
 * Who may use this tool: in-house translators, plus admins.
 *
 * Deliberately NOT isTranslatorPosition(), which also matches the TRANSPERFECT
 * and TARJAMA vendor roles — the glossary is internal terminology and stays
 * closed to outside vendors.
 */
function canUseSrtChecker(role?: string | null, position?: string | null): boolean {
  return position === "TRANSLATOR" || role === "ADMIN"
}

/**
 * Guard against many users each staying within their own rate limit but
 * collectively hammering the API.
 */
let inFlightChecks = 0
const MAX_IN_FLIGHT = 10

/** GET /srt/languages — which target languages the glossary actually supports. */
export async function getGlossaryLanguages(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })
    if (!canUseSrtChecker(req.userRole, req.userPosition)) {
      return res.status(403).json({ message: "This tool is available to translators and admins only." })
    }

    // The checker sources from the EN/AR/FR reference glossary now, so it offers
    // exactly the languages that sheet fills in.
    const glossary = await getEnReference()
    const languages: { column: string; label: string }[] = []
    if (glossary.entries.some((e) => e.ar)) languages.push({ column: "ara", label: "Arabic" })
    if (glossary.entries.some((e) => e.fr)) languages.push({ column: "fra", label: "French" })

    return res.json({ languages, configured: isConfigured() })
  } catch (error) {
    logger.error({ action: "GLOSSARY_LANGUAGES_ERROR", userId: req.userId, err: error })
    return res.status(503).json({
      message: "The glossary is temporarily unavailable.",
      // Names the actual cause, so this is diagnosable without server logs. Safe
      // to return: it describes configuration, never the credentials themselves.
      detail: describeGlossaryFailure(error),
    })
  }
}

/** POST /srt/check — body: { srtText, language } */
export async function checkSrt(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })
    if (!canUseSrtChecker(req.userRole, req.userPosition)) {
      return res.status(403).json({ message: "This tool is available to translators and admins only." })
    }
    if (!isConfigured()) {
      return res.status(503).json({ message: "The glossary checker is not configured yet." })
    }

    const srtText = typeof req.body?.srtText === "string" ? req.body.srtText : ""
    const language = typeof req.body?.language === "string" ? req.body.language.trim() : ""

    if (!srtText.trim()) return res.status(400).json({ message: "No subtitle file content was received." })
    if (!language) return res.status(400).json({ message: "Choose a target language first." })
    if (srtText.length > MAX_SRT_CHARS) {
      return res.status(413).json({ message: "That subtitle file is too large to check." })
    }

    const column = glossaryColumnFor(language)
    // The reference glossary only fills Arabic and French.
    const refTarget: EnReferenceTarget | null = column === "ara" ? "ar" : column === "fra" ? "fr" : null
    if (!column || !refTarget) {
      return res.status(409).json({ message: `No glossary is available for ${language}.` })
    }

    const glossary = await getEnReference()
    let rows = entriesForTarget(glossary, refTarget)
    if (rows.length === 0) {
      return res.status(409).json({ message: `The glossary has no terms for ${language}.` })
    }

    // Arabic has a second, higher-priority glossary that overrides the main one.
    // A failure here must not fail the check — fall back to the main glossary.
    if (column === "ara") {
      try {
        const priority = await getArabicPriority()
        const before = rows.length
        rows = applyArabicPriority(rows, priority)
        logger.info({
          action: "ARABIC_PRIORITY_APPLIED",
          mainTerms: before,
          totalTerms: rows.length,
          priorityTerms: priority.entries.length,
        })
      } catch (error) {
        logger.warn({ action: "ARABIC_PRIORITY_UNAVAILABLE", err: (error as Error).message })
      }
    }

    let parsed
    try {
      parsed = parseSrt(srtText)
    } catch (error) {
      if (error instanceof SrtParseError) {
        return res.status(400).json({ message: "That .srt file could not be read.", detail: error.message })
      }
      throw error
    }

    if (parsed.cues.length === 0) {
      return res.status(400).json({ message: "That file contains no subtitles." })
    }
    if (parsed.cues.length > MAX_CUES) {
      return res.status(413).json({ message: "That subtitle file has too many lines to check." })
    }

    if (inFlightChecks >= MAX_IN_FLIGHT) {
      return res.status(503).json({ message: "The checker is busy right now. Try again in a moment." })
    }

    // Optional, and never fatal. A game with no Liquipedia wiki, or a Liquipedia
    // outage, degrades to "no name checking" — reported to the user rather than
    // failing a terminology check that is otherwise fine.
    const game = typeof req.body?.game === "string" ? req.body.game.trim() : ""
    const wiki = game ? wikiForGame(game) : null

    let roster: RosterIndex | undefined
    let rosterNote: string | null = null
    if (game && !wiki) {
      rosterNote = `Liquipedia has no roster for ${game}, so names were not checked.`
    } else if (wiki) {
      try {
        const { players, teams } = await getRoster(wiki)
        roster = buildRosterIndex(players, teams)
      } catch (error) {
        // Include the reason: a datacentre IP block, a rate-limit rejection and a
        // timeout all need different responses, and "could not be reached" hides
        // which one happened.
        const reason = (error as Error).message
        rosterNote =
          error instanceof LiquipediaRateLimited
            ? `${reason}. The terminology check below still ran in full.`
            : `Liquipedia could not be reached, so names were not checked. (${reason})`
        logger.warn({
          action: "LIQUIPEDIA_ROSTER_UNAVAILABLE",
          game,
          wiki,
          err: reason,
        })
      }
    }

    inFlightChecks++
    let result
    try {
      result = await checkGlossary(
        parsed.cues,
        rows,
        COLUMN_TO_LABEL[column] ?? language,
        usesNonLatinScript(column),
        roster
      )
    } finally {
      inFlightChecks--
    }

    // Drop anything that can't actually be applied — a hallucinated or stale
    // suggestion must never reach the reviewer, since accepting it would silently
    // do nothing.
    const probe = applyEdits(parsed, result.suggestions)
    const applicable = new Set(probe.applied.map((edit) => `${edit.cueIndex}::${edit.find}`))
    const applicableSuggestions = result.suggestions.filter((s) =>
      applicable.has(`${s.cueIndex}::${s.find}`)
    )
    const dropped = result.suggestions.length - applicableSuggestions.length

    // Honour what translators decided about these same suggestions before:
    // corrections replace the wording, rejections remove the suggestion entirely.
    const learned = await applyLearnedDecisions(applicableSuggestions, language)
    const suggestions = learned.suggestions

    logger.info({
      action: "SRT_GLOSSARY_CHECK",
      userId: req.userId,
      userName: req.userName,
      language,
      cues: parsed.cues.length,
      glossaryTerms: rows.length,
      suggestions: suggestions.length,
      dropped,
      chunks: result.chunks,
    })

    return res.json({
      cues: parsed.cues.map((cue) => ({
        index: cue.index,
        start: cue.startRaw,
        end: cue.endRaw,
        text: cue.textLines.join("\n"),
      })),
      suggestions: suggestions.map((s, i) => ({
        id: `${s.cueIndex}-${i}`,
        kind: s.kind,
        cueIndex: s.cueIndex,
        find: s.find,
        replace: s.replace,
        glossaryKey: s.glossaryKey,
        sourceTerm: s.sourceTerm,
        approvedTerm: s.approvedTerm,
        context: s.context,
        confidence: s.confidence,
        learned: s.learned ?? false,
        glossarySource: s.glossarySource ?? null,
        relatedRows: s.relatedRows ?? [],
      })),
      stats: {
        cueCount: parsed.cues.length,
        glossaryTerms: rows.length,
        dropped,
        // So the UI can say name checking was skipped rather than silently
        // implying every name in the file was verified.
        game: game || null,
        wiki: wiki ?? null,
        rosterAvailable: Boolean(roster),
        rosterNote,
        learnedCorrections: learned.corrected,
        learnedSuppressions: learned.suppressed,
        costUsd: result.cost,
        cacheHitPct: result.usage.input
          ? Math.round((result.usage.cached / result.usage.input) * 100)
          : 0,
      },
    })
  } catch (error) {
    if (error instanceof GlossaryCheckUnavailable) {
      return res.status(503).json({ message: error.message })
    }
    logger.error({ action: "SRT_GLOSSARY_CHECK_ERROR", userId: req.userId, userName: req.userName, err: error })
    // A rate limit is temporary and self-correcting; say so rather than implying
    // the file or the configuration is at fault.
    const message = (error as Error).message || ""
    if (/rate limit|429/i.test(message)) {
      return res.status(429).json({
        message:
          "OpenAI is rate limiting this account right now. Wait a minute and run the check again.",
      })
    }
    return res.status(502).json({ message: "The glossary check could not complete. Please try again." })
  }
}

/** POST /srt/export — body: { srtText, edits: [{cueIndex, find, replace}] } */
export async function exportSrt(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })
    if (!canUseSrtChecker(req.userRole, req.userPosition)) {
      return res.status(403).json({ message: "This tool is available to translators and admins only." })
    }

    const srtText = typeof req.body?.srtText === "string" ? req.body.srtText : ""
    const rawEdits = Array.isArray(req.body?.edits) ? req.body.edits : []

    if (!srtText.trim()) return res.status(400).json({ message: "No subtitle file content was received." })
    if (srtText.length > MAX_SRT_CHARS) {
      return res.status(413).json({ message: "That subtitle file is too large." })
    }

    const edits: SrtEdit[] = rawEdits
      .filter(
        (e: any) =>
          e && Number.isInteger(e.cueIndex) && typeof e.find === "string" && typeof e.replace === "string"
      )
      .map((e: any) => ({ cueIndex: e.cueIndex, find: e.find, replace: e.replace }))

    let before
    try {
      before = parseSrt(srtText)
    } catch (error) {
      if (error instanceof SrtParseError) {
        return res.status(400).json({ message: "That .srt file could not be read.", detail: error.message })
      }
      throw error
    }

    const { next, applied, rejected } = applyEdits(before, edits)
    const changed = new Set(applied.map((edit) => edit.cueIndex))

    // Remember what was decided, so the next file doesn't repeat a suggestion the
    // translator has already corrected or turned down. Downloading is the moment
    // of commitment, which makes it the honest place to learn from.
    const language = typeof req.body?.language === "string" ? req.body.language.trim() : ""
    const rawDecisions = Array.isArray(req.body?.decisions) ? req.body.decisions : []
    if (language && rawDecisions.length > 0) {
      const decisions: TermDecision[] = rawDecisions
        .filter(
          (d: any) =>
            d &&
            typeof d.findText === "string" &&
            typeof d.suggestedText === "string" &&
            ["accepted", "edited", "rejected"].includes(d.outcome)
        )
        .map((d: any) => ({
          findText: d.findText,
          suggestedText: d.suggestedText,
          finalText: typeof d.finalText === "string" ? d.finalText : null,
          outcome: d.outcome,
          kind: typeof d.kind === "string" ? d.kind : "glossary",
        }))
      const saved = await recordDecisions(decisions, language, req.userId)
      if (saved > 0) {
        logger.info({ action: "SRT_TERM_DECISIONS_RECORDED", userId: req.userId, language, saved })
      }
    }

    // Serializes, re-parses, and re-checks every timestamp against the original.
    // Throws rather than returning anything it can't prove is intact.
    const corrected = serializeVerified(before, next, changed)

    logger.info({
      action: "SRT_GLOSSARY_EXPORT",
      userId: req.userId,
      userName: req.userName,
      requested: edits.length,
      applied: applied.length,
      rejected: rejected.length,
      cues: before.cues.length,
    })

    return res.json({
      srtText: corrected,
      applied: applied.length,
      rejected: rejected.length,
      hasBom: before.hasBom,
    })
  } catch (error) {
    if (error instanceof SrtInvariantError) {
      // The safety check failed: never hand back a file we can't verify.
      logger.error({
        action: "SRT_INVARIANT_VIOLATION",
        userId: req.userId,
        userName: req.userName,
        err: (error as Error).message,
      })
      return res.status(500).json({ message: "The corrected file failed its safety check and was not produced." })
    }
    logger.error({ action: "SRT_GLOSSARY_EXPORT_ERROR", userId: req.userId, userName: req.userName, err: error })
    return res.status(500).json({ message: "The corrected file could not be produced." })
  }
}

/**
 * English function words. A glossary "term" made up only of these (e.g. "to the")
 * is noise in a reference list, so it's dropped.
 */
const EN_STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "at", "for", "and", "or", "but", "is",
  "are", "be", "by", "with", "as", "it", "this", "that", "from", "into",
])

/**
 * Trim reference-scan noise, per cue:
 *   - drop a match whose text is entirely function words ("to the")
 *   - when two matches overlap in the same line, keep the longer phrase
 *     ("Upper Bracket" over "Bracket", "Grand Final" over "Final")
 */
function cleanReferenceHits<T extends { cueIndex: number; find: string }>(hits: T[]): T[] {
  const allStop = (term: string) =>
    term
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((w) => EN_STOPWORDS.has(w))

  const byCue = new Map<number, T[]>()
  for (const h of hits) {
    if (allStop(h.find)) continue
    const list = byCue.get(h.cueIndex) ?? []
    list.push(h)
    byCue.set(h.cueIndex, list)
  }

  const out: T[] = []
  for (const list of byCue.values()) {
    // Longest first, so a phrase is kept before the shorter terms inside it.
    const sorted = [...list].sort((a, b) => b.find.length - a.find.length)
    const kept: T[] = []
    const seen = new Set<string>()
    for (const h of sorted) {
      const lower = h.find.toLowerCase()
      if (seen.has(lower)) continue
      // Skip if a longer kept term already contains this one as a whole word.
      const contained = kept.some((k) =>
        new RegExp(`(?<![\\p{L}\\p{N}])${escapeForRegex(lower)}(?![\\p{L}\\p{N}])`, "u").test(
          k.find.toLowerCase()
        )
      )
      if (contained) continue
      seen.add(lower)
      kept.push(h)
    }
    out.push(...kept)
  }
  return out
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * POST /srt/en-reference — body: { srtText, target: "ar" | "fr" }
 *
 * The "EN reference" tab: given an ENGLISH subtitle, list every reference-glossary
 * term found in it with its approved Arabic/French translation and the line it
 * appears in. A read-only lookup — no model call, no file output, no persistence.
 * Reuses the same deterministic literal scan the checker uses.
 */
export async function enReferenceCheck(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })
    if (!canUseSrtChecker(req.userRole, req.userPosition)) {
      return res.status(403).json({ message: "This tool is available to translators and admins only." })
    }

    const srtText = typeof req.body?.srtText === "string" ? req.body.srtText : ""
    const target = (typeof req.body?.target === "string" ? req.body.target.trim().toLowerCase() : "") as EnReferenceTarget

    if (!srtText.trim()) return res.status(400).json({ message: "No subtitle file content was received." })
    if (target !== "ar" && target !== "fr") {
      return res.status(400).json({ message: "Choose a target language (Arabic or French)." })
    }
    if (srtText.length > MAX_SRT_CHARS) {
      return res.status(413).json({ message: "That subtitle file is too large to check." })
    }

    let parsed
    try {
      parsed = parseSrt(srtText)
    } catch (error) {
      if (error instanceof SrtParseError) {
        return res.status(400).json({ message: "That .srt file could not be read.", detail: error.message })
      }
      throw error
    }
    if (parsed.cues.length === 0) return res.status(400).json({ message: "That file contains no subtitles." })
    if (parsed.cues.length > MAX_CUES) {
      return res.status(413).json({ message: "That subtitle file has too many lines to check." })
    }

    let glossary
    try {
      glossary = await getEnReference()
    } catch (error) {
      logger.warn({ action: "EN_REFERENCE_UNAVAILABLE", err: (error as Error).message })
      return res.status(503).json({ message: "The reference glossary is temporarily unavailable." })
    }

    const rows = entriesForTarget(glossary, target)
    if (rows.length === 0) {
      return res.status(409).json({ message: `The reference glossary has no ${target === "ar" ? "Arabic" : "French"} terms.` })
    }

    // Same deterministic scan the checker uses: find each English source term in
    // the (English) subtitle text; the "replace" it returns is the translation.
    const hits = scanLiteralTerms(parsed.cues, rows)
    const cueText = new Map(parsed.cues.map((c) => [c.index, c.textLines.join("\n")]))
    const cueTiming = new Map(parsed.cues.map((c) => [c.index, { start: c.startRaw, end: c.endRaw }]))

    const cleaned = cleanReferenceHits(hits)

    const matches = cleaned
      .map((h, i) => {
        const timing = cueTiming.get(h.cueIndex)
        return {
          id: `${h.cueIndex}-${i}`,
          cueIndex: h.cueIndex,
          term: h.find,
          translation: h.replace,
          start: timing?.start ?? "",
          end: timing?.end ?? "",
          line: cueText.get(h.cueIndex) ?? "",
        }
      })
      .sort((a, b) => a.cueIndex - b.cueIndex)

    // When the caller sends the target-language cues (from the corrected file),
    // pin each term to the Arabic/French line that is actually the translation of
    // its English line — timestamp overlap alone misplaces terms onto lines that
    // merely share a time span. Terms with no genuine counterpart are dropped.
    const rawArCues = Array.isArray(req.body?.arCues) ? req.body.arCues : []
    let aligned = matches.map((m) => ({ ...m, arCueIndex: null as number | null }))
    if (rawArCues.length > 0 && matches.length > 0) {
      const arCues = rawArCues
        .filter((c: any) => c && Number.isInteger(c.index) && typeof c.text === "string")
        .map((c: any) => ({
          index: c.index as number,
          text: String(c.text),
          s: tsToMs(String(c.start ?? "")),
          e: tsToMs(String(c.end ?? "")),
        }))

      // One entry per English cue that has terms, with its time-overlapping
      // candidate target lines.
      const enByCue = new Map<number, { text: string; s: number; e: number }>()
      for (const m of matches) {
        if (!enByCue.has(m.cueIndex)) {
          enByCue.set(m.cueIndex, { text: m.line, s: tsToMs(m.start), e: tsToMs(m.end) })
        }
      }
      const enCues = [...enByCue.entries()].map(([index, en]) => ({
        index,
        text: en.text,
        candidates: arCues
          .filter((c: { s: number; e: number }) => c.s < en.e && c.e > en.s)
          .map((c: { index: number; text: string }) => ({ index: c.index, text: c.text })),
      }))

      try {
        const mapping = await alignEnglishToTarget(enCues, target === "ar" ? "Arabic" : "French")
        aligned = matches
          .map((m) => ({ ...m, arCueIndex: mapping.get(m.cueIndex) ?? null }))
          .filter((m) => m.arCueIndex !== null)
      } catch (error) {
        // If alignment fails, fall back to unaligned matches rather than nothing.
        logger.warn({ action: "SRT_EN_REFERENCE_ALIGN_FAILED", err: (error as Error).message })
      }
    }

    logger.info({
      action: "SRT_EN_REFERENCE",
      userId: req.userId,
      userName: req.userName,
      target,
      cues: parsed.cues.length,
      glossaryTerms: rows.length,
      matches: aligned.length,
      aligned: rawArCues.length > 0,
    })

    return res.json({
      target,
      stats: { cueCount: parsed.cues.length, glossaryTerms: rows.length, matches: aligned.length },
      matches: aligned,
    })
  } catch (error) {
    logger.error({ action: "SRT_EN_REFERENCE_ERROR", userId: req.userId, userName: req.userName, err: error })
    return res.status(500).json({ message: "The reference check could not complete. Please try again." })
  }
}

/*
  QC PROOFREADER
  ==============
  Drop in a subtitle file + its language; the model fixes mechanical grammar,
  spelling, capitalization, and punctuation — leaving proper nouns (player/team
  names, brands, game terms) untouched. Returns the per-cue corrections
  (full corrected text + individual before/after/reason changes). Timings are
  never touched; the client applies changes to text only.
*/
export async function qcCheck(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })
    if (!canUseSrtChecker(req.userRole, req.userPosition)) {
      return res.status(403).json({ message: "This tool is available to translators and admins only." })
    }
    if (!qcConfigured()) {
      return res.status(503).json({ message: "The QC proofreader is not configured yet." })
    }

    const srtText = typeof req.body?.srtText === "string" ? req.body.srtText : ""
    const language = typeof req.body?.language === "string" ? req.body.language.trim() : ""
    if (!srtText.trim()) return res.status(400).json({ message: "No subtitle file content was received." })
    if (!language) return res.status(400).json({ message: "Choose a language first." })
    if (srtText.length > MAX_SRT_CHARS) {
      return res.status(413).json({ message: "That subtitle file is too large to check." })
    }

    let parsed
    try {
      parsed = parseSrt(srtText)
    } catch (error) {
      if (error instanceof SrtParseError) {
        return res.status(400).json({ message: "That .srt file could not be read.", detail: error.message })
      }
      throw error
    }
    if (parsed.cues.length === 0) return res.status(400).json({ message: "That file contains no subtitles." })
    if (parsed.cues.length > MAX_CUES) {
      return res.status(413).json({ message: "That subtitle file has too many lines to check." })
    }

    const cues = parsed.cues.map((c) => ({ index: c.index, text: c.textLines.join("\n") }))
    let corrections
    try {
      corrections = await proofreadCues(cues, language)
    } catch (error) {
      if (error instanceof ProofreadUnavailable) {
        return res.status(503).json({ message: error.message })
      }
      logger.error({ action: "SRT_QC_ERROR", userId: req.userId, userName: req.userName, err: error })
      return res.status(502).json({ message: "The proofreader could not complete. Please try again." })
    }

    return res.json({
      cues: parsed.cues.map((cue) => ({
        index: cue.index,
        start: cue.startRaw,
        end: cue.endRaw,
        text: cue.textLines.join("\n"),
      })),
      corrections,
      stats: { cueCount: parsed.cues.length, changedCues: corrections.length },
    })
  } catch (error) {
    logger.error({ action: "SRT_QC_UNEXPECTED", userId: req.userId, userName: req.userName, err: error })
    return res.status(500).json({ message: "Something went wrong while proofreading." })
  }
}
