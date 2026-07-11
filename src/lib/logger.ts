/**
 * Structured logger for Railway logs.
 *
 * Every call emits a single JSON line to stdout (info/warn) or stderr (error).
 * Railway captures both streams and displays them in its log viewer.
 *
 * Shape of every log entry:
 *   { ts, level, action, userId?, ...contextFields }
 */

type Level = "info" | "warn" | "error"

interface BasePayload {
  /** Short SCREAMING_SNAKE name that identifies the event, e.g. "LOGIN", "CREATE_ORDER" */
  action: string
  /** The authenticated user performing the action (req.userId) */
  userId?: string
  /** "First Last" of the authenticated user (req.userName) — human-readable actor */
  userName?: string
  [key: string]: unknown
}

function emit(level: Level, payload: BasePayload & { err?: unknown }): void {
  const { err, ...rest } = payload

  const now = new Date()
  const entry: Record<string, unknown> = {
    // ISO instant (sortable/machine) + a human-readable local time so every log
    // line clearly shows WHEN it happened without decoding the ISO string.
    ts: now.toISOString(),
    time: now.toLocaleString("en-GB", { timeZone: "UTC", hour12: false }) + " UTC",
    level,
    ...rest,
  }

  if (err !== undefined) {
    entry.error =
      err instanceof Error
        ? { message: err.message, name: err.name }
        : { raw: String(err) }
  }

  const line = JSON.stringify(entry)

  if (level === "error") {
    console.error(line)
  } else {
    console.log(line)
  }
}

export const logger = {
  info:  (payload: BasePayload)                    => emit("info",  payload),
  warn:  (payload: BasePayload)                    => emit("warn",  payload),
  error: (payload: BasePayload & { err?: unknown }) => emit("error", payload),
}
