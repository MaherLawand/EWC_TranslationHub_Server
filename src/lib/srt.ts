/**
 * SRT parsing, editing, and serialization — with a hard guarantee that timestamps
 * are never modified.
 *
 * THE GUARANTEE
 * =============
 * Subtitle timings are the one thing we must never touch. That guarantee is
 * structural here, not a matter of care or instructions:
 *
 *   - A cue's `startRaw` / `endRaw` / `separatorRaw` are the EXACT bytes read from
 *     the file, and they are `readonly` — assigning to them is a compile error.
 *   - Serialization writes those strings back verbatim. This file contains no date
 *     math, no `padStart`, no timestamp construction of any kind. There is
 *     literally no code path that can produce a timestamp string.
 *   - Edits only ever write to `textLines`.
 *   - `assertTimingsPreserved()` re-checks everything afterwards and throws, so a
 *     bug anywhere upstream fails closed instead of shipping a corrupted file.
 *
 * Parsing is deliberately liberal: CRLF or LF, BOM or no BOM, missing trailing
 * newline, non-sequential cue numbers, "," or "." decimal separators, and trailing
 * positioning coordinates are all accepted and preserved. Only a malformed
 * *timestamp line* is fatal — everything else round-trips byte-for-byte.
 */

/** One subtitle cue. Timing fields are readonly by design — see the file header. */
export type Cue = {
  /** Cue number as it appeared in the file (not necessarily sequential). */
  index: number
  /** Exact bytes of the start timestamp, e.g. "00:01:02,500". */
  readonly startRaw: string
  /** Exact bytes of the end timestamp. */
  readonly endRaw: string
  /**
   * Everything between the two timestamps plus anything trailing the end one —
   * usually " --> ", but may carry positioning coords ("X1:040 X2:600 ..."), which
   * we preserve without interpreting.
   */
  readonly separatorRaw: string
  /** The cue's text, one entry per line. The ONLY mutable part of a cue. */
  textLines: string[]
}

export type ParsedSrt = {
  cues: Cue[]
  /** Line ending used by the source file, reused on serialize. */
  eol: "\r\n" | "\n"
  /** Whether the source began with a UTF-8 BOM. */
  hasBom: boolean
  /** Whether the source ended with a newline. */
  trailingNewline: boolean
}

/** A single find/replace within one cue's text. */
export type SrtEdit = {
  /** Cue number (matches `Cue.index`, i.e. the number in the file). */
  cueIndex: number
  /** Exact substring to replace. Must occur verbatim in the cue, or the edit is rejected. */
  find: string
  /** Replacement text. */
  replace: string
  /** Optional provenance, carried through for logging and the review UI. */
  glossaryKey?: string
  sourceTerm?: string
  approvedTerm?: string
}

/** Why an edit could not be applied. */
export type RejectedEdit = {
  edit: SrtEdit
  reason: "cue_not_found" | "find_not_present" | "overlaps_earlier_edit"
}

