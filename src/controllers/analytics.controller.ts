/**
 * ── ADMIN STATISTICS DASHBOARD (removable feature) ──
 *
 * Returns the raw per-order broadcast rows for one event (EWC/ENC). All the
 * analytics — week bucketing (by each order's deadline), the per-game / category
 * / language / status rollups, on-time %, and the week/game/status filtering —
 * are computed on the client from these rows, so the event-week schedule
 * (client/src/constants/weeklyGames.ts) stays the single source of truth and the
 * dashboard can filter reactively without re-hitting the server.
 *
 * Payload is intentionally small per row (game, category, status, two dates, the
 * language list) so an event's worth of orders is a light response.
 *
 * To remove the whole feature: delete this file, routes/analytics.ts, the
 * app.use("/analytics", …) line, and the client AnalyticsDashboard wiring.
 */
import type { Response } from "express"
import type { AuthRequest } from "../middleware/auth.middleware.js"
import { prisma } from "../lib/prisma.js"
import { logger } from "../lib/logger.js"

/** Per-order broadcast rows for one event. Admin only (see route). */
export async function broadcastAnalytics(req: AuthRequest, res: Response) {
  try {
    const eventParam = String(req.query.event || "EWC").toUpperCase()
    const event = eventParam === "ENC" ? "ENC" : "EWC"

    // Non-parent broadcast orders only — parents are containers; their sub-orders
    // carry the real languages/category (mirrors the report/website counting).
    const rows = await prisma.translationOrder.findMany({
      where: { type: "BROADCAST", isParent: false, event: event as never },
      select: {
        status: true,
        completedAt: true,
        broadcast: {
          select: {
            contentCategory: true,
            targetLanguages: true,
            deadlineDate: true,
            game: { select: { name: true } },
          },
        },
      },
    })

    const orders = rows
      .filter((o) => o.broadcast?.game)
      .map((o) => ({
        game: o.broadcast!.game.name,
        category: o.broadcast!.contentCategory || null,
        status: o.status,
        deadline: o.broadcast!.deadlineDate ? o.broadcast!.deadlineDate.toISOString() : null,
        completedAt: o.completedAt ? o.completedAt.toISOString() : null,
        languages: o.broadcast!.targetLanguages || [],
      }))

    // Marketing has no game/week: it's grouped by content title (same as the
    // Weekly Content Report sheet's Marketing tab). Videos = target languages.
    const marketingRows = await prisma.translationOrder.findMany({
      where: { type: "MARKETING", isParent: false, event: event as never },
      select: { status: true, marketing: { select: { contentTitle: true, targetLanguages: true } } },
    })
    const marketing = marketingRows
      .filter((o) => o.marketing)
      .map((o) => ({
        contentTitle: (o.marketing!.contentTitle || "").trim() || null,
        status: o.status,
        videos: (o.marketing!.targetLanguages || []).length,
      }))

    res.json({ generatedAt: new Date().toISOString(), event, orders, marketing })
  } catch (error) {
    logger.error({ action: "ANALYTICS_BROADCAST_ERROR", userId: req.userId, err: error })
    res.status(500).json({ message: "Failed to compute analytics" })
  }
}

/**
 * Daily report — VIEW ONLY. The late/early analysis (same maths as the sheet
 * report), straight from the DB, for all admins. Returns the timing fields for
 * every In-Progress/Completed order of an event; the client computes the delay,
 * durations, and week/day filters. No CSV, no writes. Admin only (see route).
 */
export async function deliveryReport(req: AuthRequest, res: Response) {
  try {
    const eventParam = String(req.query.event || "EWC").toUpperCase()
    const event = eventParam === "ENC" ? "ENC" : "EWC"

    const name = (u: { firstName: string | null; lastName: string | null } | null | undefined) =>
      u ? `${u.firstName || ""} ${u.lastName || ""}`.trim() : ""

    const rows = await prisma.translationOrder.findMany({
      where: { event: event as never, isParent: false, status: "COMPLETED" },
      select: {
        id: true, title: true, type: true, event: true, priority: true, status: true,
        readyAt: true, inProgressAt: true, completedAt: true, notifyPositions: true,
        createdBy: { select: { firstName: true, lastName: true } },
        completedBy: { select: { firstName: true, lastName: true } },
        marketing: {
          select: {
            deadlineDate: true, deadlineHasTime: true,
            deliveryFormats: { select: { format: true } },
            assignments: { select: { user: { select: { firstName: true, lastName: true } } } },
          },
        },
        broadcast: {
          select: {
            deadlineDate: true, deadlineHasTime: true, contentCategory: true,
            game: { select: { name: true, assignedUsers: { select: { user: { select: { firstName: true, lastName: true } } } } } },
            deliveryFormats: { select: { format: true } },
          },
        },
      },
    })

    const orders = rows.map((o) => {
      const details = o.broadcast || o.marketing
      const formats = [
        ...(o.marketing?.deliveryFormats || []),
        ...(o.broadcast?.deliveryFormats || []),
      ].map((f) => f.format)
      const assignedTo = o.marketing
        ? o.marketing.assignments.map((a) => name(a.user))
        : o.broadcast?.game.assignedUsers.map((a) => name(a.user)) || []
      return {
        id: o.id,
        title: o.title,
        type: o.type,
        event: o.event,
        priority: o.priority,
        status: o.status,
        game: o.broadcast?.game.name || null,
        contentCategory: o.broadcast?.contentCategory || null,
        deliveryFormat: [...new Set(formats)].join(", "),
        deadline: details?.deadlineDate ? details.deadlineDate.toISOString() : null,
        deadlineHasTime: details?.deadlineHasTime || false,
        readyAt: o.readyAt ? o.readyAt.toISOString() : null,
        inProgressAt: o.inProgressAt ? o.inProgressAt.toISOString() : null,
        completedAt: o.completedAt ? o.completedAt.toISOString() : null,
        createdBy: name(o.createdBy),
        completedBy: name(o.completedBy),
        notifyPositions: o.notifyPositions,
        assignedTo: [...new Set(assignedTo.filter(Boolean))],
      }
    })

    res.json({ generatedAt: new Date().toISOString(), event, orders })
  } catch (error) {
    logger.error({ action: "ANALYTICS_DELIVERY_ERROR", userId: req.userId, err: error })
    res.status(500).json({ message: "Failed to build the daily report view" })
  }
}
