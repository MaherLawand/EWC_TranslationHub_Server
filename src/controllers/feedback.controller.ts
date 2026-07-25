import type { Response } from "express"
import type { AuthRequest } from "../middleware/auth.middleware.js"
import { prisma } from "../lib/prisma.js"
import { triggerNotifications, getIo } from "../lib/socket.js"
import { logger } from "../lib/logger.js"
import { sendFeedbackEmail } from "../utils/sendFeedbackEmail.js"
import { TRANSLATOR_POSITIONS, isTranslatorPosition, canSeeOrder } from "../lib/positions.js"

const feedbackSelect = {
  id: true,
  message: true,
  createdAt: true,
  updatedAt: true,
  authorId: true,
  author: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      position: true,
    },
  },
} as const

/*
  Notify the order's assigned managers + ALL active translators that feedback
  was added.
  Broadcast → PPMs/Producers assigned to the order's game.
  Marketing → users assigned to the order.
  Plus every active translator WHO CAN SEE THIS ORDER (its Notify pills name their
  vendor role, or it has no selection yet) — a translator who can't open the order
  is not notified, so the alert never dead-ends on "no order found".
  The author is never notified.
  Uses upsert because Notification has @@unique([orderId, userId, type]) —
  a new feedback re-raises (unreads + bumps) the existing notification.
*/
async function notifyFeedback(
  orderId: string,
  authorId: string,
  authorName: string,
  message: string
) {
  try {
    const order = await prisma.translationOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        title: true,
        type: true,
        notifyPositions: true,
        broadcast: {
          select: {
            game: {
              select: {
                assignedUsers: {
                  select: {
                    user: { select: { id: true, position: true, isActive: true } },
                  },
                },
              },
            },
          },
        },
        marketing: {
          select: {
            assignments: {
              select: {
                user: { select: { id: true, position: true, isActive: true } },
              },
            },
          },
        },
      },
    })
    if (!order) return

    let recipients: { id: string }[] = []
    if (order.type === "BROADCAST") {
      recipients = (order.broadcast?.game?.assignedUsers ?? [])
        .map((a) => a.user)
        .filter(
          (u) =>
            u &&
            u.isActive &&
            (u.position === "PRODUCER" || u.position === "POST_PRODUCTION_MANAGER")
        )
    } else {
      recipients = (order.marketing?.assignments ?? [])
        .map((a) => a.user)
        .filter((u) => u && u.isActive)
    }

    // Notify active translators who can actually SEE this order. The Notify pills
    // (notifyPositions) assign an order to specific vendor roles; a translator not
    // named on the order can't open it, so blasting all of them just produces a
    // notification that dead-ends on "no order found" (same gate as getOrderFeedback).
    const allTranslators = await prisma.user.findMany({
      where: { isActive: true, position: { in: TRANSLATOR_POSITIONS as any } },
      select: { id: true, email: true, position: true },
    })
    const translators = allTranslators.filter((t) =>
      canSeeOrder(null, t.position, order.notifyPositions)
    )
    recipients = [...recipients, ...translators.map((t) => ({ id: t.id }))]

    // Email those same visible translators every time feedback is added — never the
    // author of this comment. Fire-and-forget; suppressed outside production.
    const page = order.type === "BROADCAST" ? "Broadcast" : "marketing"
    const feedbackUrl = `${process.env.CLIENT_URL ?? ""}/?page=${page}&orderId=${order.id}`
    const translatorEmails = translators
      .filter((t) => t.id !== authorId && t.email)
      .map((t) => t.email)
    if (translatorEmails.length > 0) {
      sendFeedbackEmail({
        to: translatorEmails,
        authorName,
        orderTitle: order.title,
        message,
        feedbackUrl,
      }).catch((err) => logger.error({ action: "FEEDBACK_EMAIL_ERROR", orderId, err }))
    }

    // Also notify everyone who already participated in this thread, so a
    // manager's reply reaches the translator who commented (and vice-versa).
    const priorAuthors = await prisma.orderFeedback.findMany({
      where: { orderId },
      select: { authorId: true },
      distinct: ["authorId"],
    })
    recipients = [...recipients, ...priorAuthors.map((p) => ({ id: p.authorId }))]

    // De-duplicate and never notify the author.
    const seen = new Set<string>()
    recipients = recipients.filter(
      (u) => u.id !== authorId && !seen.has(u.id) && (seen.add(u.id), true)
    )
    if (recipients.length === 0) return

    const title = "New Feedback"
    const notifMessage = `${authorName} left feedback on "${order.title}"`

    const created = []
    for (const r of recipients) {
      const n = await prisma.notification.upsert({
        where: {
          orderId_userId_type: {
            orderId: order.id,
            userId: r.id,
            type: "FEEDBACK_ADDED",
          },
        },
        update: { title, message: notifMessage, isRead: false, createdAt: new Date() },
        create: {
          title,
          message: notifMessage,
          type: "FEEDBACK_ADDED",
          userId: r.id,
          orderId: order.id,
        },
      })
      created.push(n)
    }

    await triggerNotifications(
      created.map((n) => ({
        id: n.id,
        userId: n.userId,
        title: n.title,
        message: n.message,
        type: n.type,
        isRead: n.isRead,
        createdAt: n.createdAt,
        order: { id: order.id, title: order.title },
      }))
    )
  } catch (error) {
    logger.error({ action: "NOTIFY_FEEDBACK_ERROR", orderId, err: error })
  }
}

