import { Resend } from "resend"

const resend = new Resend(process.env.RESEND_API_KEY)

export async function sendResetEmail(email: string, token: string) {
  const CLIENT_URL = process.env.CLIENT_URL
  if (!CLIENT_URL) throw new Error("Missing env var: CLIENT_URL")

  const resetUrl = `${CLIENT_URL}/reset-password?token=${token}`

  await resend.emails.send({
    from: "EWC Translations <translations@ewctranslations.org>",
    to: email,
    replyTo: "translations@ewctranslations.org",
    subject: "EWC Translation Hub — Password Reset",

    text: `
EWC Translation Hub — Password Reset

We received a request to reset the password for your account.

To set a new password, open the link below:

${resetUrl}

This link expires in 1 hour.

Didn't request this? Do NOT click the link above. Someone may have entered your email by mistake. Your password will NOT change unless you click the link and complete the process.

Security Notice:

EWC Translation Hub will never ask for your password by email.

Official domain:

ewctranslations.org

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

      <div
        style="
          text-align:center;
          margin-bottom:32px;
        "
      >

        <h1
          style="
            margin:0;
            font-size:32px;
            color:#D6B36A;
          "
        >
          EWC Translation Hub
        </h1>

        <p
          style="
            color:#888;
            margin-top:10px;
            font-size:14px;
          "
        >
          Password Reset
        </p>

      </div>

      <h2
        style="
          margin-top:0;
          color:white;
          font-size:24px;
        "
      >
        Reset your password
      </h2>

      <p
        style="
          color:#B0B0B0;
          line-height:1.7;
          font-size:15px;
        "
      >
        We received a request to reset the password for your account.
        Click the button below to set a new password.
        This link expires in
        <strong style="color:#F5F1E8;">1 hour</strong>.
      </p>

      <div
        style="
          margin-top:35px;
          margin-bottom:35px;
          text-align:center;
        "
      >

        <a
          href="${resetUrl}"
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
          Reset Password
        </a>

      </div>

      <div
        style="
          background:#1a0a0a;
          border:1px solid #3a1a1a;
          border-radius:16px;
          padding:18px;
          margin-top:10px;
        "
      >
        <p
          style="
            margin:0 0 6px 0;
            color:#f87171;
            font-weight:bold;
            font-size:14px;
          "
        >
          Didn't request this?
        </p>
        <p
          style="
            margin:0;
            color:#8E8E8E;
            font-size:13px;
            line-height:1.6;
          "
        >
          Do <strong style="color:#f87171;">not</strong> click the button above.
          Someone may have entered your email address by mistake.
          Your password will <strong style="color:#F5F1E8;">not</strong> change
          unless you click the button and complete the process.
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

        <p
          style="
            margin:0 0 10px 0;
            color:#D6B36A;
            font-weight:bold;
            font-size:14px;
          "
        >
          Security Notice
        </p>

        <p
          style="
            margin:0;
            color:#8E8E8E;
            font-size:13px;
            line-height:1.6;
          "
        >
          EWC Translation Hub will never
          ask for your password by email.
          Only use the official button above
          and verify that the website domain is:
          <strong style="color:#F5F1E8;">
            ewctranslations.org
          </strong>
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
