import { Resend } from "resend"

const resend = new Resend(
  process.env.RESEND_API_KEY
)

export async function sendInviteEmail(
  email: string,
  token: string
) {
  const CLIENT_URL = process.env.CLIENT_URL
  if (!CLIENT_URL) throw new Error("Missing env var: CLIENT_URL")

  const inviteUrl =
    `${CLIENT_URL}/setup-password?token=${token}`

  await resend.emails.send({
    from:
  "EWC Translations <translations@ewctranslations.org>",

    to: email,

     replyTo:

    "translations@ewctranslations.org",

  subject:

    "EWC Translation Hub Invitation",

  text: `

EWC Translation Hub Invitation

You have been invited to join the EWC Translation Hub platform.

Your account has been created successfully.

To create your password and access your dashboard, open the link below:

${inviteUrl}

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

      <div style="text-align:center; margin-bottom:32px;">
        <img
          src="https://ewctranslations.org/EWCLOGOEMAIL.png"
          alt="EWC Translation Hub"
          width="260"
          style="display:block; margin:0 auto 6px auto; width:400px; height:auto;"
        />
        <p style="color:#888; margin:0; font-size:14px;">
          Official Invitation
        </p>
      </div>

      <h2
        style="
          margin-top:0;
          color:white;
          font-size:24px;
        "
      >
        You've been invited
      </h2>

      <p
        style="
          color:#B0B0B0;
          line-height:1.7;
          font-size:15px;
        "
      >
        Your account has been created for
        the EWC Translation Hub platform.
        Click the button below to securely
        create your password and access
        your dashboard.
      </p>

      <div
        style="
          margin-top:35px;
          margin-bottom:35px;
          text-align:center;
        "
      >

        <!-- Bulletproof table-based button: the whole padded cell is clickable,
             which fixes Apple Mail not registering inline-block button clicks. -->
        <table role="presentation" border="0" cellspacing="0" cellpadding="0" align="center" style="margin:0 auto;">
          <tr>
            <td align="center" bgcolor="#D6B36A" style="border-radius:14px;">
              <a
                href="${inviteUrl}"
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
                Set Your Password
              </a>
            </td>
          </tr>
        </table>

        <p style="color:#777; font-size:12px; line-height:1.7; margin-top:22px;">
          If the button doesn't work, copy and paste this link into your browser:<br/>
          <a href="${inviteUrl}" style="color:#D6B36A; word-break:break-all;">${inviteUrl}</a>
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
`
  })
}