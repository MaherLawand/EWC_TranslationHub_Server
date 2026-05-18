import express from "express"

import {
  requireAuth,
} from "../middleware/auth.middleware.js"

import {
  createOrder,
  deleteOrder,
  getGameAssignedUsers,
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

router.post(
  "/",
  requireAuth,
  createOrder
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

router.delete(
  "/:id",
  requireAuth,
  deleteOrder
)

router.get(
  "/games/:gameId/users",
    requireAuth,
  getGameAssignedUsers
)

export default router