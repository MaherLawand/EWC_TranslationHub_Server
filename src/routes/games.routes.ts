import { Router } from "express"

import {
  getGameAssignedUsers,
  getGames,
} from "../controllers/game.controller.js"

import {
  requireAuth,
} from "../middleware/auth.middleware.js"

const router = Router()

router.get(
  "/",
  requireAuth,
  getGames
)

router.get(
  "/:gameId/users",
  requireAuth,
  getGameAssignedUsers
)

export default router