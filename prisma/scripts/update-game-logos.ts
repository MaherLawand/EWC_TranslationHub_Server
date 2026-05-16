import { prisma } from "../../src/lib/prisma.js"

const BASE_URL =
  process.env.API_URL ||
  "https://ewc-translation-hub-server-production.up.railway.app"

const logos = [
  {
    name: "Valorant",
    logo:
      `${BASE_URL}/game-logos/Valorant.png`,
  },

  {
    name: "Counter-Strike 2",
    logo:
      `${BASE_URL}/game-logos/Cs2.png`,
  },

  {
    name: "Dota 2",
    logo:
      `${BASE_URL}/game-logos/Dota2.png`,
  },

  {
    name: "League of Legends",
    logo:
      `${BASE_URL}/game-logos/LeagueOfLegends.png`,
  },

  {
    name: "EA Sports FC 26",
    logo:
      `${BASE_URL}/game-logos/EAFC26.png`,
  },

  {
    name: "Apex Legends",
    logo:
      `${BASE_URL}/game-logos/ApexLegends.png`,
  },

  {
    name: "Chess",
    logo:
      `${BASE_URL}/game-logos/Chess.png`,
  },

  {
    name: "Call of Duty: Warzone Resurgence",
    logo:
      `${BASE_URL}/game-logos/CodWarzone.png`,
  },

  {
    name: "Call of Duty: Black Ops 7",
    logo:
      `${BASE_URL}/game-logos/CodBlackOps7.png`,
  },

  {
    name: "Crossfire",
    logo:
      `${BASE_URL}/game-logos/CrossFire.png`,
  },

  {
    name: "Fatal Fury",
    logo:
      `${BASE_URL}/game-logos/FatalFury.png`,
  },

  {
    name: "Fortnite",
    logo:
      `${BASE_URL}/game-logos/Fortnite.png`,
  },

  {
    name: "Free Fire",
    logo:
      `${BASE_URL}/game-logos/FreeFire.png`,
  },

  {
    name: "Honor of Kings",
    logo:
      `${BASE_URL}/game-logos/HonorOfKings.png`,
  },

  {
    name: "Mobile Legends: Bang Bang",
    logo:
      `${BASE_URL}/game-logos/MobileLegends.png`,
  },

  {
    name: "Overwatch 2",
    logo:
      `${BASE_URL}/game-logos/OverWatch2.png`,
  },

  {
    name: "Pubg Battlegrounds",
    logo:
      `${BASE_URL}/game-logos/Pubg.png`,
  },

  {
    name: "Pubg Mobile",
    logo:
      `${BASE_URL}/game-logos/PubgMobile.png`,
  },

  {
    name: "R6 Siege",
    logo:
      `${BASE_URL}/game-logos/R6SX.png`,
  },

  {
    name: "Rocket League",
    logo:
      `${BASE_URL}/game-logos/RocketLeague.png`,
  },

  {
    name: "Street Fighter 6",
    logo:
      `${BASE_URL}/game-logos/StreetFighter6.png`,
  },

  {
    name: "Teamfight Tactics",
    logo:
      `${BASE_URL}/game-logos/TFT.png`,
  },

  {
    name: "Trackmania",
    logo:
      `${BASE_URL}/game-logos/TrackMania.png`,
  },

  {
    name: "Tekken 8",
    logo:
      `${BASE_URL}/game-logos/Tekken8.png`,
  },

  {
    name: "Mobile Legends Women's International",
    logo:
      `${BASE_URL}/game-logos/MobileLegendsWomen.png`,
  },
]

async function main() {
  for (const game of logos) {
    await prisma.game.update({
      where: {
        name: game.name,
      },

      data: {
        logo: game.logo,
      },
    })

    console.log(
      `Updated ${game.name}`
    )
  }

  console.log(
    "All game logos updated"
  )
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect()
  })