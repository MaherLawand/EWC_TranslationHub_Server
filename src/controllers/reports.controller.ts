import type { Response } from "express"
import type { AuthRequest } from "../middleware/auth.middleware.js"
import { logger } from "../lib/logger.js"
import {
  runDailyReport,
  tabNameFromFile,
} from "../../prisma/scripts/daily-report-google-sheets.js"

/**
 * Generate the daily orders report from an uploaded Railway logs CSV and write it
 * to the shared Google Sheet — the same logic as the CLI script, so it can be run
 * from a phone via the web app. Owner-gated by the route (requireReportOwner).
 *
 * Body: { csvText: string, filename?: string, date?: string }
 *   - csvText  the CSV content (Railway logs export)
 *   - filename used to name the report tab, preserving the current naming scheme
 *   - date     optional YYYY-MM-DD filter (only events on that UTC day)
 */
export async function generateDailyReport(req: AuthRequest, res: Response) {
  try {
    const { csvText, filename, date } = req.body ?? {}

    if (typeof csvText !== "string" || !csvText.trim()) {
      return res.status(400).json({ message: "A CSV is required." })
    }

    const sheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || ""
    if (!sheetId) {
      return res
        .status(500)
        .json({ message: "GOOGLE_SHEETS_SPREADSHEET_ID is not configured on the server." })
    }

    const tabName = tabNameFromFile(
      typeof filename === "string" && filename.trim() ? filename : "report.csv"
    )
    const siteBase =
      process.env.REPORT_BASE_URL || process.env.SITE_URL || process.env.CLIENT_URL || ""

    const result = await runDailyReport([{ tabName, csvText }], {
      sheetId,
      siteBase,
      dateFilter: typeof date === "string" ? date : "",
    })

    logger.info({
      action: "DAILY_REPORT_GENERATED",
      userId: req.userId,
      tab: tabName,
      orders: result.orders,
      events: result.events,
      delayed: result.delayed,
    })
    return res.json(result)
  } catch (error) {
    logger.error({ action: "DAILY_REPORT_ERROR", userId: req.userId, err: (error as Error).message })
    return res
      .status(500)
      .json({ message: (error as Error).message || "Failed to generate the report." })
  }
}
