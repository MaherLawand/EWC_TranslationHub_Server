import { prisma } from "../lib/prisma.js"
import { logger } from "../lib/logger.js"
import { sendEmail } from "../lib/mailer.js"

export async function notifyTranslatorsSourceReady(
  orderId: string
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
        },
      })

    if (!order) {
      return
    }

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

    /*
      GET TRANSLATORS
    */

    // Every active translator is notified when a source file is added,
    // regardless of department.
    const translators =
      await prisma.user.findMany({
        where: {
          position: "TRANSLATOR",
          isActive: true,
        },
      })

    if (
      translators.length === 0
    ) {
      logger.info({ action: "NOTIFY_SOURCE_READY_SKIP", orderId, reason: "no_active_translators" })
      return
    }

    /*
      REMOVE DUPLICATES — O(n) via Set
    */

    const seen = new Set<string>()
    const uniqueTranslators = translators.filter(
      (t) => seen.has(t.id) ? false : (seen.add(t.id), true)
    )

    /*
      CREATE NOTIFICATIONS
    */

    await prisma.notification.createMany(
      {
        data:
          uniqueTranslators.map(
            (translator) => ({
              title:
                "Source File Added",

              message: `A source file was added for "${order.title}"`,

              type:
                "STATUS_ADDED",

              userId:
                translator.id,

              orderId:
                order.id,
            })
          ),

        skipDuplicates: true,
      }
    )

    /*
      SEND EMAILS
    */

    const orderPage =
      order.type === "BROADCAST"
        ? "Broadcast"
        : "marketing"

    const orderLink = `${process.env.CLIENT_URL}?page=${orderPage}&orderId=${order.id}`

    logger.info({ action: "NOTIFY_SOURCE_READY_SENDING", orderId, recipients: uniqueTranslators.length })

    await Promise.all(
      uniqueTranslators.map(
        async (translator) => {

          await sendEmail({
            from:
  "EWC Translations <translations@ewctranslations.org>",

            to: translator.email,

            replyTo:
  "translations@ewctranslations.org",

text: `
Translation Source Ready

A new source file is available for translation.

Order:
${order.title}

Department:
${order.type === "BROADCAST" ? "Broadcast" : "Marketing"}

${
  order.type === "BROADCAST"
    ? `Game: ${order.broadcast?.game?.name}`
    : `Content: ${order.marketing?.contentTitle || "Marketing Content"}`
}

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

View Order:
${orderLink}

© 2026 EWC Translations
`,

            subject:
              `New Translation Source Available — ${order.title}`,

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
        <p style="color:#888; margin:0; font-size:14px;">New Translation Task</p>
      </div>

      <h2 style="margin-top:0; color:white; font-size:24px;">Source File Added</h2>

      <p style="color:#B0B0B0; line-height:1.7; font-size:15px;">
        A new source file has been added for translation. Click the button below to view the order and get started.
      </p>

      <div style="background:#161616; border:1px solid #2A2A2A; border-radius:16px; padding:18px; margin-top:25px;">
        <p style="margin:0 0 10px 0; color:#D6B36A; font-weight:bold; font-size:14px;">Order Details</p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Order:</strong> ${order.title}
        </p>

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Department:</strong> ${order.type === "BROADCAST" ? "Broadcast" : "Marketing"}
        </p>

        ${order.type === "BROADCAST"
          ? `<p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;"><strong style="color:#F5F1E8;">Game:</strong> ${order.broadcast?.game?.name}</p>`
          : `<p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;"><strong style="color:#F5F1E8;">Content:</strong> ${order.marketing?.contentTitle || "Marketing Content"}</p>`
        }

        <p style="margin:0 0 8px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Delivery Format:</strong>
          ${order.type === "BROADCAST"
            ? order.broadcast?.deliveryFormats?.map((f) => f.format).join(", ")
            : order.marketing?.deliveryFormats?.map((f) => f.format).join(", ")
          }
        </p>

        <p style="margin:0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          <strong style="color:#F5F1E8;">Priority:</strong>
          <strong style="color:${order.priority === "HIGH" ? "#f87171" : order.priority === "MEDIUM" ? "#facc15" : "#4ade80"};">
            ${order.priority}
          </strong>
        </p>
      </div>

      <div style="margin-top:35px; margin-bottom:35px; text-align:center;">
        <a
          href="${orderLink}"
          style="display:inline-block; background:#D6B36A; color:black; text-decoration:none; padding:16px 32px; border-radius:14px; font-weight:bold; font-size:15px;"
        >
          View Order
        </a>
      </div>

      <div style="margin-top:40px; padding-top:20px; border-top:1px solid #242424; text-align:center; color:#666; font-size:12px;">
        © 2026 EWC Translation Hub
      </div>

    </div>

  </div>
`,
          })
        }
      )
    )

  } catch (error) {
    logger.error({ action: "NOTIFY_TRANSLATORS_ERROR", orderId, err: error })
  }
}