import { Router } from "express"
import rateLimit, { ipKeyGenerator } from "express-rate-limit"

import { requireAuth } from "../middleware/auth.middleware.js"
import type { AuthRequest } from "../middleware/auth.middleware.js"
import { checkSrt, exportSrt, getGlossaryLanguages } from "../controllers/srtGlossary.controller.js"

/**
 * Each check costs real money at the model provider, so it gets its own limiter
 * rather than relying on the global one. Keyed per user, and mounted AFTER
 * requireAuth so req.userId is populated (falling back to IP if it somehow isn't).
 * 20/hour is generous for genuine use while bounding a runaway loop.
 */
const srtCheckLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  // Per user. Falls back to IP via the library's helper, which normalizes IPv6
  // into a subnet key so those users can't sidestep the limit.
  keyGenerator: (req, res) => (req as AuthRequest).userId ?? ipKeyGenerator(req.ip ?? "unknown"),
  message: { message: "You've run a lot of checks recently. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
})

const router = Router()

router.get("/languages", requireAuth, getGlossaryLanguages)
router.post("/check", requireAuth, srtCheckLimiter, checkSrt)
// Export is pure local computation (no model call), so it isn't rate limited —
// a reviewer may legitimately re-export several times while adjusting choices.
router.post("/export", requireAuth, exportSrt)

export default router
