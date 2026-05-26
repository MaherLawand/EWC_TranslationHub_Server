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
  getLockedUsers,
  clearLoginLockout,
} from "../controllers/auth.controller.js"
import { requireAuth } from "../middleware/auth.middleware.js"
import {
  requireAdmin,
} from "../middleware/admin.middleware.js"

// 10 attempts per 15 min per IP — login
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
})

// 3 attempts per hour per IP — forgot-password (prevents email spam)
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
})

// 10 attempts per 15 min per IP — validate-invite, reset-password, set-password
const checkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
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

// Admin — get all currently locked accounts
router.get(
  "/locked-users",
  requireAuth,
  requireAdmin,
  getLockedUsers
)

// Admin — clear login lockout for a specific user
router.post(
  "/users/clear-lockout",
  requireAuth,
  requireAdmin,
  clearLoginLockout
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