export class SrtParseError extends Error {
  /** 1-based line number in the source file where parsing failed. */
  readonly line: number
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`)
    this.name = "SrtParseError"
    this.line = line
  }
}

/** Thrown when a post-edit safety check fails. Callers must fail closed on this. */
export class SrtInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SrtInvariantError"
  }
}

const BOM = "﻿"

/**
 * Timestamp line: two stamps separated by an arrow, with optional trailing
 * positioning data. Capture group 2 holds the separator and group 4 anything
 * after the end stamp — both preserved verbatim so the line round-trips exactly.
 * Accepts "," or "." as the decimal separator; we never normalize between them.
 */
const TIMESTAMP_LINE =
  /^(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})([ \t]*-->[ \t]*)(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})(.*)$/

/**
 * Parse an SRT file into cues.
 *
 * @throws {SrtParseError} only when a cue's timestamp line is malformed.
 */
export function parseSrt(text: string): ParsedSrt {
  const hasBom = text.startsWith(BOM)
  const body = hasBom ? text.slice(BOM.length) : text

  // Detect the dominant line ending before splitting so we can restore it exactly.
  const eol: "\r\n" | "\n" = body.includes("\r\n") ? "\r\n" : "\n"
  const trailingNewline = /\r?\n$/.test(body)

  // Split on \n and strip a trailing \r, so a mixed-ending file still parses.
  const lines = body.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))

  const cues: Cue[] = []
  let i = 0

  while (i < lines.length) {
    // Skip blank lines between cues.
    while (i < lines.length && lines[i].trim() === "") i++
    if (i >= lines.length) break

    const numberLineNo = i + 1
    const numberLine = lines[i].trim()

    // A cue normally starts with its number, but some files omit it. Only treat
    // this as a number line if the NEXT line is a timestamp; otherwise assume the
    // number was omitted and this line is already the timestamp.
    let index: number
    if (TIMESTAMP_LINE.test(numberLine)) {
      index = cues.length + 1 // number omitted — synthesize a sequential one
    } else {
      const parsed = Number.parseInt(numberLine, 10)
      if (!Number.isFinite(parsed)) {
        throw new SrtParseError(`Expected a cue number or timestamp, got "${truncate(numberLine)}"`, numberLineNo)
      }
      index = parsed
      i++
    }

    if (i >= lines.length) {
      throw new SrtParseError("File ended before the timestamp line", i)
    }

    const timeLineNo = i + 1
    const match = TIMESTAMP_LINE.exec(lines[i].trim())
    if (!match) {
      throw new SrtParseError(`Malformed timestamp line: "${truncate(lines[i])}"`, timeLineNo)
    }
    // Captured verbatim: never reformatted, never re-padded. Concatenating
    // startRaw + separatorRaw + endRaw reproduces the source line exactly; any
    // trailing positioning coords ride along on endRaw.
    const startRaw = match[1]
    const separatorRaw = match[2]
    const endRaw = match[3] + match[4]
    i++

    // Collect text until a blank line or EOF.
    const textLines: string[] = []
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i])
      i++
    }

    cues.push({ index, startRaw, separatorRaw, endRaw, textLines })
  }

  return { cues, eol, hasBom, trailingNewline }
}

/**
 * Rebuild an SRT file from parsed cues.
 *
 * Timestamps are written back as the exact strings that were read. Nothing in this
 * function constructs or formats a time value.
 */
export function serializeSrt(parsed: ParsedSrt): string {
  const blocks = parsed.cues.map((cue) =>
    [String(cue.index), cue.startRaw + cue.separatorRaw + cue.endRaw, ...cue.textLines].join(parsed.eol)
  )

  let out = blocks.join(parsed.eol + parsed.eol)
  if (parsed.trailingNewline) out += parsed.eol
  if (parsed.hasBom) out = BOM + out
  return out
}

/**
 * Apply edits to cue TEXT only, returning a new ParsedSrt.
 *
 * An edit is applied only if its `find` string occurs verbatim in the target cue.
 * This is the mechanical false-positive filter: a hallucinated or stale suggestion
 * simply can't match, so it's rejected here rather than corrupting the file.
 *
 * Within a cue, edits are applied right-to-left so earlier offsets stay valid, and
 * overlapping edits are dropped (first one wins).
 */
export function applyEdits(
  parsed: ParsedSrt,
  edits: SrtEdit[]
): { next: ParsedSrt; applied: SrtEdit[]; rejected: RejectedEdit[] } {
  const applied: SrtEdit[] = []
  const rejected: RejectedEdit[] = []

  // Clone cues. Timing fields are copied by reference — they're immutable strings,
  // and there is no code below that writes to them.
  const nextCues: Cue[] = parsed.cues.map((cue) => ({
    index: cue.index,
    startRaw: cue.startRaw,
    endRaw: cue.endRaw,
    separatorRaw: cue.separatorRaw,
    textLines: [...cue.textLines],
  }))

  const byIndex = new Map<number, Cue>()
  for (const cue of nextCues) if (!byIndex.has(cue.index)) byIndex.set(cue.index, cue)

  // Group edits per cue so we can resolve offsets and overlaps together.
  const grouped = new Map<number, SrtEdit[]>()
  for (const edit of edits) {
    const cue = byIndex.get(edit.cueIndex)
    if (!cue) {
      rejected.push({ edit, reason: "cue_not_found" })
      continue
    }
    const list = grouped.get(edit.cueIndex)
    if (list) list.push(edit)
    else grouped.set(edit.cueIndex, [edit])
  }

  for (const [cueIndex, cueEdits] of grouped) {
    const cue = byIndex.get(cueIndex)!
    // Operate on the joined text so a term spanning a line break still matches.
    const joined = cue.textLines.join("\n")

    // Resolve each edit to a concrete offset first, so overlap detection is exact.
    type Located = { edit: SrtEdit; start: number; end: number }
    const located: Located[] = []
    for (const edit of cueEdits) {
      if (edit.find === "") {
        rejected.push({ edit, reason: "find_not_present" })
        continue
      }
      const start = joined.indexOf(edit.find)
      if (start === -1) {
        rejected.push({ edit, reason: "find_not_present" })
        continue
      }
      located.push({ edit, start, end: start + edit.find.length })
    }

    // Keep edits in document order for overlap checks; first occurrence wins.
    located.sort((a, b) => a.start - b.start)
    const kept: Located[] = []
    let lastEnd = -1
    for (const item of located) {
      if (item.start < lastEnd) {
        rejected.push({ edit: item.edit, reason: "overlaps_earlier_edit" })
        continue
      }
      kept.push(item)
      lastEnd = item.end
    }

    // Apply right-to-left so earlier offsets remain valid.
    let text = joined
    for (let k = kept.length - 1; k >= 0; k--) {
      const { edit, start, end } = kept[k]
      text = text.slice(0, start) + edit.replace + text.slice(end)
      applied.push(edit)
    }

    cue.textLines = text.split("\n")
  }

  return {
    next: { cues: nextCues, eol: parsed.eol, hasBom: parsed.hasBom, trailingNewline: parsed.trailingNewline },
    applied,
    rejected,
  }
}

/**
 * Verify that editing changed nothing it shouldn't have.
 *
 * Callers must treat a throw as fatal and return no file — a partially-verified
 * subtitle export is worse than none.
 *
 * @param expectedChangedIndices cue indices that SHOULD have new text. Any other
 *   cue differing, or any of these not differing, is a bug.
 */
export function assertTimingsPreserved(
  before: ParsedSrt,
  after: ParsedSrt,
  expectedChangedIndices: Set<number>
): void {
  if (after.cues.length !== before.cues.length) {
    throw new SrtInvariantError(`Cue count changed: ${before.cues.length} → ${after.cues.length}`)
  }
  if (after.eol !== before.eol) throw new SrtInvariantError("Line ending changed")
  if (after.hasBom !== before.hasBom) throw new SrtInvariantError("BOM presence changed")
  if (after.trailingNewline !== before.trailingNewline) {
    throw new SrtInvariantError("Trailing newline changed")
  }

  const actualChanged = new Set<number>()

  for (let i = 0; i < before.cues.length; i++) {
    const b = before.cues[i]
    const a = after.cues[i]

    if (a.index !== b.index) {
      throw new SrtInvariantError(`Cue number changed at position ${i}: ${b.index} → ${a.index}`)
    }
    // The core check. String === is byte identity for the same encoding.
    if (a.startRaw !== b.startRaw || a.endRaw !== b.endRaw || a.separatorRaw !== b.separatorRaw) {
      throw new SrtInvariantError(`Timestamp changed on cue ${b.index}`)
    }
    if (a.textLines.join("\n") !== b.textLines.join("\n")) actualChanged.add(b.index)
  }

  for (const index of expectedChangedIndices) {
    if (!actualChanged.has(index)) {
      throw new SrtInvariantError(`Cue ${index} was expected to change but did not`)
    }
  }
  for (const index of actualChanged) {
    if (!expectedChangedIndices.has(index)) {
      throw new SrtInvariantError(`Cue ${index} changed unexpectedly`)
    }
  }
}

/**
 * Serialize and immediately re-parse, re-running the timing checks against the
 * original. Catches serializer bugs that a purely in-memory check would miss.
 *
 * @returns the verified SRT text.
 */
export function serializeVerified(
  before: ParsedSrt,
  after: ParsedSrt,
  expectedChangedIndices: Set<number>
): string {
  assertTimingsPreserved(before, after, expectedChangedIndices)
  const text = serializeSrt(after)
  const reparsed = parseSrt(text)
  assertTimingsPreserved(before, reparsed, expectedChangedIndices)
  return text
}

function truncate(s: string): string {
  const t = s.trim()
  return t.length > 60 ? `${t.slice(0, 60)}…` : t
}
