// Deploy marker — no-op change to bump the build and test the new-update prompt.
import "dotenv/config"
import { createServer } from "http"
import { Server } from "socket.io"
import cookie from "cookie"
import jwt from "jsonwebtoken"
import app from "./app.js"
import { setIo } from "./lib/socket.js"
import { logger } from "./lib/logger.js"
import { warmArabicPriority } from "./lib/arabicPriorityGlossary.js"
import { warmEnReference } from "./lib/enReferenceGlossary.js"
import { prisma } from "./lib/prisma.js"

// Fail fast — missing these env vars means auth is silently broken
if (!process.env.JWT_SECRET) throw new Error("Missing env var: JWT_SECRET")
if (!process.env.CLIENT_URL) throw new Error("Missing env var: CLIENT_URL")

// Identifies this deployed build. Railway sets RAILWAY_GIT_COMMIT_SHA on every
// deploy, so it changes only when new code ships (a plain restart keeps the same
// SHA and won't force client reloads). Falls back to APP_VERSION, then to the
// boot time as a last resort. Sent to clients so they can auto-reload on deploy.
const APP_VERSION =
  process.env.RAILWAY_GIT_COMMIT_SHA || process.env.APP_VERSION || String(Date.now())

// Environment banner — prints the DB host (NEVER the password) on every boot so
// you can always confirm at a glance which database this process is pointed at.
;(() => {
  let dbHost = "unknown"
  let dbName = "unknown"
  try {
    const u = new URL(process.env.DATABASE_URL ?? "")
    dbHost = u.host
    dbName = u.pathname.replace(/^\//, "") || "unknown"
  } catch {
    /* malformed or missing DATABASE_URL — leave as "unknown" */
  }
  // Source of truth: an explicit APP_ENV label set per environment.
  //   local server/.env   → APP_ENV=dev
  //   Railway dashboard   → APP_ENV=prod
  // Neon endpoint IDs are random (e.g. "ep-purple-bar-...") so the host name
  // can't be trusted to tell dev from prod — the label can.
  const label = (process.env.APP_ENV ?? "").toLowerCase()
  const tag =
    label === "dev" || label === "development"
      ? "🟢 DEV"
      : label === "prod" || label === "production"
        ? "🔴 PROD"
        : "⚠️  UNLABELED (set APP_ENV=dev in server/.env)"
  // eslint-disable-next-line no-console
  console.log(
    "\n" +
      "────────────────────────────────────────────\n" +
      ` ENVIRONMENT CHECK\n` +
      ` APP_ENV  : ${process.env.APP_ENV ?? "(unset)"}\n` +
      ` NODE_ENV : ${process.env.NODE_ENV ?? "(unset)"}\n` +
      ` DB host  : ${dbHost}\n` +
      ` DB name  : ${dbName}\n` +
      ` Target   : ${tag}\n` +
      "────────────────────────────────────────────\n"
  )
})()

const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL,
    credentials: true,
  },
})

// Authenticate every socket connection using the same httpOnly JWT cookie
// the REST API uses — no separate handshake needed from the client.
io.use((socket, next) => {
  const cookies = cookie.parse(socket.handshake.headers.cookie || "")
  const token = cookies.token
  if (!token) return next(new Error("Unauthorized"))
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string }
    socket.data.userId = payload.userId
    next()
  } catch {
    next(new Error("Unauthorized"))
  }
})

io.on("connection", (socket) => {
  // Each user gets their own room — notifications are emitted to io.to(userId)
  socket.join(socket.data.userId)

  // Tell the client which build it's now talking to. The client anchors on the
  // first value it sees and reloads if it ever changes — so a redeploy (server
  // restarts → sockets reconnect → new SHA) hard-refreshes every open tab onto
  // the freshly deployed frontend. Uses the git SHA so a plain restart (same
  // code) does NOT force a reload; falls back to boot time only if unset.
  socket.emit("server-version", APP_VERSION)
})

// Make the io instance available to controllers via the socket lib module
setIo(io)

const PORT = Number(process.env.PORT) || 4000

httpServer.listen(PORT, () => {
  // `versionSource` tells you whether the deploy SHA was found (good) or we fell
  // back to boot time (which would re-prompt clients on every restart).
  const versionSource = process.env.RAILWAY_GIT_COMMIT_SHA
    ? "RAILWAY_GIT_COMMIT_SHA"
    : process.env.APP_VERSION
    ? "APP_VERSION"
    : "boot-time (fallback)"
  logger.info({ action: "SERVER_START", port: PORT, appVersion: APP_VERSION, versionSource })
  // Pre-load the terminology glossary so the first translator to run a
  // check does not wait on Google Sheets. Never throws.
  // The old main glossary (glossary.ts) is no longer used by the checker; the
  // reference glossary + Arabic priority are the sources now.
  warmArabicPriority()
  warmEnReference()
})

process.on("SIGTERM", async () => {
  logger.info({ action: "GRACEFUL_SHUTDOWN" })
  await prisma.$disconnect()
  httpServer.close(() => process.exit(0))
})
