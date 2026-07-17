/**
 * SIMULATE: "Source File Added" email — SINGLE RECIPIENT ONLY
 * ==========================================================
 * Renders the same email that notifyTranslatorsSourceReady() sends when a source
 * file is added, and delivers it to exactly ONE hard-coded address.
 *
 * WHY THIS EXISTS (and why it doesn't just call the real function):
 *   1. The real function resolves recipients BY POSITION (Translator /
 *      TransPerfect / Tarjama). On a typical order that's ~47 external vendor
 *      addresses. There is no per-address targeting.
 *   2. It bails early when the order has no sourceFileLink — so it can't preview
 *      a PENDING order at all.
 *   3. The intended recipient here is a POST_PRODUCTION_MANAGER, who is never in
 *      that recipient set, so filtering the real list would yield nobody.
 *
 * SAFETY:
 *   - RECIPIENT is a hard-coded constant. There is no flag to change it and no
 *     query that could return additional addresses. Fan-out is impossible.
 *   - Writes NOTHING: no notification rows, no sourceChangedAt, no status change.
 *     A single SELECT, then one sendEmail().
 *   - Dry-run by default. Requires --send to actually deliver.
 *
 * DRIFT CAVEAT: the markup below is a faithful copy of the template in
 * notification.controller.ts as of this writing. It is NOT imported, so if the
 * real template changes, this preview will fall behind.
 *
 * Usage (from server/):
 *   npx tsx prisma/scripts/simulate-source-email.ts                    # dry run — prints, sends nothing
 *   EMAIL_ENABLED=true npx tsx prisma/scripts/simulate-source-email.ts --send
 *   ... --order=<id>     # preview a different order
 *   ... --changed        # render the "Source File Updated" variant instead
 *
 * NOTE: DATABASE_URL currently points at PRODUCTION. This script only reads.
 */
import "dotenv/config"
import { prisma } from "../../src/lib/prisma.js"
import { sendEmail } from "../../src/lib/mailer.js"

/** Hard-coded on purpose. Do not parameterise this. */
const RECIPIENT = "r.kfoury@ext.efg.gg"

const DEFAULT_ORDER_ID = "cmrf74kh403jdti01bq7j0t1s"

function findArgument(args: string[], name: string): string {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : ""
}

