import { prisma } from "../../src/lib/prisma.js"

const logos = [
  {
    name: "Valorant",
    logo:
      "http://localhost:4000/game-logos/Valorant.png",
  },

  {
    name: "Counter-Strike 2",
    logo:
      "http://localhost:4000/game-logos/Cs2.png",
  },

  {
    name: "Dota 2",
    logo:
      "http://localhost:4000/game-logos/Dota2.png",
  },

  {
    name: "League of Legends",
    logo:
      "http://localhost:4000/game-logos/LeagueOfLegends.png",
  },

  {
    name: "EA Sports FC 26",
    logo:
      "http://localhost:4000/game-logos/EAFC26.png",
  },
  {
    name: "Apex Legends",
    logo:
      "http://localhost:4000/game-logos/ApexLegends.png",
  },
  {
    name: "Chess",
    logo:
      "http://localhost:4000/game-logos/Chess.png",
  },
  {
    name: "Call of Duty: Warzone Resurgence",
    logo:
      "http://localhost:4000/game-logos/CodWarzone.png",
  },
  {
    name: "Call of Duty: Black Ops 7",
    logo:
      "http://localhost:4000/game-logos/CodBlackOps7.png",
  },
  {
    name: "Crossfire",
    logo:
      "http://localhost:4000/game-logos/CrossFire.jpg",
  },
  {
    name: "Fatal Fury",
    logo:
      "http://localhost:4000/game-logos/FatalFury.png",
  },
  {
    name: "Fortnite",
    logo:
      "http://localhost:4000/game-logos/Fortnite.png",
  },
  {
    name: "Free Fire",
    logo:
      "http://localhost:4000/game-logos/FreeFire.png",
  },
  {
    name: "Honor of Kings",
    logo:
      "http://localhost:4000/game-logos/HonorOfKings.png",
  },
  {
    name: "Mobile Legends: Bang Bang",
    logo:
      "http://localhost:4000/game-logos/MobileLegends.png",
  },
  {
    name: "Overwatch 2",
    logo:
      "http://localhost:4000/game-logos/OverWatch2.png",
  },
  {
    name: "Pubg Battlegrounds",
    logo:
      "http://localhost:4000/game-logos/Pubg.png",
  },
  {
    name: "Pubg Mobile",
    logo:
      "http://localhost:4000/game-logos/PubgMobile.png",
  },
  {
    name: "R6 Siege",
    logo:
      "http://localhost:4000/game-logos/R6SX.png",
  },
  {
    name: "Rocket League",
    logo:
      "http://localhost:4000/game-logos/RocketLeague.jpg",
  },
  {
    name: "Street Fighter 6",
    logo:
      "http://localhost:4000/game-logos/StreetFighter6.png",
  },
  {
    name: "Teamfight Tactics",
    logo:
      "http://localhost:4000/game-logos/TFT.png",
  },
  {
    name: "Trackmania",
    logo:
      "http://localhost:4000/game-logos/TrackMania.png",
  },
  {
    name: "Tekken 8",
    logo:
      "http://localhost:4000/game-logos/Tekken8.png",
  },
  {
    name: "Mobile Legends Women's International",
    logo:
      "http://localhost:4000/game-logos/MobileLegendsWomen.png",
  },

  // continue all games...
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