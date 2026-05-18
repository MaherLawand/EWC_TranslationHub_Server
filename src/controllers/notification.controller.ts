import { prisma } from "../lib/prisma.js"
import { Resend } from "resend"

const resend = new Resend(
  process.env.RESEND_API_KEY
)

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
                    include: {
                      user: true,
                    },
                  },
                },
              },

              deliveries: true,
            },
          },

          marketing: {
            include: {
              deliveries: true,
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
      return
    }

    /*
      GET TRANSLATORS
    */

    const translators =
      await prisma.user.findMany({
        where: {
          position: "TRANSLATOR",

          isActive: true,

          department:
            order.type ===
            "BROADCAST"
              ? "BROADCAST"
              : "MARKETING",
        },
      })

    if (
      translators.length === 0
    ) {
      return
    }

    /*
      REMOVE DUPLICATES
    */

    const uniqueTranslators =
      translators.filter(
        (
          translator,
          index,
          self
        ) =>
          index ===
          self.findIndex(
            (u) =>
              u.id ===
              translator.id
          )
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
      }
    )

    /*
      SEND EMAILS
    */

    await Promise.all(
      uniqueTranslators.map(
        async (translator) => {

          await resend.emails.send({
            from:
              "EWC Translations <noreply@ewctranslations.org>",

            to: translator.email,

            subject:
              `New Translation Source Available — ${order.title}`,

            html: `
<div
  style="
    margin:0;
    padding:0;
    background:#0a0a0a;
    font-family:Arial,sans-serif;
  "
>
  <table
    width="100%"
    cellpadding="0"
    cellspacing="0"
    style="
      background:#0a0a0a;
      padding:40px 20px;
    "
  >
    <tr>
      <td align="center">

        <table
          width="100%"
          cellpadding="0"
          cellspacing="0"
          style="
            max-width:600px;
            background:#111111;
            border:1px solid #242424;
            border-radius:24px;
            overflow:hidden;
          "
        >

          <!-- HEADER -->
          <tr>
            <td
              style="
                padding:40px 40px 24px;
                text-align:center;
                border-bottom:1px solid #1f1f1f;
              "
            >

              <p
                style="
                  margin:0;
                  color:#D6B36A;
                  font-size:12px;
                  letter-spacing:4px;
                  font-weight:700;
                  text-transform:uppercase;
                "
              >
                EWC TRANSLATIONS
              </p>

              <h1
                style="
                  margin:18px 0 0;
                  color:white;
                  font-size:30px;
                  line-height:1.1;
                "
              >
                New Translation Task
              </h1>

            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td
              style="
                padding:40px;
                color:#d4d4d4;
                font-size:15px;
                line-height:1.7;
              "
            >

              <p style="margin-top:0;">
                A new source file has been added for translation.
              </p>

              <div
                style="
                  background:#181818;
                  border:1px solid #2A2A2A;
                  border-radius:16px;
                  padding:20px;
                  margin:28px 0;
                "
              >

                <p style="margin:0 0 10px;">
                  <strong style="color:white;">
                    Order:
                  </strong>
                  ${order.title}
                </p>

                ${
                  order.type ===
                  "BROADCAST"
                    ? `
<p style="margin:0 0 10px;">
  <strong style="color:white;">
    Game:
  </strong>
  ${order.broadcast?.game?.name}
</p>
`
                    : `
<p style="margin:0 0 10px;">
  <strong style="color:white;">
    Content:
  </strong>
  ${order.marketing?.contentTitle || "Marketing Content"}
</p>
`
                }

                <p style="margin:0;">
                  <strong style="color:white;">
                    Delivery Format:
                  </strong>
                  ${
                    order.type ===
                    "BROADCAST"
                      ? order.broadcast?.deliveryFormat
                      : order.marketing?.deliveryFormat
                  }
                </p>

              </div>

              <div
                style="
                  text-align:center;
                  margin:40px 0;
                "
              >

                <a
                  href="${sourceFileLink}"
                  target="_blank"
                  style="
                    display:inline-block;
                    background:#D6B36A;
                    color:#000000;
                    text-decoration:none;
                    padding:16px 28px;
                    border-radius:14px;
                    font-size:15px;
                    font-weight:700;
                  "
                >
                  Open Source File
                </a>

              </div>

              <div
                style="
                  margin-top:32px;
                  display:flex;
                  align-items:center;
                  gap:12px;
                "
              >

                <span
                  style="
                    color:#9CA3AF;
                    font-size:14px;
                  "
                >
                  Priority:
                </span>

                <span
                  style="
                    display:inline-block;
                    padding:8px 14px;
                    border-radius:999px;
                    font-size:13px;
                    font-weight:700;
                    letter-spacing:0.04em;

                    ${
                      order.priority === "HIGH"
                        ? `
                          background:rgba(239,68,68,0.15);
                          color:#F87171;
                          border:1px solid rgba(239,68,68,0.35);
                        `
                        : order.priority === "MEDIUM"
                        ? `
                          background:rgba(250,204,21,0.12);
                          color:#FACC15;
                          border:1px solid rgba(250,204,21,0.30);
                        `
                        : `
                          background:rgba(34,197,94,0.12);
                          color:#4ADE80;
                          border:1px solid rgba(34,197,94,0.30);
                        `
                    }
                  "
                >
                  ${order.priority}
                </span>

              </div>

            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td
              style="
                padding:24px 40px;
                border-top:1px solid #1f1f1f;
                color:#777777;
                font-size:13px;
                text-align:center;
              "
            >
              © 2026 EWC Translations
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</div>
`,
          })
        }
      )
    )

  } catch (error) {
    console.error(
      "Failed to notify translators:",
      error
    )
  }
}