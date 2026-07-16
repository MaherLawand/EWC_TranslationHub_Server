import type { Request, Response, NextFunction } from "express"
import jwt from "jsonwebtoken"
import { prisma } from "../lib/prisma.js"

export interface AuthRequest extends Request {
  userId?: string
  /** "First Last" of the authenticated user — attached for human-readable logs. */
  userName?: string
  /** Access level ("ADMIN" | "USER") — attached so handlers can gate without a re-fetch. */
  userRole?: string | null
  /** Job position ("TRANSLATOR", "TRANSPERFECT", …) — drives order visibility. */
  userPosition?: string | null
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
      select: { isActive: true, firstName: true, lastName: true, role: true, position: true },
    })

    if (!user || !user.isActive) {
      return res.status(401).json({
        message: "Unauthorized",
      })
    }

    req.userId = decoded.userId
    // Human-readable actor name for logs (falls back to the id if unnamed).
    req.userName = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || decoded.userId
    req.userRole = user.role
    req.userPosition = user.position

    next()
  } catch {
    return res.status(401).json({
      message: "Unauthorized",
    })
  }
}
