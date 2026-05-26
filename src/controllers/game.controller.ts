import path from "path"
import { prisma } from "../lib/prisma.js"
import type { Request, Response } from "express"
import { logger } from "../lib/logger.js"

export async function getGames(
  req: Request,
  res: Response
) {
  try {
    const games =
      await prisma.game.findMany({
        orderBy: {
          name: "asc",
        },
      })

    // The DB stores full URLs seeded against a specific host (e.g. production).
    // Rewrite the logo to always point at the current server so logos load in
    // every environment without re-seeding.
    const base = `${req.protocol}://${req.get("host")}`
    const mapped = games.map((g) => ({
      ...g,
      logo: g.logo
        ? `${base}/game-logos/${path.basename(g.logo)}`
        : null,
    }))

    return res.json(mapped)

  } catch (error) {
    logger.error({ action: "GET_GAMES_ERROR", err: error })

    return res.status(500).json({
      message:
        "Failed to fetch games",
    })
  }
}

export async function getGameAssignedUsers(
  req: Request,
  res: Response
) {
  try {
    const gameId = String(
      req.params.gameId
    )

    const assignments =
      await prisma.gameAssignment.findMany({
        where: {
          gameId,
        },

        select: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,

              role: true,
              department: true,
              position: true,

              isActive: true,
            },
          },
        },
      })

    const users =
      assignments.map(
        (assignment) =>
          assignment.user
      )

    const producers =
      users.filter(
        (user) =>
          user.position ===
          "PRODUCER"
      )

    const ppms =
      users.filter(
        (user) =>
          user.position ===
          "POST_PRODUCTION_MANAGER"
      )

    return res.status(200).json({
      producers,
      ppms,
      users,
    })

  } catch (error) {

    logger.error({ action: "GET_GAME_ASSIGNED_USERS_ERROR", gameId: req.params.gameId, err: error })

    return res.status(500).json({
      message:
        "Failed to fetch assigned users",
    })
  }
}
