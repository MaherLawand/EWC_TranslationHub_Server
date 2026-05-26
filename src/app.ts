import express from "express"
import type { Request, Response, NextFunction } from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import path from "path"
import helmet from "helmet"
import rateLimit from "express-rate-limit"

import authRoutes from "./routes/auth.routes.js"
import userRoutes from "./routes/user.routes.js"
import orderRoutes from "./routes/orders.js"
import gameRoutes from "./routes/games.routes.js"
import { logger } from "./lib/logger.js"

const app = express()

app.use(cors({
  origin: process.env.CLIENT_URL,
  credentials: true,
}))

// Security headers
app.use(helmet())

// 1 MB body limit — prevents memory exhaustion from large payloads
app.use(express.json({ limit: "1mb" }))

app.use(cookieParser())

// General API rate limiter — 300 requests per 15 min per IP
// Auth routes have their own tighter limiter (10 req/15 min).
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
})

app.use("/auth", authRoutes)

app.use("/users", apiLimiter, userRoutes)

app.use("/orders", apiLimiter, orderRoutes)

app.use("/games", apiLimiter, gameRoutes)

app.use(
  "/game-logos",
  // Helmet sets Cross-Origin-Resource-Policy: same-origin globally, which
  // blocks browsers from loading these images cross-origin (e.g. :5173 → :4000).
  // Override it to "cross-origin" for this static route only.
  (_req, res, next) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin")
    next()
  },
  express.static(
    path.resolve(
      "src/uploads/games"
    )
  )
)

app.get("/", (_, res) => {
  res.send("API WORKING")
})

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" })
})

// 404 — unknown route
app.use((_req: Request, res: Response) => {
  res.status(404).json({ message: "Not found" })
})

// Global error handler — catches any error thrown inside a route handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ action: "UNHANDLED_ERROR", err })
  res.status(500).json({ message: "Server error" })
})

export default app