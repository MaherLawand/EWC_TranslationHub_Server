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

/**
 * Which vendor's delivery links a user may see.
 *
 * A delivery link carries a `vendor` of "TRANSLATOR" | "TRANSPERFECT" | "TARJAMA",
 * or "" for a shared "General" set. Admins/PPMs/Producers see every vendor; a
 * translator-side user sees only the General set plus their OWN vendor's links.
 *
 * Returns null to mean "no restriction — show all vendors".
 */
export function canSeeAllDeliveryVendors(role?: string | null, position?: string | null): boolean {
  if (role === "ADMIN") return true
  // Only the three vendor roles are restricted; everyone else (Producer, PPM,
  // Video Editor, Viewer, Editor) sees everything.
  return !isTranslatorPosition(position)
}

/** Whether a user may see a delivery link with the given vendor tag. */
export function canSeeDeliveryVendor(
  vendor: string | null | undefined,
  role?: string | null,
  position?: string | null
): boolean {
  if (canSeeAllDeliveryVendors(role, position)) return true
  const v = (vendor ?? "").trim()
  // General ("") is shared; otherwise it must match the user's own position.
  return v === "" || v === position
}

/** The positions the pills offer as email recipients (order matters for display). */
export const NOTIFY_POSITION_OPTIONS = ["TRANSLATOR", "TRANSPERFECT", "TARJAMA"] as const

/** Keep only valid notify-position values from arbitrary input. */
export function sanitizeNotifyPositions(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const allowed = new Set<string>(NOTIFY_POSITION_OPTIONS as readonly string[])
  return [...new Set(input.filter((v): v is string => typeof v === "string" && allowed.has(v)))]
}

/**
 * Order visibility for translator-side roles.
 *
 * The Notify pills act as an assignment: once an order names the roles that get
 * its source-file email, only those roles may see it. Admins and every non-
 * translator position (Producer, PPM, Video Editor, Viewer, Editor) are
 * unrestricted. Orders with no selection yet stay visible to all three
 * translator roles.
 *
 * Returns a Prisma where-fragment to AND into the query, or null for no filter.
 */
export function orderVisibilityWhere(
  role?: string | null,
  position?: string | null
): Record<string, unknown> | null {
  const ownMatch = translatorNotifyMatch(role, position)
  if (!ownMatch) return null

  // A big order (parent) has no selection of its own — it's an aggregator — so it
  // must NOT be treated as "unassigned = visible to all". It's visible only when
  // at least one of its sub-orders is visible to this role. A standalone order or
  // a sub-order is judged by its own selection.
  return {
    OR: [
      { isParent: false, ...ownMatch },
      { isParent: true, subOrders: { some: ownMatch } },
    ],
  }
}

/**
 * The bare "own selection" match for a translator-side role: the order is
 * unassigned (no pills yet) or explicitly names this role. Returns null for
 * roles that see everything (admins and every non-translator position), meaning
 * "no restriction".
 *
 * Exposed on its own so the order list can fold it into a SINGLE sub-order
 * `some` together with a status filter. A parent must have one sub-order that is
 * both in the active status AND visible to the role — using two independent
 * `some` clauses would let a parent through when one sub matches the status and a
 * different sub is the visible one, showing the big order with zero rows on
 * expand.
 */
export function translatorNotifyMatch(
  role?: string | null,
  position?: string | null
): Record<string, unknown> | null {
  if (role === "ADMIN") return null
  if (!isTranslatorPosition(position)) return null
  const pos = position as string
  return {
    OR: [{ notifyPositions: { isEmpty: true } }, { notifyPositions: { has: pos } }],
  }
}

/** Whether a single already-loaded order is visible to this user. */
export function canSeeOrder(
  role: string | null | undefined,
  position: string | null | undefined,
  notifyPositions: string[] | null | undefined
): boolean {
  if (role === "ADMIN") return true
  if (!isTranslatorPosition(position)) return true
  const list = notifyPositions ?? []
  return list.length === 0 || list.includes(position as string)
}
