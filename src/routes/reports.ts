import express from "express"
import { requireAuth } from "../middleware/auth.middleware.js"
import { requireReportOwner } from "../middleware/reportOwner.middleware.js"
import { generateDailyReport } from "../controllers/reports.controller.js"

const router = express.Router()

// Owner-only: build the daily report from an uploaded CSV and write it to the Sheet.
router.post("/daily", requireAuth, requireReportOwner, generateDailyReport)

export default router
