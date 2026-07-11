import type { Request, Response, NextFunction } from "express"
import jwt from "jsonwebtoken"
import { prisma } from "../lib/prisma.js"

export interface AuthRequest extends Request {
  userId?: string
  /** "First Last" of the authenticated user — attached for human-readable logs. */
  userName?: string
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const token = req.cookies.token

    if (!token) {
      return res.status(401).json({
        message: "Unauthorized",
      })
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET as string,
      { algorithms: ["HS256"] }
    ) as { userId: string }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { isActive: true, firstName: true, lastName: true },
    })

    if (!user || !user.isActive) {
      return res.status(401).json({
        message: "Unauthorized",
      })
    }

    req.userId = decoded.userId
    // Human-readable actor name for logs (falls back to the id if unnamed).
    req.userName = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || decoded.userId

    next()
  } catch {
    return res.status(401).json({
      message: "Unauthorized",
    })
  }
}
