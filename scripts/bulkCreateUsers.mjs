// Bulk-create users by calling the REAL prod API endpoint (POST /auth/users),
// exactly like the website does — same validation, same invite (set-password)
// email per user, and the same CREATE_USER logs on the prod server.
//
// Each user is created as: role=USER, department=BROADCAST, position=VIEWER.
// First/last names are auto-derived from the email (editable below).
//
// Required env vars (provide at runtime — nothing secret is stored in this file):
//   API_URL         prod backend URL (e.g. https://ewc-translation-hub-server-production.up.railway.app)
//   ADMIN_EMAIL     an ADMIN account's email (used to authenticate)
//   ADMIN_PASSWORD  that admin's password
// Optional:
//   DRY_RUN=true    print what would happen (names) without calling the API
//
// Usage:
//   API_URL="https://...railway.app" ADMIN_EMAIL="you@..." ADMIN_PASSWORD="..." node scripts/bulkCreateUsers.mjs

const API_URL = process.env.API_URL
const ADMIN_EMAIL = process.env.ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const DRY_RUN = process.env.DRY_RUN === "true"

const RAW_EMAILS = [
  "hiantonkoev@gmail.com",
  "proksa.mp@gmail.com",
  "tjanczykowski@gmail.com",
  "kaamilwedzicha@gmail.com",
  "zeroql23@gmail.com",
  "TOMRYS@GMAIL.COM",
  "nataneffects@gmail.com",
  "jovan.rada@gmail.com",
  "strandberg.martin@gmail.com",
  "nathan.boulch@gmail.com",
  "hamza.berr55@gmail.com",
  "da.gatkiewicz@ext.efg.gg",
  "editorparadiseanton@gmail.com",
  "falsefruit91@gmail.com",
  "thefaybble159874@mail.ru",
  "floweplay@gmail.com",
  "codydobbins125@gmail.com",
  "domgatkiewicz@gmail.com",
  "Janixs1337@gmail.com",
  "Super8.biuro@gmail.com",
  "d-engel@quicknet.nl",
  "keyframegg@gmail.com",
  "widmofilm.business@gmail.com",
  "alexgoisbusiness@gmail.com",
  "ronanirish12@gmail.com",
  "rishabhrtrivedi@gmail.com",
  "editspace.post@gmail.com",
  "kenneth.dkp@gmail.com",
  "peirulim@hotmail.co.uk",
  "andreurife96@gmail.com",
  "albertosuneson@gmail.com",
  "oskarridder@gmail.com",
  "andreurife96@gmail.com", // duplicate — de-duped below
  "lukashykl100@gmail.com",
]

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

// Derive a first/last name from the email local part. Edit the entries above if
// you want specific names; single-token locals get last name "Viewer".
function deriveName(email) {
  const local = email.split("@")[0]
  const parts = local.split(/[._\-+]+/).filter(Boolean)
  if (parts.length >= 2) {
    return { firstName: cap(parts[0]), lastName: parts.slice(1).map(cap).join(" ") }
  }
  return { firstName: cap(parts[0] || local), lastName: "Viewer" }
}

async function login() {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
  if (!res.ok) {
    throw new Error(`Admin login failed: ${res.status} ${await res.text()}`)
  }
  const setCookie = res.headers.get("set-cookie")
  if (!setCookie) throw new Error("Login did not return a cookie")
  // Keep only the `token=...` part (before the first ";").
  return setCookie.split(";")[0]
}

async function main() {
  if (!API_URL || (!DRY_RUN && (!ADMIN_EMAIL || !ADMIN_PASSWORD))) {
    console.error("Missing env. Need API_URL (and ADMIN_EMAIL + ADMIN_PASSWORD unless DRY_RUN=true).")
    process.exit(1)
  }

  // Normalize + de-duplicate emails (lowercased).
  const seen = new Set()
  const emails = RAW_EMAILS.map((e) => e.trim().toLowerCase()).filter(
    (e) => e && !seen.has(e) && (seen.add(e), true)
  )

  console.log(`Target: ${API_URL}`)
  console.log(`Users to create: ${emails.length} (role=USER, department=BROADCAST, position=VIEWER)`)
  console.log(DRY_RUN ? "MODE: DRY RUN (no API calls)\n" : "MODE: LIVE\n")

  let cookie = ""
  if (!DRY_RUN) {
    cookie = await login()
    console.log("Admin authenticated.\n")
  }

  let created = 0, skipped = 0, failed = 0
  for (const email of emails) {
    const { firstName, lastName } = deriveName(email)
    if (DRY_RUN) {
      console.log(`• ${email}  →  ${firstName} ${lastName}`)
      continue
    }
    try {
      const res = await fetch(`${API_URL}/auth/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          firstName, lastName, email,
          role: "USER", department: "BROADCAST", position: "VIEWER",
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        console.log(`✓ created  ${email}  (${firstName} ${lastName})`)
        created++
      } else if (res.status === 400 && /already exists/i.test(data.message || "")) {
        console.log(`• skipped  ${email}  (already exists)`)
        skipped++
      } else {
        console.log(`✗ FAILED   ${email}  → ${res.status} ${data.message || ""}`)
        failed++
      }
    } catch (e) {
      console.log(`✗ ERROR    ${email}  → ${e.message}`)
      failed++
    }
    // Gentle pacing so we stay under the email rate limit and let each invite send.
    await new Promise((r) => setTimeout(r, 700))
  }

  console.log(`\nDone.  created=${created}  skipped=${skipped}  failed=${failed}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
