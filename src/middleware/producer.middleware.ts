import { prisma } from "../lib/prisma.js"
import { logger } from "../lib/logger.js"

import type {
  AuthRequest,
} from "./auth.middleware.js"

import type {
  Response,
  NextFunction,
} from "express"

export async function requireProducer(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    if (!req.userId) {
      return res.status(401).json({
        message:
          "Unauthorized",
      })
    }

    const user =
      await prisma.user.findUnique({
        where: {
          id: req.userId,
        },
        select: { position: true },
      })

    if (!user) {
      return res.status(401).json({
        message:
          "User not found",
      })
    }

    if (
      user.position !==
      "PRODUCER"
    ) {
      return res.status(403).json({
        message:
          "Producers only",
      })
    }

    next()

  } catch (error) {
    logger.error({ action: "PRODUCER_MIDDLEWARE_ERROR", userId: req.userId, userName: req.userName, err: error })

    return res.status(500).json({
      message:
        "Authorization failed",
    })
  }
}