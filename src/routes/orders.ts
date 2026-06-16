import express from "express"

import {
  requireAuth,
} from "../middleware/auth.middleware.js"

import {
  assignUsersToMarketingOrder,
  createOrder,
  createSubOrders,
  deleteOrder,
  getOrderById,
  getOrderCounts,
  getOrders,
  getSubOrders,
  markNotificationsAsRead,
  updateOrder,
  updateOrderStatus,
} from "../controllers/orders.controller.js"

import {
  getOrderFeedback,
  createOrderFeedback,
  updateOrderFeedback,
  deleteOrderFeedback,
} from "../controllers/feedback.controller.js"

const router = express.Router()

router.get(
  "/",
  requireAuth,
  getOrders
)

// Must be before /:id to avoid "counts" being treated as an order id
router.get(
  "/counts",
  requireAuth,
  getOrderCounts
)

router.post(
  "/",
  requireAuth,
  createOrder
)

// Bulk-create sub-orders under an existing parent ("big order")
router.post(
  "/:id/sub-orders",
  requireAuth,
  createSubOrders
)

// Lazy-load a parent's sub-orders (paginated) when its row is expanded
router.get(
  "/:id/sub-orders",
  requireAuth,
  getSubOrders
)

router.get(
  "/:id",
  requireAuth,
  getOrderById
)

router.patch(
  "/:id",
  requireAuth,
  updateOrder
)

router.patch(
  "/:id/status",
  requireAuth,
  updateOrderStatus
)

router.patch(
  "/notifications/read",
  requireAuth,
  markNotificationsAsRead
)

router.post(
  "/:id/assign",
  requireAuth,
  assignUsersToMarketingOrder
)

// ── Order feedback (translator comments) ──────────────────────────────────
router.get(
  "/:id/feedback",
  requireAuth,
  getOrderFeedback
)

router.post(
  "/:id/feedback",
  requireAuth,
  createOrderFeedback
)

router.patch(
  "/feedback/:feedbackId",
  requireAuth,
  updateOrderFeedback
)

router.delete(
  "/feedback/:feedbackId",
  requireAuth,
  deleteOrderFeedback
)

router.delete(
  "/:id",
  requireAuth,
  deleteOrder
)

export default router