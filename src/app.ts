import express from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import path from "path"
import helmet from "helmet"

import authRoutes from "./routes/auth.routes.js"
import userRoutes from "./routes/user.routes.js"
import orderRoutes from "./routes/orders.js"
import gameRoutes from "./routes/games.routes.js"

const app = express()

// Security headers
app.use(helmet())

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
)

// 1 MB body limit — prevents memory exhaustion from large payloads
app.use(express.json({ limit: "1mb" }))

app.use(cookieParser())

app.use("/auth", authRoutes)

app.use("/users", userRoutes)

app.use("/orders", orderRoutes)

app.use("/games", gameRoutes)

app.use(
  "/game-logos",
  express.static(
    path.resolve(
      "src/uploads/games"
    )
  )
)

app.get("/", (_, res) => {
  res.send("API WORKING")
})

export default app