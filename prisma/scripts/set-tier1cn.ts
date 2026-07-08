import { prisma } from "../../src/lib/prisma.js"

// Games that carry the extra "Tier 1 CN" designation (on top of their normal
// tier). Names are matched case/punctuation-insensitively, with aliases, so DB
// name variants still resolve. Running this sets tier1CN=true for these and
// false for everything else — it's the source of truth for the flag.
const TIER1_CN = [
  ["Valorant"],
  ["Dota 2"],
  ["League of Legends"],
  ["Pubg Battlegrounds", "PUBG", "PUBG PC"],
  ["Pubg Mobile", "PUBG: Mobile"],
  ["Honor of Kings", "HOK"],
  ["Street Fighter 6", "Street Fighter"],
  ["Counter-Strike 2", "CS2", "Counter Strike 2"],
  ["Crossfire", "CrossFire"],
]

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
const targets = new Set(TIER1_CN.flat().map(norm))

async function main() {
  const games = await prisma.game.findMany({ select: { id: true, name: true, tier1CN: true } })
  let on = 0
  let off = 0
  for (const g of games) {
    const shouldBeCN = targets.has(norm(g.name))
    if (g.tier1CN !== shouldBeCN) {
      await prisma.game.update({ where: { id: g.id }, data: { tier1CN: shouldBeCN } })
    }
    if (shouldBeCN) {
      on++
      console.log(`  Tier 1 CN → ${g.name}`)
    } else {
      off++
    }
  }
  console.log(`\nDone. ${on} games flagged Tier 1 CN, ${off} not.`)
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect()
  })
