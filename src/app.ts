import express from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import path from "path"

import authRoutes from "./routes/auth.routes.js"
import userRoutes from "./routes/user.routes.js"
import orderRoutes from "./routes/orders.js"
import gameRoutes from "./routes/games.routes.js"

const app = express()

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
)

app.use(express.json())

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