/* GET /orders/:id/feedback — list all feedback for an order (shared thread).
   Each item carries `readByMe` so the client can highlight unread messages. */
export async function getOrderFeedback(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })
    const orderId = String(req.params.id)

    // Assignment-based visibility — no reading a thread on an order you can't see.
    if (isTranslatorPosition(req.userPosition) && req.userRole !== "ADMIN") {
      const order = await prisma.translationOrder.findUnique({
        where: { id: orderId },
        select: { notifyPositions: true },
      })
      if (!order || !canSeeOrder(req.userRole, req.userPosition, order.notifyPositions)) {
        return res.status(404).json({ message: "Order not found" })
      }
    }

    const feedback = await prisma.orderFeedback.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
      select: {
        ...feedbackSelect,
        reads: { where: { userId: req.userId }, select: { id: true } },
      },
    })

    const mapped = feedback.map(({ reads, ...f }) => ({
      ...f,
      readByMe: reads.length > 0,
    }))

    return res.json(mapped)
  } catch (error) {
    logger.error({ action: "GET_FEEDBACK_ERROR", userId: req.userId, userName: req.userName, orderId: req.params.id, err: error })
    return res.status(500).json({ message: "Failed to load feedback" })
  }
}

/* POST /orders/feedback/read — mark a batch of feedback messages as read for
   the current user (called when messages scroll into view). Idempotent. */
export async function markFeedbackRead(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })
    const ids = Array.isArray(req.body.feedbackIds)
      ? req.body.feedbackIds.filter((x: unknown) => typeof x === "string")
      : []
    if (ids.length === 0) return res.json({ marked: 0 })

    const result = await prisma.feedbackRead.createMany({
      data: ids.map((feedbackId: string) => ({ feedbackId, userId: req.userId })),
      skipDuplicates: true,
    })

    return res.json({ marked: result.count })
  } catch (error) {
    logger.error({ action: "MARK_FEEDBACK_READ_ERROR", userId: req.userId, userName: req.userName, err: error })
    return res.status(500).json({ message: "Failed to mark feedback read" })
  }
}

/* POST /orders/feedback/unread-counts — for the given order ids, return how many
   feedback messages the current user hasn't authored and hasn't read yet.
   Returns { [orderId]: count }. */
export async function getUnreadFeedbackCounts(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })
    const ids = Array.isArray(req.body.orderIds)
      ? req.body.orderIds.filter((x: unknown) => typeof x === "string")
      : []
    if (ids.length === 0) return res.json({})

    const grouped = await prisma.orderFeedback.groupBy({
      by: ["orderId"],
      where: {
        orderId: { in: ids },
        authorId: { not: req.userId },
        reads: { none: { userId: req.userId } },
      },
      _count: { _all: true },
    })

    const counts: Record<string, number> = {}
    for (const g of grouped) counts[g.orderId] = g._count._all
    return res.json(counts)
  } catch (error) {
    logger.error({ action: "UNREAD_FEEDBACK_COUNTS_ERROR", userId: req.userId, userName: req.userName, err: error })
    return res.status(500).json({ message: "Failed to load unread counts" })
  }
}

