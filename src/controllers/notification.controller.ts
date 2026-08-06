import { prisma } from "../lib/prisma.js"
import { logger } from "../lib/logger.js"
import { sendEmail, sendMany } from "../lib/mailer.js"
import { triggerNotifications } from "../lib/socket.js"
import { DEFAULT_NOTIFY_POSITIONS, sanitizeNotifyPositions } from "../lib/positions.js"

// The positions that should receive an order's translator emails. Uses the
// order's saved pill selection; legacy orders with none fall back to TransPerfect.
function resolveNotifyPositions(saved?: unknown, override?: unknown): string[] {
  const fromOverride = sanitizeNotifyPositions(override)
  if (fromOverride.length) return fromOverride
  const fromSaved = sanitizeNotifyPositions(saved)
  if (fromSaved.length) return fromSaved
  return [...DEFAULT_NOTIFY_POSITIONS]
}

/**
 * Resolve the active users who should receive an order's source-file notification.
 *
 * - Vendor roles (TransPerfect / Tarjama) → every active user of that position.
 * - TRANSLATOR → only translators whose specialtyLanguages overlap the order's
 *   TARGET languages (they're "assigned" by specialty). No match → no translators.
 */
async function resolveRecipients(order: any, positionsOverride?: string[]): Promise<any[]> {
  const positions = resolveNotifyPositions(order?.notifyPositions, positionsOverride)
  const wantsTranslator = positions.includes("TRANSLATOR")
  const vendorPositions = positions.filter((p) => p !== "TRANSLATOR")

  const out: any[] = []

  if (vendorPositions.length) {
    out.push(
      ...(await prisma.user.findMany({
        where: { position: { in: vendorPositions as any }, isActive: true },
      }))
    )
  }

  if (wantsTranslator) {
    const detail = order?.type === "BROADCAST" ? order?.broadcast : order?.marketing
    const targetSet = new Set<string>(
      (detail?.targetLanguages ?? []).map((l: string) => String(l).toLowerCase())
    )
    // With no target languages there is nothing to match a specialty against.
    if (targetSet.size) {
      const translators = await prisma.user.findMany({
        where: { position: "TRANSLATOR", isActive: true },
      })
      out.push(
        ...translators.filter((t) =>
          (t.specialtyLanguages ?? []).some((l) => targetSet.has(String(l).toLowerCase()))
        )
      )
    }
  }

  // De-duplicate by id (a user can't hold two positions, but be safe).
  const seen = new Set<string>()
  return out.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)))
}

