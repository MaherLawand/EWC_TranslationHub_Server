import "dotenv/config"
import { createServer } from "http"
import { Server } from "socket.io"
import cookie from "cookie"
import jwt from "jsonwebtoken"
import app from "./app.js"
import { setIo } from "./lib/socket.js"
import { logger } from "./lib/logger.js"
import { prisma } from "./lib/prisma.js"

// Fail fast — missing these env vars means auth is silently broken
if (!process.env.JWT_SECRET) throw new Error("Missing env var: JWT_SECRET")
if (!process.env.CLIENT_URL) throw new Error("Missing env var: CLIENT_URL")

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

httpServer.listen(PORT, "0.0.0.0", () => {
  logger.info({ action: "SERVER_START", port: PORT })
})

process.on("SIGTERM", async () => {
  logger.info({ action: "GRACEFUL_SHUTDOWN" })
  await prisma.$disconnect()
  httpServer.close(() => process.exit(0))
})