/* POST /orders/:id/feedback — create feedback. Translators only. */
export async function createOrderFeedback(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })
    const orderId = String(req.params.id)
    const message = typeof req.body.message === "string" ? req.body.message.trim() : ""

    if (!message) return res.status(400).json({ message: "Feedback cannot be empty" })
    if (message.length > 5000) return res.status(400).json({ message: "Feedback is too long" })

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, role: true, position: true, firstName: true, lastName: true },
    })
    if (!user) return res.status(404).json({ message: "User not found" })
    // Translators AND the order's managers (Producers / PPMs / Admin) may post —
    // feedback is a back-and-forth thread between them.
    const canPostFeedback =
      user.role === "ADMIN" ||
      isTranslatorPosition(user.position) ||
      user.position === "PRODUCER" ||
      user.position === "POST_PRODUCTION_MANAGER" ||
      user.position === "EDITOR"
    if (!canPostFeedback) {
      return res.status(403).json({ message: "You are not allowed to add feedback" })
    }

    const order = await prisma.translationOrder.findUnique({
      where: { id: orderId },
      select: { id: true, notifyPositions: true },
    })
    if (!order) return res.status(404).json({ message: "Order not found" })
    // Assignment-based visibility — can't post on an order you can't see.
    if (!canSeeOrder(user.role, user.position, order.notifyPositions)) {
      return res.status(404).json({ message: "Order not found" })
    }

    const feedback = await prisma.orderFeedback.create({
      data: { orderId, authorId: user.id, message },
      select: feedbackSelect,
    })

    logger.info({ action: "CREATE_FEEDBACK", userId: req.userId, userName: req.userName, orderId, feedbackId: feedback.id, length: message.length })

    res.json(feedback)

    // Fire-and-forget: notify assigned managers + nudge open panels to refresh.
    const authorName = `${user.firstName} ${user.lastName}`.trim()
    notifyFeedback(orderId, user.id, authorName, message).catch(() => {})
    try { getIo()?.emit("order-feedback", { orderId }) } catch {}
    return
  } catch (error) {
    logger.error({ action: "CREATE_FEEDBACK_ERROR", userId: req.userId, userName: req.userName, orderId: req.params.id, err: error })
    return res.status(500).json({ message: "Failed to add feedback" })
  }
}

/* PATCH /orders/feedback/:feedbackId — edit own feedback. */
export async function updateOrderFeedback(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })
    const feedbackId = String(req.params.feedbackId)
    const message = typeof req.body.message === "string" ? req.body.message.trim() : ""

    if (!message) return res.status(400).json({ message: "Feedback cannot be empty" })
    if (message.length > 5000) return res.status(400).json({ message: "Feedback is too long" })

    const existing = await prisma.orderFeedback.findUnique({
      where: { id: feedbackId },
      select: { id: true, authorId: true, orderId: true },
    })
    if (!existing) return res.status(404).json({ message: "Feedback not found" })
    if (existing.authorId !== req.userId) {
      return res.status(403).json({ message: "You can only edit your own feedback" })
    }

    const feedback = await prisma.orderFeedback.update({
      where: { id: feedbackId },
      data: { message },
      select: feedbackSelect,
    })

    logger.info({ action: "UPDATE_FEEDBACK", userId: req.userId, userName: req.userName, feedbackId, orderId: existing.orderId })
    res.json(feedback)
    try { getIo()?.emit("order-feedback", { orderId: existing.orderId }) } catch {}
    return
  } catch (error) {
    logger.error({ action: "UPDATE_FEEDBACK_ERROR", userId: req.userId, userName: req.userName, feedbackId: req.params.feedbackId, err: error })
    return res.status(500).json({ message: "Failed to update feedback" })
  }
}

/* DELETE /orders/feedback/:feedbackId — delete own feedback. */
export async function deleteOrderFeedback(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })
    const feedbackId = String(req.params.feedbackId)

    const existing = await prisma.orderFeedback.findUnique({
      where: { id: feedbackId },
      select: { id: true, authorId: true, orderId: true },
    })
    if (!existing) return res.status(404).json({ message: "Feedback not found" })
    if (existing.authorId !== req.userId) {
      return res.status(403).json({ message: "You can only delete your own feedback" })
    }

    await prisma.orderFeedback.delete({ where: { id: feedbackId } })

    logger.info({ action: "DELETE_FEEDBACK", userId: req.userId, userName: req.userName, feedbackId, orderId: existing.orderId })
    res.json({ message: "Feedback deleted" })
    try { getIo()?.emit("order-feedback", { orderId: existing.orderId }) } catch {}
    return
  } catch (error) {
    logger.error({ action: "DELETE_FEEDBACK_ERROR", userId: req.userId, userName: req.userName, feedbackId: req.params.feedbackId, err: error })
    return res.status(500).json({ message: "Failed to delete feedback" })
  }
}