async function main() {
  const args = process.argv.slice(2)
  const orderId = findArgument(args, "order") || DEFAULT_ORDER_ID
  const changed = args.includes("--changed")
  const reallySend = args.includes("--send")

  const order = await prisma.translationOrder.findUnique({
    where: { id: orderId },
    include: {
      broadcast: { include: { game: true, deliveryFormats: true } },
      marketing: { include: { deliveryFormats: true } },
    },
  })
  if (!order) {
    console.error(`Order ${orderId} not found.`)
    process.exit(1)
  }

  // ── Same derivations as notifyTranslatorsSourceReady ──────────────────────
  const orderPage = order.type === "BROADCAST" ? "Broadcast" : "marketing"
  const orderLink = `${process.env.CLIENT_URL || "https://ewctranslations.org/"}?page=${orderPage}&orderId=${order.id}`

  const emailKicker = changed ? "Source File Updated" : "New Translation Task"
  const emailHeading = changed ? "Source File Updated" : "Source File Added"
  const emailIntro = changed
    ? "The source file for this order has been changed. Please use the updated source below — your previous copy may be out of date."
    : "A new source file has been added for translation. Click the button below to view the order and get started."
  const emailSubject = changed
    ? `Translation Source Updated — ${order.title}`
    : `New Translation Source Available — ${order.title}`
  const emailTextLead = changed
    ? "The source file for this order has been CHANGED. Please use the updated source."
    : "A new source file is available for translation."

  const detail: any = order.type === "BROADCAST" ? order.broadcast : order.marketing
  const sourceLangs = (detail?.sourceLanguage ?? []).join(", ").toUpperCase() || "—"
  const targetLangs = (detail?.targetLanguages ?? []).join(", ").toUpperCase() || "—"
  const gameTier = order.type === "BROADCAST" ? order.broadcast?.game : null
  const tierText = gameTier ? `Tier ${gameTier.tier}${gameTier.tier1CN ? ", Tier 1 CN" : ""}` : ""
  const deadlineText = detail?.deadlineDate
    ? detail.deadlineHasTime
      ? new Date(detail.deadlineDate).toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " UTC"
      : new Date(detail.deadlineDate).toLocaleDateString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" })
    : "—"
  const formats =
    (order.type === "BROADCAST" ? order.broadcast?.deliveryFormats : order.marketing?.deliveryFormats)
      ?.map((f: any) => f.format)
      .join(", ") || "—"
  const priorityColor =
    order.priority === "HIGH" ? "#f87171" : order.priority === "MEDIUM" ? "#facc15" : "#4ade80"
  const row = (label: string, value: string, last = false) =>
    `<p style="margin:0 0 ${last ? "0" : "8px"} 0; color:#8E8E8E; font-size:13px; line-height:1.6;"><strong style="color:#F5F1E8;">${label}:</strong> ${value}</p>`

  const html = `
  <div style="background:#0B0B0B; padding:40px; font-family:Arial,sans-serif; color:#F5F1E8;">
    <div style="max-width:600px; margin:auto; background:#111111; border:1px solid #242424; border-radius:24px; padding:40px;">

      <div style="text-align:center; margin-bottom:32px;">
        <img src="https://ewctranslations.org/EWCLOGOEMAIL.png" alt="EWC Translation Hub" width="260" style="display:block; margin:0 auto 6px auto; width:400px; height:auto;" />
        <p style="color:#888; margin:0; font-size:14px;">${emailKicker}</p>
      </div>

      <h2 style="margin-top:0; color:white; font-size:24px;">${emailHeading}</h2>

      <p style="color:#B0B0B0; line-height:1.7; font-size:15px;">${emailIntro}</p>

      <div style="background:#161616; border:1px solid #2A2A2A; border-radius:16px; padding:18px; margin-top:25px;">
        <p style="margin:0 0 10px 0; color:#D6B36A; font-weight:bold; font-size:14px;">Order Details</p>
        ${row("Order", order.title)}
        ${row("Department", order.type === "BROADCAST" ? "Broadcast" : "Marketing")}
        ${
          order.type === "BROADCAST"
            ? row("Game", String(order.broadcast?.game?.name ?? "—"))
            : row("Content", order.marketing?.contentTitle || "Marketing Content")
        }
        ${order.type === "BROADCAST" ? row("Tier", tierText) : ""}
        ${row("Languages", `${sourceLangs} &rarr; ${targetLangs}`)}
        ${row("Deadline", deadlineText)}
        ${row("Delivery Format", formats)}
        <p style="margin:0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Priority:</strong>
          <strong style="color:${priorityColor};">${order.priority}</strong>
        </p>
      </div>

      <div style="margin-top:35px; margin-bottom:35px; text-align:center;">
        <a href="${orderLink}" style="display:inline-block; background:#D6B36A; color:black; text-decoration:none; padding:16px 32px; border-radius:14px; font-weight:bold; font-size:15px;">View Order</a>
        <p style="color:#777; font-size:12px; line-height:1.7; margin-top:22px;">
          If the button doesn't work, copy and paste this link into your browser:<br/>
          <a href="${orderLink}" style="color:#D6B36A; word-break:break-all;">${orderLink}</a>
        </p>
      </div>

      <div style="margin-top:40px; padding-top:20px; border-top:1px solid #242424; text-align:center; color:#666; font-size:12px;">
        © 2026 EWC Translation Hub
      </div>

    </div>
  </div>
`

  const text = `
${emailHeading}

${emailTextLead}

Order:
${order.title}

Department:
${order.type === "BROADCAST" ? "Broadcast" : "Marketing"}

${order.type === "BROADCAST" ? `Game: ${order.broadcast?.game?.name}` : `Content: ${order.marketing?.contentTitle || "Marketing Content"}`}
${order.type === "BROADCAST" ? `\nTier:\n${tierText}\n` : ""}
Languages:
${sourceLangs} → ${targetLangs}

Deadline:
${deadlineText}

Delivery Formats:
${formats}

Priority:
${order.priority}

View Order:
${orderLink}

© 2026 EWC Translations
`

  console.log("\n──────── SIMULATION ────────")
  console.log(`  order:     ${order.title}  (${order.type} / ${order.status})`)
  console.log(`  variant:   ${changed ? "Source File Updated (changed)" : "Source File Added (new)"}`)
  console.log(`  subject:   ${emailSubject}`)
  console.log(`  RECIPIENT: ${RECIPIENT}   ← the only address, hard-coded`)
  console.log(`  link:      ${orderLink}`)
  console.log("────────────────────────────\n")

  if (!reallySend) {
    console.log("Dry run — nothing sent. Re-run with --send to deliver:")
    console.log("  EMAIL_ENABLED=true npx tsx prisma/scripts/simulate-source-email.ts --send\n")
    return
  }

  const result = await sendEmail({
    from: "EWC Translations <translations@ewctranslations.org>",
    to: RECIPIENT, // single string — cannot fan out
    replyTo: "translations@ewctranslations.org",
    subject: emailSubject,
    text,
    html,
  })

  if ((result as any)?.data?.id === "dev-suppressed") {
    console.log("⚠️  Suppressed by the mailer guard — nothing left this machine.")
    console.log("    Re-run with EMAIL_ENABLED=true to actually deliver.\n")
  } else if ((result as any)?.error) {
    console.error("❌ Resend error:", (result as any).error)
    process.exit(1)
  } else {
    console.log(`✅ Sent to ${RECIPIENT} only.  id=${(result as any)?.data?.id ?? "?"}\n`)
  }
}

main()
  .catch((error) => { console.error(error); process.exit(1) })
  .finally(async () => { await prisma.$disconnect().catch(() => {}) })
