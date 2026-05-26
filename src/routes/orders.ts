import express from "express"

import {
  requireAuth,
} from "../middleware/auth.middleware.js"

import {
  assignUsersToMarketingOrder,
  createOrder,
  deleteOrder,
  getOrderById,
  getOrderCounts,
  getOrders,
  markNotificationsAsRead,
  updateOrder,
  updateOrderStatus,
} from "../controllers/orders.controller.js"

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

router.delete(
  "/:id",
  requireAuth,
  deleteOrder
)

export default router