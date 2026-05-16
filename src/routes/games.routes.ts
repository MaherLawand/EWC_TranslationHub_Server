import { Router } from "express"

import {
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

export default router