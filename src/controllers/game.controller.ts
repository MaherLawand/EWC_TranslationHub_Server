import { prisma } from "../lib/prisma.js"
import type { Request, Response } from "express"

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

    return res.json(games)

  } catch (error) {
    console.error(error)

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

    console.error(error)

    return res.status(500).json({
      message:
        "Failed to fetch assigned users",
    })
  }
}
