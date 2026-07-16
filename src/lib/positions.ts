// Translator-like positions. TRANSPERFECT and TARJAMA are vendor translator
// roles that share the exact same visibility and behavior as TRANSLATOR — any
// gate that checks for "translator" must include all three.
export const TRANSLATOR_POSITIONS = ["TRANSLATOR", "TRANSPERFECT", "TARJAMA"] as const

// Full set of assignable positions (used to validate user create/update input).
export const VALID_POSITIONS = [
  "PRODUCER",
  "POST_PRODUCTION_MANAGER",
  "TRANSLATOR",
  "TRANSPERFECT",
  "TARJAMA",
  "VIEWER",
  "EDITOR",
  "VIDEO_EDITOR",
] as const

// When an order has no explicit notify audience saved (legacy orders created
// before the pill selector), fall back to TransPerfect only.
export const DEFAULT_NOTIFY_POSITIONS = ["TRANSPERFECT"] as const

export function isTranslatorPosition(position?: string | null): boolean {
  return !!position && (TRANSLATOR_POSITIONS as readonly string[]).includes(position)
}

/** The positions the pills offer as email recipients (order matters for display). */
export const NOTIFY_POSITION_OPTIONS = ["TRANSLATOR", "TRANSPERFECT", "TARJAMA"] as const

/** Keep only valid notify-position values from arbitrary input. */
export function sanitizeNotifyPositions(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const allowed = new Set<string>(NOTIFY_POSITION_OPTIONS as readonly string[])
  return [...new Set(input.filter((v): v is string => typeof v === "string" && allowed.has(v)))]
}
