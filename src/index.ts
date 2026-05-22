import "dotenv/config"
import app from "./app.js"

// Fail fast — missing these env vars means auth is silently broken
if (!process.env.JWT_SECRET) throw new Error("Missing env var: JWT_SECRET")
if (!process.env.CLIENT_URL) throw new Error("Missing env var: CLIENT_URL")

app.listen(4000, () => {
  console.log("Server running on port 4000")
})