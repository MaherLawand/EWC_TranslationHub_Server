import { Router } from "express"

import { prisma } from "../lib/prisma.js"

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
            name: true,
            email: true,
            role: true,
            department: true,
            position: true,
          },
        })

      if (!user) {
        return res.status(404).json({
          error: "User not found",
        })
      }

      return res.json(user)
    } catch (error) {
      console.error(error)

      return res.status(500).json({
        error:
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
            name: true,
            email: true,
            role: true,
            department: true,
            position: true,
            createdAt: true,
          },
        })

      return res.json(users)
    } catch (error) {
      console.error(error)

      return res.status(500).json({
        error:
          "Failed to fetch users",
      })
    }
  }
)

export default router