export async function notifyTranslatorsSourceReady(
  orderId: string,
  changed = false,
  positionsOverride?: string[]
) {
  try {

    const order =
      await prisma.translationOrder.findUnique({
        where: {
          id: orderId,
        },

        include: {
          broadcast: {
            include: {
              game: {
                include: {
                  assignedUsers: {
                    select: {
                      user: { select: { id: true } },
                    },
                  },
                },
              },

              deliveries: true,
              deliveryFormats:true,
            },
          },

          marketing: {
            include: {
              deliveries: true,
              deliveryFormats:true,
            },
          },

          // Parent (big order) title, so a sub-order's email reads
          // "Sub-order Title - Parent Title".
          parent: { select: { title: true } },
        },
      })

    if (!order) {
      return
    }

    // For a sub-order, show its parent big-order title alongside its own.
    const displayTitle = order.parentId && order.parent
      ? `${order.title} - ${order.parent.title}`
      : order.title

    /*
      VALIDATION
    */

    if (
      order.type === "BROADCAST" &&
      !order.broadcast?.game
    ) {
      return
    }

    /*
      SOURCE FILE REQUIRED
    */

    const sourceFileLink =
      order.type === "BROADCAST"
        ? order.broadcast?.sourceFileLink
        : order.marketing?.sourceFileLink

    if (!sourceFileLink) {
      logger.info({ action: "NOTIFY_SOURCE_READY_SKIP", orderId, reason: "no_source_link", type: order.type })
      return
    }

    // The link is stored exactly as entered. If it's missing a scheme, an <a href>
    // would be treated as relative and wouldn't open — prepend https:// for the href
    // while keeping the original text for display.
    const sourceFileHref = /^https?:\/\//i.test(sourceFileLink.trim())
      ? sourceFileLink.trim()
      : `https://${sourceFileLink.trim()}`

    /*
      GET TRANSLATORS
    */

    // Notify the active users chosen via the order's pills. Vendor roles get all
    // of their users; the Translator role is filtered to matching specialties.
    const uniqueTranslators = await resolveRecipients(order, positionsOverride)

    if (
      uniqueTranslators.length === 0
    ) {
      logger.info({ action: "NOTIFY_SOURCE_READY_SKIP", orderId, reason: "no_matching_recipients", positions: resolveNotifyPositions((order as any).notifyPositions, positionsOverride) })
      return
    }

    /*
      CREATE NOTIFICATIONS
    */

    const notifTitle = changed ? "Source File Updated" : "Source File Added"
    const notifMessage = changed
      ? `The source file for "${order.title}" was changed — your previous copy may be out of date`
      : `A source file was added for "${order.title}"`

    // Upsert so a CHANGE re-raises (unreads + refreshes) the existing
    // notification rather than being skipped as a duplicate.
    const raisedNotifs = []
    for (const translator of uniqueTranslators) {
      const n = await prisma.notification.upsert({
        where: {
          orderId_userId_type: { orderId: order.id, userId: translator.id, type: "STATUS_ADDED" },
        },
        update: { title: notifTitle, message: notifMessage, isRead: false, createdAt: new Date() },
        create: { title: notifTitle, message: notifMessage, type: "STATUS_ADDED", userId: translator.id, orderId: order.id },
        include: { order: { select: { id: true, title: true } } },
      })
      raisedNotifs.push(n)
    }

    triggerNotifications(
      raisedNotifs.map((n) => ({
        id: n.id, userId: n.userId, title: n.title, message: n.message,
        type: n.type, isRead: n.isRead, createdAt: n.createdAt,
        order: { id: order.id, title: order.title },
      }))
    ).catch(() => {})

    /*
      SEND EMAILS
    */

    const orderPage =
      order.type === "BROADCAST"
        ? "Broadcast"
        : "marketing"

    const orderLink = `${process.env.CLIENT_URL}?page=${orderPage}&orderId=${order.id}`

    // Wording differs for a brand-new source vs a replaced/changed one.
    const emailKicker = changed ? "Source File Updated" : "New Translation Task"
    const emailHeading = changed ? "Source File Updated" : "Source File Added"
    const emailIntro = changed
      ? "The source file for this order has been changed. Please use the updated source below — your previous copy may be out of date."
      : "A new source file has been added for translation. Click the button below to view the order and get started."
    const emailSubject = changed
      ? `Translation Source Updated — ${displayTitle}`
      : `New Translation Source Available — ${displayTitle}`
    const emailTextLead = changed
      ? "The source file for this order has been CHANGED. Please use the updated source."
      : "A new source file is available for translation."

    // Languages + deadline + tier for the email body.
    const detail = order.type === "BROADCAST" ? order.broadcast : order.marketing
    const sourceLangs = (detail?.sourceLanguage ?? []).join(", ").toUpperCase() || "—"
    const targetLangs = (detail?.targetLanguages ?? []).join(", ").toUpperCase() || "—"
    // Tier is broadcast-only (it lives on the game).
    const gameTier = order.type === "BROADCAST" ? order.broadcast?.game : null
    const tierText = gameTier
      ? `Tier ${gameTier.tier}${gameTier.tier1CN ? ", Tier 1 CN" : ""}`
      : ""
    const deadlineText = detail?.deadlineDate
      ? (detail.deadlineHasTime
          ? new Date(detail.deadlineDate).toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " UTC"
          : new Date(detail.deadlineDate).toLocaleDateString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }))
      : "—"

    logger.info({ action: "NOTIFY_SOURCE_READY_SENDING", orderId, recipients: uniqueTranslators.length, changed })

    const emails = uniqueTranslators.map((translator) => ({
            from:
  "EWC Translations <translations@ewctranslations.org>",

            to: translator.email,

            replyTo:
  "translations@ewctranslations.org",

text: `
${emailHeading}

${emailTextLead}

Order:
${displayTitle}

Department:
${order.type === "BROADCAST" ? "Broadcast" : "Marketing"}

${
  order.type === "BROADCAST"
    ? `Game: ${order.broadcast?.game?.name}`
    : `Content: ${order.marketing?.contentTitle || "Marketing Content"}`
}
${order.type === "BROADCAST" ? `\nTier:\n${tierText}\n` : ""}
Languages:
${sourceLangs} → ${targetLangs}

Deadline:
${deadlineText}

Delivery Formats:
${
  order.type === "BROADCAST"
    ? order.broadcast?.deliveryFormats
        ?.map((f) => f.format)
        .join(", ")
    : order.marketing?.deliveryFormats
        ?.map((f) => f.format)
        .join(", ")
}

Priority:
${order.priority}

Source File:
${sourceFileLink}

View Order:
${orderLink}

© 2026 EWC Translations
`,

            subject: emailSubject,

            html: `
  <div style="background:#0B0B0B; padding:40px; font-family:Arial,sans-serif; color:#F5F1E8;">

    <div style="max-width:600px; margin:auto; background:#111111; border:1px solid #242424; border-radius:24px; padding:40px;">

      <div style="text-align:center; margin-bottom:32px;">
        <img
          src="https://ewctranslations.org/EWCLOGOEMAIL.png"
          alt="EWC Translation Hub"
          width="260"
          style="display:block; margin:0 auto 6px auto; width:400px; height:auto;"
        />
        <p style="color:#888; margin:0; font-size:14px;">${emailKicker}</p>
      </div>

      <h2 style="margin-top:0; color:white; font-size:24px;">${emailHeading}</h2>

      <p style="color:#B0B0B0; line-height:1.7; font-size:15px;">
        ${emailIntro}
      </p>

      <div style="background:#161616; border:1px solid #2A2A2A; border-radius:16px; padding:18px; margin-top:25px;">
        <p style="margin:0 0 10px 0; color:#D6B36A; font-weight:bold; font-size:14px;">Order Details</p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Order:</strong> ${displayTitle}
        </p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Department:</strong> ${order.type === "BROADCAST" ? "Broadcast" : "Marketing"}
        </p>

        ${order.type === "BROADCAST"
          ? `<p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;"><strong style="color:#F5F1E8;">Game:</strong> ${order.broadcast?.game?.name}</p>`
          : `<p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;"><strong style="color:#F5F1E8;">Content:</strong> ${order.marketing?.contentTitle || "Marketing Content"}</p>`
        }

        ${order.type === "BROADCAST"
          ? `<p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;"><strong style="color:#F5F1E8;">Tier:</strong> ${tierText}</p>`
          : ``
        }

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Languages:</strong> ${sourceLangs} &rarr; ${targetLangs}
        </p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Deadline:</strong> ${deadlineText}
        </p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Delivery Format:</strong>
          ${order.type === "BROADCAST"
            ? order.broadcast?.deliveryFormats?.map((f) => f.format).join(", ")
            : order.marketing?.deliveryFormats?.map((f) => f.format).join(", ")
          }
        </p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Priority:</strong>
          <strong style="color:${order.priority === "HIGH" ? "#f87171" : order.priority === "MEDIUM" ? "#facc15" : "#4ade80"};">
            ${order.priority}
          </strong>
        </p>

        <p style="margin:8px 0 0 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Source File:</strong>
          <a href="${sourceFileHref}" style="color:#D6B36A; word-break:break-all;">${sourceFileLink}</a>
        </p>
      </div>

      <div style="margin-top:35px; margin-bottom:35px; text-align:center;">
        <a
          href="${orderLink}"
          style="display:inline-block; background:#D6B36A; color:black; text-decoration:none; padding:16px 32px; border-radius:14px; font-weight:bold; font-size:15px;"
        >
          View Order
        </a>

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
`,
    }))

    await sendMany(emails)

  } catch (error) {
    logger.error({ action: "NOTIFY_TRANSLATORS_ERROR", orderId, err: error })
  }
}

/*
  Notify every active translator that an order which HAD a source file was
  deleted, so they stop any in-flight translation work on it. Same branded
  template as the source-ready email, minus the "View Order" button (the order
  no longer exists). `order` is the pre-deletion snapshot (orderSelectCore shape).
  Fire-and-forget; suppressed outside production by the mailer guard.
*/
export async function notifyTranslatorsOrderDeleted(order: any) {
  try {
    if (!order) return

    const sourceFileLink =
      order.type === "BROADCAST"
        ? order.broadcast?.sourceFileLink
        : order.marketing?.sourceFileLink

    // Only notify when the deleted order actually had a source file.
    if (!sourceFileLink) return

    // A completed order needs no "stop work" notice — the translation is already
    // done, so deleting it shouldn't email anyone.
    if (order.status === "COMPLETED") return

    // For a sub-order, show its parent big-order title alongside its own.
    const displayTitle = order.parentId && order.parent
      ? `${order.title} - ${order.parent.title}`
      : order.title

    const translators = await prisma.user.findMany({
      where: { position: { in: resolveNotifyPositions((order as any).notifyPositions) as any }, isActive: true },
      select: { id: true, email: true },
    })
    const recipients = translators.filter((t) => t.email)
    if (recipients.length === 0) return

    const kicker = "Order Removed"
    const heading = "Order Deleted"
    const intro =
      "The order below which had a source file for translation has been deleted. Please stop any work on it as it is no longer active."
    const subject = `Translation Order Removed — ${displayTitle}`

    const gameOrContentLabel = order.type === "BROADCAST" ? "Game" : "Content"
    const gameOrContentValue =
      order.type === "BROADCAST"
        ? order.broadcast?.game?.name ?? "-"
        : order.marketing?.contentTitle || "Marketing Content"
    const formats =
      (order.type === "BROADCAST"
        ? order.broadcast?.deliveryFormats
        : order.marketing?.deliveryFormats
      )?.map((f: any) => f.format).join(", ") || "-"

    logger.info({ action: "NOTIFY_ORDER_DELETED_SENDING", orderId: order.id, recipients: recipients.length })

    const emails = recipients.map((translator) => ({
          from: "EWC Translations <translations@ewctranslations.org>",
          to: translator.email,
          replyTo: "translations@ewctranslations.org",
          subject,
          text: `
${heading}

${intro}

Order:
${displayTitle}

Department:
${order.type === "BROADCAST" ? "Broadcast" : "Marketing"}

${gameOrContentLabel}:
${gameOrContentValue}

Delivery Format:
${formats}

Priority:
${order.priority}

© 2026 EWC Translation Hub
`,
          html: `
  <div style="background:#0B0B0B; padding:40px; font-family:Arial,sans-serif; color:#F5F1E8;">

    <div style="max-width:600px; margin:auto; background:#111111; border:1px solid #242424; border-radius:24px; padding:40px;">

      <div style="text-align:center; margin-bottom:32px;">
        <img
          src="https://ewctranslations.org/EWCLOGOEMAIL.png"
          alt="EWC Translation Hub"
          width="260"
          style="display:block; margin:0 auto 6px auto; width:400px; height:auto;"
        />
        <p style="color:#888; margin:0; font-size:14px;">${kicker}</p>
      </div>

      <h2 style="margin-top:0; color:white; font-size:24px;">${heading}</h2>

      <p style="color:#B0B0B0; line-height:1.7; font-size:15px;">
        ${intro}
      </p>

      <div style="background:#161616; border:1px solid #2A2A2A; border-radius:16px; padding:18px; margin-top:25px;">
        <p style="margin:0 0 10px 0; color:#D6B36A; font-weight:bold; font-size:14px;">Order Details</p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Order:</strong> ${displayTitle}
        </p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Department:</strong> ${order.type === "BROADCAST" ? "Broadcast" : "Marketing"}
        </p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">${gameOrContentLabel}:</strong> ${gameOrContentValue}
        </p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Delivery Format:</strong> ${formats}
        </p>

        <p style="margin:0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Priority:</strong>
          <strong style="color:${order.priority === "HIGH" ? "#f87171" : order.priority === "MEDIUM" ? "#facc15" : "#4ade80"};">
            ${order.priority}
          </strong>
        </p>
      </div>

      <div style="background:#2A1616; border:1px solid #4A2020; border-left:3px solid #f87171; border-radius:14px; padding:16px 18px; margin-top:22px;">
        <p style="margin:0; color:#F0B4B4; font-size:14px; line-height:1.6;">
          Please stop any translation work on this order — it has been removed and can no longer be opened.
        </p>
      </div>

      <div style="margin-top:40px; padding-top:20px; border-top:1px solid #242424; text-align:center; color:#666; font-size:12px;">
        © 2026 EWC Translation Hub
      </div>

    </div>

  </div>
`,
    }))

    await sendMany(emails)
  } catch (error) {
    logger.error({ action: "NOTIFY_ORDER_DELETED_ERROR", orderId: order?.id, err: error })
  }
}

/*
  Notify every active translator that an order's source file was REMOVED (the
  order itself still exists). Same branded template as the source-ready email.
  Fire-and-forget; suppressed outside production by the mailer guard.
*/
export async function notifyTranslatorsSourceRemoved(orderId: string) {
  try {
    const order = await prisma.translationOrder.findUnique({
      where: { id: orderId },
      include: {
        broadcast: { include: { game: true, deliveryFormats: true } },
        marketing: { include: { deliveryFormats: true } },
        parent: { select: { title: true } },
      },
    })
    if (!order) return

    // For a sub-order, show its parent big-order title alongside its own.
    const displayTitle = order.parentId && order.parent
      ? `${order.title} - ${order.parent.title}`
      : order.title

    // Same audience as the source-ready email (vendor roles in full; translators
    // filtered by specialty against the order's target languages).
    const translators = await resolveRecipients(order)
    const recipients = translators.filter((t) => t.email)
    if (recipients.length === 0) return

    const orderPage = order.type === "BROADCAST" ? "Broadcast" : "marketing"
    const orderLink = `${process.env.CLIENT_URL}?page=${orderPage}&orderId=${order.id}`

    const kicker = "Source File Removed"
    const heading = "Source File Removed"
    const intro =
      "The source file for this order has been removed. Please stop using the previous source — there is currently no source available for translation on this order."
    const subject = `Translation Source Removed — ${displayTitle}`

    const gameOrContentLabel = order.type === "BROADCAST" ? "Game" : "Content"
    const gameOrContentValue =
      order.type === "BROADCAST"
        ? order.broadcast?.game?.name ?? "-"
        : order.marketing?.contentTitle || "Marketing Content"
    const formats =
      (order.type === "BROADCAST"
        ? order.broadcast?.deliveryFormats
        : order.marketing?.deliveryFormats
      )?.map((f) => f.format).join(", ") || "-"

    logger.info({ action: "NOTIFY_SOURCE_REMOVED_SENDING", orderId, recipients: recipients.length })

    const emails = recipients.map((translator) => ({
          from: "EWC Translations <translations@ewctranslations.org>",
          to: translator.email,
          replyTo: "translations@ewctranslations.org",
          subject,
          text: `
${heading}

${intro}

Order:
${displayTitle}

Department:
${order.type === "BROADCAST" ? "Broadcast" : "Marketing"}

${gameOrContentLabel}:
${gameOrContentValue}

Delivery Format:
${formats}

Priority:
${order.priority}

View Order:
${orderLink}

© 2026 EWC Translation Hub
`,
          html: `
  <div style="background:#0B0B0B; padding:40px; font-family:Arial,sans-serif; color:#F5F1E8;">

    <div style="max-width:600px; margin:auto; background:#111111; border:1px solid #242424; border-radius:24px; padding:40px;">

      <div style="text-align:center; margin-bottom:32px;">
        <img
          src="https://ewctranslations.org/EWCLOGOEMAIL.png"
          alt="EWC Translation Hub"
          width="260"
          style="display:block; margin:0 auto 6px auto; width:400px; height:auto;"
        />
        <p style="color:#888; margin:0; font-size:14px;">${kicker}</p>
      </div>

      <h2 style="margin-top:0; color:white; font-size:24px;">${heading}</h2>

      <p style="color:#B0B0B0; line-height:1.7; font-size:15px;">
        ${intro}
      </p>

      <div style="background:#161616; border:1px solid #2A2A2A; border-radius:16px; padding:18px; margin-top:25px;">
        <p style="margin:0 0 10px 0; color:#D6B36A; font-weight:bold; font-size:14px;">Order Details</p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Order:</strong> ${displayTitle}
        </p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Department:</strong> ${order.type === "BROADCAST" ? "Broadcast" : "Marketing"}
        </p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">${gameOrContentLabel}:</strong> ${gameOrContentValue}
        </p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Delivery Format:</strong> ${formats}
        </p>

        <p style="margin:0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Priority:</strong>
          <strong style="color:${order.priority === "HIGH" ? "#f87171" : order.priority === "MEDIUM" ? "#facc15" : "#4ade80"};">
            ${order.priority}
          </strong>
        </p>
      </div>

      <div style="background:#2A1616; border:1px solid #4A2020; border-left:3px solid #f87171; border-radius:14px; padding:16px 18px; margin-top:22px;">
        <p style="margin:0; color:#F0B4B4; font-size:14px; line-height:1.6;">
          The source file for this order has been removed — please stop using the previous source until a new one is provided.
        </p>
      </div>

      <div style="margin-top:35px; margin-bottom:35px; text-align:center;">
        <a
          href="${orderLink}"
          style="display:inline-block; background:#D6B36A; color:black; text-decoration:none; padding:16px 32px; border-radius:14px; font-weight:bold; font-size:15px;"
        >
          View Order
        </a>

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
`,
    }))

    await sendMany(emails)
  } catch (error) {
    logger.error({ action: "NOTIFY_SOURCE_REMOVED_ERROR", orderId, err: error })
  }
}