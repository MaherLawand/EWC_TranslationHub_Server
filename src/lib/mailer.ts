import { Resend } from "resend"

const resend = new Resend(process.env.RESEND_API_KEY)

/**
 * Whether real emails should actually be sent.
 *
 * Priority:
 *   1. EMAIL_ENABLED=true/false  → explicit override (wins over everything).
 *   2. APP_ENV / NODE_ENV        → only "prod"/"production" sends.
 *
 * Net effect: locally (APP_ENV=dev) emails are SUPPRESSED and logged to the
 * console instead, so testing invites/resets/notifications never hits real
 * inboxes through Resend. On Railway (APP_ENV=prod) emails send normally.
 */
function emailsEnabled(): boolean {
  const flag = (process.env.EMAIL_ENABLED ?? "").toLowerCase()
  if (flag === "true") return true
  if (flag === "false") return false
  const label = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "").toLowerCase()
  return label === "prod" || label === "production"
}

type SendArgs = Parameters<typeof resend.emails.send>[0]

/**
 * Drop-in replacement for `resend.emails.send`. Sends for real only when
 * emailsEnabled() is true; otherwise logs a summary (with any links pulled from
 * the text body) so you can still click invite/reset links during local dev.
 */
export async function sendEmail(args: SendArgs) {
  if (!emailsEnabled()) {
    const to = Array.isArray(args.to) ? args.to.join(", ") : args.to
    const text = typeof args.text === "string" ? args.text : ""
    const links = text.match(/https?:\/\/\S+/g) ?? []
    // eslint-disable-next-line no-console
    console.log(
      "\n📭 [EMAIL SUPPRESSED — non-production]\n" +
        `   to:      ${to}\n` +
        `   subject: ${args.subject ?? "(none)"}\n` +
        (links.length
          ? `   links:\n${links.map((l) => "      " + l).join("\n")}\n`
          : "")
    )
    return { data: { id: "dev-suppressed" }, error: null }
  }
  return resend.emails.send(args)
}

/**
 * Send many identical-content-but-different-recipient emails efficiently.
 *
 * Default: Resend's BATCH endpoint (up to 100 per API call) — turns N per-second
 * requests into ceil(N/100), so a 50-translator blast is a single request and
 * can't trip the rate limit.
 *
 * Kill switch: set EMAIL_BATCH_ENABLED=false to fall back to the original
 * per-recipient sends (exactly the pre-batch behavior) with no redeploy.
 *
 * Suppressed (non-production) like sendEmail — logs a one-line summary instead of
 * hitting Resend.
 */
export async function sendMany(emails: SendArgs[]) {
  if (emails.length === 0) return

  if (!emailsEnabled()) {
    // eslint-disable-next-line no-console
    console.log(
      "\n📭 [BATCH SUPPRESSED — non-production]\n" +
        `   recipients: ${emails.length}\n` +
        `   subject:    ${emails[0]?.subject ?? "(none)"}\n`
    )
    return
  }

  // Kill switch → original per-recipient behavior.
  if (process.env.EMAIL_BATCH_ENABLED === "false") {
    await Promise.all(emails.map((e) => resend.emails.send(e)))
    return
  }

  // Batch: Resend allows up to 100 emails per call.
  for (let i = 0; i < emails.length; i += 100) {
    await resend.batch.send(emails.slice(i, i + 100) as any)
  }
}
