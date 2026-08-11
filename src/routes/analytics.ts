// ── ADMIN STATISTICS DASHBOARD (removable feature) ──
// Delete this file + controllers/analytics.controller.ts + the app.use line.
import express from "express"
import { requireAuth } from "../middleware/auth.middleware.js"
import { requireAdmin } from "../middleware/admin.middleware.js"
import { broadcastAnalytics, deliveryReport } from "../controllers/analytics.controller.js"

const router = express.Router()

// Admin only: broadcast per-order rows + marketing per-content-title for the
// statistics page (weekly breakdown).
router.get("/broadcast", requireAuth, requireAdmin, broadcastAnalytics)

// Admin only: per-order timing rows for the VIEW-ONLY daily report (late/early).
router.get("/delivery", requireAuth, requireAdmin, deliveryReport)

export default router
