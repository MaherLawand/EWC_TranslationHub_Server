import { Resend } from "resend"

const resend = new Resend(process.env.RESEND_API_KEY)

export async function sendLockoutEmail(email: string) {
  const CLIENT_URL = process.env.CLIENT_URL
  if (!CLIENT_URL) throw new Error("Missing env var: CLIENT_URL")

  const forgotPasswordUrl = `${CLIENT_URL}/forgot-password`

  await resend.emails.send({
    from: "EWC Translations <translations@ewctranslations.org>",
    to: email,
    replyTo: "translations@ewctranslations.org",
    subject: "EWC Translation Hub — Account Temporarily Locked",

    text: `
EWC Translation Hub — Account Temporarily Locked

Your account has been temporarily locked after multiple failed sign-in attempts.

Was this you?

YES — your account will unlock automatically in 5 minutes. No action needed.

NO — reset your password immediately to secure your account:
${forgotPasswordUrl}

Need help? Contact your admin to remove the lockout right away.

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

      <!-- HEADER -->
      <div style="text-align:center; margin-bottom:32px;">
        <h1 style="margin:0; font-size:32px; color:#D6B36A;">
          EWC Translation Hub
        </h1>
        <p style="color:#888; margin-top:10px; font-size:14px;">
          Security Alert
        </p>
      </div>

      <!-- LOCK ICON -->
      <div style="text-align:center; margin-bottom:28px;">
        <div
          style="
            display:inline-block;
            background:#f97316/10;
            background-color:rgba(249,115,22,0.10);
            border:1px solid rgba(249,115,22,0.25);
            border-radius:16px;
            padding:18px 22px;
          "
        >
          <span style="font-size:32px;">🔒</span>
        </div>
      </div>

      <h2 style="margin-top:0; color:white; font-size:22px; text-align:center;">
        Account Temporarily Locked
      </h2>

      <p style="color:#B0B0B0; line-height:1.7; font-size:15px; text-align:center;">
        Your account was locked after
        <strong style="color:#F5F1E8;">5 failed sign-in attempts</strong>.
        It will unlock automatically in
        <strong style="color:#D6B36A;">5 minutes</strong>.
      </p>

      <!-- WAS THIS YOU -->
      <div style="margin-top:32px; display:flex; flex-direction:column; gap:16px;">

        <!-- YES -->
        <div
          style="
            background:#0f1a0f;
            border:1px solid rgba(74,222,128,0.2);
            border-radius:16px;
            padding:18px 20px;
          "
        >
          <p style="margin:0 0 6px 0; color:#4ade80; font-weight:bold; font-size:14px;">
            ✓ &nbsp;Was this you?
          </p>
          <p style="margin:0; color:#8E8E8E; font-size:13px; line-height:1.6;">
            No action needed. Your account will unlock automatically in
            <strong style="color:#F5F1E8;">5 minutes</strong>.
            You can also ask your admin to clear the lockout immediately.
          </p>
        </div>

        <!-- NO -->
        <div
          style="
            background:#1a0a0a;
            border:1px solid rgba(248,113,113,0.2);
            border-radius:16px;
            padding:18px 20px;
          "
        >
          <p style="margin:0 0 6px 0; color:#f87171; font-weight:bold; font-size:14px;">
            ✕ &nbsp;Wasn't you?
          </p>
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
                padding:13px 28px;
                border-radius:12px;
                font-weight:bold;
                font-size:14px;
              "
            >
              Reset My Password
            </a>
          </div>
        </div>

      </div>

      <!-- SECURITY NOTICE -->
      <div
        style="
          background:#161616;
          border:1px solid #2A2A2A;
          border-radius:16px;
          padding:18px;
          margin-top:28px;
        "
      >
        <p style="margin:0 0 8px 0; color:#D6B36A; font-weight:bold; font-size:14px;">
          Security Notice
        </p>
        <p style="margin:0; color:#8E8E8E; font-size:13px; line-height:1.6;">
          EWC Translation Hub will never ask for your password by email.
          Only use the official button above and verify the website domain is:
          <strong style="color:#F5F1E8;">ewctranslations.org</strong>
        </p>
      </div>

      <!-- FOOTER -->
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
