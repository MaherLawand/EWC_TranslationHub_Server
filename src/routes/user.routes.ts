import { Router } from "express"

import { prisma } from "../lib/prisma.js"
import { logger } from "../lib/logger.js"

import {
  requireAuth,
  type AuthRequest,
} from "../middleware/auth.middleware.js"

const router = Router()

/* CURRENT USER */
router.get(
  "/me",
  requireAuth,

  async (
    req: AuthRequest,
    res
  ) => {
    try {
      const user =
        await prisma.user.findUnique({
          where: {
            id: req.userId,
          },

          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
            department: true,
            position: true,
          },
        })

      if (!user) {
        return res.status(404).json({
          message: "User not found",
        })
      }

      return res.json(user)
    } catch (error) {
      logger.error({ action: "GET_ME_ERROR", userId: req.userId, err: error })

      return res.status(500).json({
        message:
          "Failed to fetch current user",
      })
    }
  }
)

/* GET ALL USERS */
router.get(
  "/getAllUsers",
  requireAuth,

  async (
    req: AuthRequest,
    res
  ) => {
    try {
      const users =
        await prisma.user.findMany({
          orderBy: {
            createdAt: "desc",
          },

          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
            department: true,
            position: true,
            createdAt: true,
          },
        })

      return res.json(users)
    } catch (error) {
      logger.error({ action: "GET_ALL_USERS_ERROR", userId: req.userId, err: error })

      return res.status(500).json({
        message:
          "Failed to fetch users",
      })
    }
  }
)

export default router