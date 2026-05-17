import nodemailer from "nodemailer"

const transporter = nodemailer.createTransport({
  service: "gmail",

  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
})

export async function sendInviteEmail(
  email: string,
  token: string
) {
  const CLIENT_URL =
  process.env.CLIENT_URL ||
  "http://ewctranslations.org/"

const inviteUrl =
  `${CLIENT_URL}/setup-password?token=${token}`
console.log(process.env.EMAIL_USER)
console.log(process.env.EMAIL_PASS)
  await transporter.sendMail({
    from: process.env.EMAIL_USER,

    to: email,

    subject: "EWC Translation Hub Invitation",

    html: `
      <div style="font-family:sans-serif">
        <h2>You were invited to EWC Translation Hub</h2>

        <p>Click below to create your password:</p>

        <a href="${inviteUrl}">
          Set Password
        </a>
      </div>
    `,
  })
}