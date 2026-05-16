import { Router } from "express"

import {
  setPassword,
  login,
  logout,
  getCurrentUser,
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  assignGamesToUser,
} from "../controllers/auth.controller.js"
import { requireAuth } from "../middleware/auth.middleware.js"
import {
  requireAdmin,
} from "../middleware/admin.middleware.js"

const router = Router()

router.post("/login", login)

router.post(
  "/logout",
  logout
)

router.get("/me", requireAuth, getCurrentUser)

router.get("/getAllUsers",requireAuth,getAllUsers)

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

router.post(
  "/set-password",
  setPassword
)

export default router