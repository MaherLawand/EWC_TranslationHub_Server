/**
 * Maps the app's language values onto the glossary sheet's column codes.
 *
 * The app stores languages as display NAMES ("Arabic", "Chinese"), not ISO codes —
 * see LANG_CODE_MAP in client/src/components/orders/LanguagesCell.tsx, which is
 * keyed by `l.name`. ISO codes are accepted too, purely defensively, so a caller
 * sending "ar" instead of "Arabic" still resolves.
 *
 * Note this is only the *candidate* mapping. Which columns actually exist is read
 * from the sheet's header row at fetch time (see glossary.ts), so a language listed
 * here but absent from the sheet correctly resolves to "no glossary available"
 * rather than silently returning zero suggestions.
 */

/** Lowercased app language value (name or ISO code) → glossary column header. */
const LANGUAGE_TO_COLUMN: Record<string, string> = {
  // Display names, as stored on orders.
  english: "eng",
  arabic: "ara",
  chinese: "chi",
  french: "fra",
  indonesian: "ind",
  filipino: "fil",
  hindi: "hin",

  // ISO / pill codes, accepted defensively.
  en: "eng",
  ar: "ara",
  zh: "chi",
  cn: "chi", // the app displays Chinese as "CN" (CODE_OVERRIDES in languages.ts)
  fr: "fra",
  id: "ind",
  tl: "fil",
  fil: "fil",
  hi: "hin",
}

/**
 * Resolve an app language to a glossary column code, or null when the glossary
 * has no column for it (e.g. the custom "Peru" entry, Portuguese variants).
 */
export function glossaryColumnFor(language: string): string | null {
  return LANGUAGE_TO_COLUMN[language.trim().toLowerCase()] ?? null
}

/**
 * Columns whose language does NOT use the Latin alphabet.
 *
 * For these, a run of Latin letters in a subtitle is unambiguously untranslated
 * English, which makes it detectable with no judgement at all. That's what powers
 * the untranslated-term pass. In French, Indonesian, or Filipino the same test
 * would flag every line, so the pass stays off for them.
 */
const NON_LATIN_COLUMNS = new Set(["ara", "chi", "hin"])

export function usesNonLatinScript(column: string): boolean {
  return NON_LATIN_COLUMNS.has(column)
}

/** Human label for a column code, used in error copy and the language picker. */
export const COLUMN_TO_LABEL: Record<string, string> = {
  eng: "English",
  ara: "Arabic",
  chi: "Chinese",
  fra: "French",
  ind: "Indonesian",
  fil: "Filipino",
  hin: "Hindi",
}
