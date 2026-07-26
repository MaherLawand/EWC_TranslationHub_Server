import type { Response, NextFunction } from "express"
import type { AuthRequest } from "./auth.middleware.js"
import { prisma } from "../lib/prisma.js"

// The single account allowed to run the report. Overridable via env so it isn't
// hard-pinned in code, but defaults to the current owner.
const OWNER_EMAIL = (process.env.REPORT_OWNER_EMAIL || "maher.lawand10@gmail.com").toLowerCase()

/**
 * Restricts a route to the report owner's email. Must run AFTER requireAuth
 * (relies on req.userId). requireAuth doesn't attach the email, so it's fetched
 * here. Anyone else — including other admins — gets a 403.
 */
export async function requireReportOwner(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true },
    })
    if (!user || (user.email || "").toLowerCase() !== OWNER_EMAIL) {
      return res.status(403).json({ message: "Not authorized" })
    }
    next()
  } catch {
    return res.status(403).json({ message: "Not authorized" })
  }
}
