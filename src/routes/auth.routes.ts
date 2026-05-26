import { Router } from "express"
import rateLimit from "express-rate-limit"

import {
  setPassword,
  validateInvite,
  resendInvite,
  login,
  logout,
  getCurrentUser,
  getAllUsers,
  searchUsers,
  createUser,
  updateUser,
  deleteUser,
  assignGamesToUser,
  forgotPassword,
  validateResetToken,
  resetPassword,
} from "../controllers/auth.controller.js"
import { requireAuth } from "../middleware/auth.middleware.js"
import {
  requireAdmin,
} from "../middleware/admin.middleware.js"

// 3 attempts per hour — forgot-password (prevents email spam)
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
})

// 10 attempts per 15 min — login, set-password, resend-invite
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
})

// 30 attempts per 15 min — read-only token check
const checkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
})

const router = Router()

router.post("/login", authLimiter, login)

router.post(
  "/logout",
  logout
)

router.get("/me", requireAuth, getCurrentUser)

router.get("/getAllUsers", requireAuth, getAllUsers)

router.get("/users/search", requireAuth, searchUsers)

router.post(
  "/users",
  requireAuth,
  requireAdmin,
  createUser
)

router.patch(
  "/users/:id",
  requireAuth,
  requireAdmin,
  updateUser
)

router.delete(
  "/users/:id",
  requireAuth,
  requireAdmin,
  deleteUser
)

router.post(
  "/users/:id/games",
  requireAuth,
  requireAdmin,
  assignGamesToUser
)

router.get(
  "/validate-invite",
  checkLimiter,
  validateInvite
)

router.post(
  "/set-password",
  authLimiter,
  setPassword
)

router.post(
  "/resend-invite",
  authLimiter,
  resendInvite
)

router.post(
  "/forgot-password",
  forgotPasswordLimiter,
  forgotPassword
)

router.get(
  "/validate-reset-token",
  checkLimiter,
  validateResetToken
)

router.post(
  "/reset-password",
  authLimiter,
  resetPassword
)

export default router