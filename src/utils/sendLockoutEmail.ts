import { Resend } from "resend"

const resend = new Resend(process.env.RESEND_API_KEY)

/**
 * @param activated - false when the account has never had a password set
 *   (invited but invite never completed). In that case we don't show a
 *   "Reset Password" button — the user should contact their admin instead.
 */
export async function sendLockoutEmail(email: string, activated = true) {
  const CLIENT_URL = process.env.CLIENT_URL
  if (!CLIENT_URL) throw new Error("Missing env var: CLIENT_URL")

  const forgotPasswordUrl = `${CLIENT_URL}/forgot-password`

  const wasntYouHtml = activated
    ? `
      <p style="margin:0 0 16px 0; color:#8E8E8E; font-size:13px; line-height:1.6;">
        Reset your password immediately to secure your account.
      </p>
      <div style="text-align:center;">
        <a
          href="${forgotPasswordUrl}"
          style="
            display:inline-block;
            background:#D6B36A;
            color:black;
            text-decoration:none;
            padding:16px 32px;
            border-radius:14px;
            font-weight:bold;
            font-size:15px;
          "
        >
          Reset My Password
        </a>
      </div>`
    : `
      <p style="margin:0; color:#8E8E8E; font-size:13px; line-height:1.6;">
        Your account has not been set up yet. Contact your admin to report this
        and to resend your invitation email.
      </p>`

  const wasntYouText = activated
    ? `Reset your password immediately: ${forgotPasswordUrl}`
    : `Your account has not been set up yet. Contact your admin to report this and to resend your invitation email.`

  await resend.emails.send({
    from: "EWC Translations <translations@ewctranslations.org>",
    to: email,
    replyTo: "translations@ewctranslations.org",
    subject: "EWC Translation Hub — Account Temporarily Locked",

    text: `
EWC Translation Hub — Account Temporarily Locked

Your account (${email}) was locked after 5 failed sign-in attempts.
It will unlock automatically in 5 minutes.

Was this you?
No action needed — your account unlocks in 5 minutes. You can also ask your admin to clear the lockout immediately.

Wasn't you?
${wasntYouText}

Security Notice:
EWC Translation Hub will never ask for your password by email.
Official domain: ewctranslations.org

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
          Security Alert
        </p>
      </div>

      <h2 style="margin-top:0; color:white; font-size:24px;">
        Account Temporarily Locked
      </h2>

      <p style="color:#B0B0B0; line-height:1.7; font-size:15px;">
        Your account was locked after
        <strong style="color:#F5F1E8;">5 failed sign-in attempts</strong>.
        It will unlock automatically in
        <strong style="color:#D6B36A;">5 minutes</strong>.
      </p>

      <div
        style="
          background:#0d1a0d;
          border:1px solid rgba(74,222,128,0.2);
          border-radius:16px;
          padding:18px;
          margin-top:25px;
        "
      >
        <p style="margin:0 0 8px 0; color:#4ade80; font-weight:bold; font-size:14px;">
          ✓ &nbsp;Was this you?
        </p>
        <p style="margin:0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          No action needed. Your account will unlock automatically in 5 minutes.
          You can also ask your admin to clear the lockout immediately.
        </p>
      </div>

      <div
        style="
          background:#1a0a0a;
          border:1px solid rgba(248,113,113,0.2);
          border-radius:16px;
          padding:18px;
          margin-top:16px;
          margin-bottom:25px;
        "
      >
        <p style="margin:0 0 10px 0; color:#f87171; font-weight:bold; font-size:14px;">
          ✕ &nbsp;Wasn't you?
        </p>
        ${wasntYouHtml}
      </div>

      <div
        style="
          background:#161616;
          border:1px solid #2A2A2A;
          border-radius:16px;
          padding:18px;
        "
      >
        <p style="margin:0 0 10px 0; color:#D6B36A; font-weight:bold; font-size:14px;">
          Security Notice
        </p>
        <p style="margin:0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          EWC Translation Hub will never ask for your password by email.
          Only use the official button above and verify that the website domain is:
          <strong style="color:#F5F1E8;">ewctranslations.org</strong>
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
