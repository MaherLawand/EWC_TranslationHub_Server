import "dotenv/config"
import { createServer } from "http"
import { Server } from "socket.io"
import cookie from "cookie"
import jwt from "jsonwebtoken"
import app from "./app.js"
import { setIo } from "./lib/socket.js"
import { logger } from "./lib/logger.js"
import { warmGlossary } from "./lib/glossary.js"
import { warmArabicPriority } from "./lib/arabicPriorityGlossary.js"
import { prisma } from "./lib/prisma.js"

// Fail fast — missing these env vars means auth is silently broken
if (!process.env.JWT_SECRET) throw new Error("Missing env var: JWT_SECRET")
if (!process.env.CLIENT_URL) throw new Error("Missing env var: CLIENT_URL")

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
})

// Make the io instance available to controllers via the socket lib module
setIo(io)

const PORT = Number(process.env.PORT) || 4000

httpServer.listen(PORT, () => {
  logger.info({ action: "SERVER_START", port: PORT })
  // Pre-load the terminology glossary so the first translator to run a
  // check does not wait on Google Sheets. Never throws.
  warmGlossary()
  warmArabicPriority()
})

process.on("SIGTERM", async () => {
  logger.info({ action: "GRACEFUL_SHUTDOWN" })
  await prisma.$disconnect()
  httpServer.close(() => process.exit(0))
})
