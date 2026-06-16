import type { Response } from "express"
import type { AuthRequest } from "../middleware/auth.middleware.js"
import { prisma } from "../lib/prisma.js"
import { triggerNotifications, getIo } from "../lib/socket.js"
import { logger } from "../lib/logger.js"

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
  Notify the order's assigned managers that feedback was added.
  Broadcast → PPMs/Producers assigned to the order's game.
  Marketing → users assigned to the order. The author is never notified.
  Uses upsert because Notification has @@unique([orderId, userId, type]) —
  a new feedback re-raises (unreads + bumps) the existing notification.
*/
async function notifyFeedback(orderId: string, authorId: string, authorName: string) {
  try {
    const order = await prisma.translationOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        title: true,
        type: true,
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

    // De-duplicate and never notify the author.
    const seen = new Set<string>()
    recipients = recipients.filter(
      (u) => u.id !== authorId && !seen.has(u.id) && (seen.add(u.id), true)
    )
    if (recipients.length === 0) return

    const title = "New Feedback"
    const message = `${authorName} left feedback on "${order.title}"`

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
        update: { title, message, isRead: false, createdAt: new Date() },
        create: {
          title,
          message,
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

/* GET /orders/:id/feedback — list all feedback for an order (shared thread). */
export async function getOrderFeedback(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })
    const orderId = String(req.params.id)

    const feedback = await prisma.orderFeedback.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
      select: feedbackSelect,
    })

    return res.json(feedback)
  } catch (error) {
    logger.error({ action: "GET_FEEDBACK_ERROR", userId: req.userId, orderId: req.params.id, err: error })
    return res.status(500).json({ message: "Failed to load feedback" })
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
      select: { id: true, position: true, firstName: true, lastName: true },
    })
    if (!user) return res.status(404).json({ message: "User not found" })
    // Only translators may create feedback.
    if (user.position !== "TRANSLATOR") {
      return res.status(403).json({ message: "Only translators can add feedback" })
    }

    const order = await prisma.translationOrder.findUnique({
      where: { id: orderId },
      select: { id: true },
    })
    if (!order) return res.status(404).json({ message: "Order not found" })

    const feedback = await prisma.orderFeedback.create({
      data: { orderId, authorId: user.id, message },
      select: feedbackSelect,
    })

    logger.info({ action: "CREATE_FEEDBACK", userId: req.userId, orderId, feedbackId: feedback.id })

    res.json(feedback)

    // Fire-and-forget: notify assigned managers + nudge open panels to refresh.
    const authorName = `${user.firstName} ${user.lastName}`.trim()
    notifyFeedback(orderId, user.id, authorName).catch(() => {})
    try { getIo()?.emit("order-feedback", { orderId }) } catch {}
    return
  } catch (error) {
    logger.error({ action: "CREATE_FEEDBACK_ERROR", userId: req.userId, orderId: req.params.id, err: error })
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

    logger.info({ action: "UPDATE_FEEDBACK", userId: req.userId, feedbackId })
    res.json(feedback)
    try { getIo()?.emit("order-feedback", { orderId: existing.orderId }) } catch {}
    return
  } catch (error) {
    logger.error({ action: "UPDATE_FEEDBACK_ERROR", userId: req.userId, feedbackId: req.params.feedbackId, err: error })
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

    logger.info({ action: "DELETE_FEEDBACK", userId: req.userId, feedbackId })
    res.json({ message: "Feedback deleted" })
    try { getIo()?.emit("order-feedback", { orderId: existing.orderId }) } catch {}
    return
  } catch (error) {
    logger.error({ action: "DELETE_FEEDBACK_ERROR", userId: req.userId, feedbackId: req.params.feedbackId, err: error })
    return res.status(500).json({ message: "Failed to delete feedback" })
  }
}
