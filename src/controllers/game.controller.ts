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