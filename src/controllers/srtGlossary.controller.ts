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
import { getGlossary, entriesForColumn, describeGlossaryFailure } from "../lib/glossary.js"
import { glossaryColumnFor, COLUMN_TO_LABEL, usesNonLatinScript } from "../lib/glossaryLanguages.js"
import { checkGlossary, isConfigured, GlossaryCheckUnavailable } from "../lib/glossaryCheck.js"
import { wikiForGame } from "../lib/games.js"
import { getRoster } from "../lib/liquipedia.js"
import { buildRosterIndex, type RosterIndex } from "../lib/nameCheck.js"

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

    const glossary = await getGlossary()
    const languages = glossary.languageColumns
      .map((column) => ({ column, label: COLUMN_TO_LABEL[column] ?? column }))
      .sort((a, b) => a.label.localeCompare(b.label))

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
    if (!column) {
      return res.status(409).json({ message: `No glossary is available for ${language}.` })
    }

    const glossary = await getGlossary()
    if (!glossary.languageColumns.includes(column)) {
      return res.status(409).json({ message: `No glossary is available for ${language}.` })
    }
    const rows = entriesForColumn(glossary, column)
    if (rows.length === 0) {
      return res.status(409).json({ message: `The glossary has no terms for ${language}.` })
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
        rosterNote = `Liquipedia could not be reached, so names were not checked. (${reason})`
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
    const suggestions = result.suggestions.filter((s) => applicable.has(`${s.cueIndex}::${s.find}`))
    const dropped = result.suggestions.length - suggestions.length

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
