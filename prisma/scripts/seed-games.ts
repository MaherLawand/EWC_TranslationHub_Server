import { prisma } from "../../src/lib/prisma.js"

const games = [
  "Valorant",
  "Dota 2",
  "Fatal Fury",
  "Apex Legends",
  "Mobile Legends Women's International",
  "Free Fire",
  "League of Legends",
  "Pubg Battlegrounds",
  "Teamfight Tactics",
  "Mobile Legends: Bang Bang",
  "EA Sports FC 26",
  "Street Fighter 6",
  "Overwatch 2",
  "Call of Duty: Warzone Resurgence",
  "Honor of Kings",
  "Tekken 8",
  "Call of Duty: Black Ops 7",
  "Pubg Mobile",
  "Chess",
  "R6 Siege",
  "Rocket League",
  "Trackmania",
  "Crossfire",
  "Fortnite",
  "Counter-Strike 2",
]

async function seedGames() {
  try {
    for (const gameName of games) {
      await prisma.game.upsert({
        where: {
          name: gameName,
        },

        update: {},

        create: {
          name: gameName,

          logo: null,
        },
      })
    }

    console.log(
      "Games seeded successfully"
    )

  } catch (error) {
    console.error(error)
  } finally {
    await prisma.$disconnect()
  }
}

seedGames()