import { sendEmail } from "../lib/mailer.js"

// Escape user-supplied text before embedding in HTML, and keep line breaks.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export async function sendFeedbackEmail(args: {
  to: string[]
  authorName: string
  orderTitle: string
  message: string
  feedbackUrl: string
}) {
  const { to, authorName, orderTitle, message, feedbackUrl } = args
  if (!to.length) return

  const safeMessage = escapeHtml(message).replace(/\n/g, "<br/>")

  // Sent via BCC so translators don't see each other's addresses.
  await sendEmail({
    from: "EWC Translations <translations@ewctranslations.org>",
    to: "EWC Translations <translations@ewctranslations.org>",
    bcc: to,
    replyTo: "translations@ewctranslations.org",
    subject: `New feedback on "${orderTitle}"`,
    text: `
New Feedback

${authorName} left feedback on "${orderTitle}":

"${message}"

Open the order to view and reply to the feedback:

${feedbackUrl}

Security Notice:
This is an automated notification from EWC Translation Hub. Before clicking, make sure the link points to ewctranslations.org. If anything looks off, don't open it and contact your administrator.

© 2026 EWC Translation Hub
`,
    html: `
  <div
    style="
      background:#0B0B0B;
      padding:40px;
      font-family:Arial,sans-serif;
      color:#F5F1E8;
    "
  >

    <div
      style="
        max-width:600px;
        margin:auto;
        background:#111111;
        border:1px solid #242424;
        border-radius:24px;
        padding:40px;
      "
    >

      <div style="text-align:center; margin-bottom:32px;">
        <img
          src="https://ewctranslations.org/EWCLOGOEMAIL.png"
          alt="EWC Translation Hub"
          width="260"
          style="display:block; margin:0 auto 6px auto; width:400px; height:auto;"
        />
        <p style="color:#888; margin:0; font-size:14px;">
          New Feedback
        </p>
      </div>

      <h2 style="margin-top:0; color:white; font-size:24px;">
        New feedback added
      </h2>

      <p style="color:#B0B0B0; line-height:1.7; font-size:15px;">
        <strong style="color:#F5F1E8;">${escapeHtml(authorName)}</strong>
        left feedback on
        <strong style="color:#F5F1E8;">&ldquo;${escapeHtml(orderTitle)}&rdquo;</strong>.
      </p>

      <div
        style="
          background:#161616;
          border:1px solid #2A2A2A;
          border-left:3px solid #D6B36A;
          border-radius:14px;
          padding:18px 20px;
          margin:22px 0;
          color:#E6E1D6;
          font-size:15px;
          line-height:1.7;
        "
      >
        ${safeMessage}
      </div>

      <div style="margin-top:35px; margin-bottom:35px; text-align:center;">

        <!-- Bulletproof table-based button: the whole padded cell is clickable,
             which fixes Apple Mail not registering inline-block button clicks. -->
        <table role="presentation" border="0" cellspacing="0" cellpadding="0" align="center" style="margin:0 auto;">
          <tr>
            <td align="center" bgcolor="#D6B36A" style="border-radius:14px;">
              <a
                href="${feedbackUrl}"
                target="_blank"
                style="
                  display:inline-block;
                  background:#D6B36A;
                  color:#000000;
                  text-decoration:none;
                  padding:16px 32px;
                  border-radius:14px;
                  font-weight:bold;
                  font-size:15px;
                  font-family:Arial,sans-serif;
                  mso-padding-alt:16px 32px;
                "
              >
                View Feedback
              </a>
            </td>
          </tr>
        </table>

        <p style="color:#777; font-size:12px; line-height:1.7; margin-top:22px;">
          If the button doesn't work, copy and paste this link into your browser:<br/>
          <a href="${feedbackUrl}" style="color:#D6B36A; word-break:break-all;">${feedbackUrl}</a>
        </p>

      </div>

      <div
        style="
          background:#161616;
          border:1px solid #2A2A2A;
          border-radius:16px;
          padding:18px;
          margin-top:25px;
        "
      >
        <p style="margin:0 0 10px 0; color:#D6B36A; font-weight:bold; font-size:14px;">
          Security Notice
        </p>
        <p style="margin:0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          This is an automated notification from EWC Translation Hub.
          Before clicking, make sure the link points to
          <strong style="color:#F5F1E8;">ewctranslations.org</strong>.
          If anything looks off, don't open it and contact your administrator.
        </p>
      </div>

      <div
        style="
          margin-top:40px;
          padding-top:20px;
          border-top:1px solid #242424;
          text-align:center;
          color:#666;
          font-size:12px;
        "
      >
        © 2026 EWC Translation Hub
      </div>

    </div>

  </div>
`,
  })
}
