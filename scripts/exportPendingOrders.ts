/**
 * Export pending BROADCAST orders for one event week as JSON.
 *
 * Weeks are defined by their games in client/src/constants/weeklyGames.ts (the
 * same source the dashboard's game filter uses); a broadcast order belongs to a
 * week when its game matches one of that week's games (by name or alias,
 * case/punctuation-insensitively). Marketing orders have no game, so they are
 * intentionally NOT included.
 *
 * Only PENDING, non-parent orders are exported (standalone orders and sub-orders;
 * parent "big order" aggregators are skipped).
 *
 * Usage (from the server/ directory):
 *   npx tsx scripts/exportPendingOrders.ts            # defaults to week 4
 *   npx tsx scripts/exportPendingOrders.ts 5          # week 5
 *   WEEK=6 npx tsx scripts/exportPendingOrders.ts     # week 6
 *
 * Output: prints the JSON to the console AND writes pending-orders-week-<N>.json
 * in the current directory.
 */
import "dotenv/config"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { PrismaClient } from "@prisma/client"
import { EWC_WEEKS } from "../../client/src/constants/weeklyGames.js"

const prisma = new PrismaClient()

// Which week to export: CLI arg wins, then WEEK env var, then default "4".
const WEEK = String(process.argv[2] ?? process.env.WEEK ?? "4").trim()

/** Match names ignoring case, spaces, and punctuation — mirrors weeklyGames resolution. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

async function main() {
  const weekEntry = EWC_WEEKS.find((w) => w.week === WEEK)
  if (!weekEntry) {
    const available = EWC_WEEKS.map((w) => w.week).join(", ")
    throw new Error(`Unknown week "${WEEK}". Available weeks: ${available}`)
  }

  // Every normalized name/alias that counts as one of this week's games.
  const weekGameKeys = new Set<string>()
  for (const g of weekEntry.games) {
    for (const n of [g.game, g.display, ...(g.aliases ?? [])]) {
      if (n) weekGameKeys.add(normalize(n))
    }
  }

  // Resolve those to real DB game ids.
  const games = await prisma.game.findMany({ select: { id: true, name: true } })
  const matchedGameIds = games
    .filter((g) => weekGameKeys.has(normalize(g.name)))
    .map((g) => g.id)

  if (matchedGameIds.length === 0) {
    console.warn(`No DB games matched week ${WEEK}'s games — output will be empty.`)
  }

  // Pending, non-parent broadcast orders whose game is in this week.
  const orders = await prisma.translationOrder.findMany({
    where: {
      type: "BROADCAST",
      status: "PENDING",
      isParent: false,
      broadcast: { gameId: { in: matchedGameIds } },
    },
    select: {
      title: true,
      priority: true,
      broadcast: {
        select: {
          sourceLanguage: true,
          targetLanguages: true,
          contentCategory: true,
          deadlineDate: true,
          deadlineHasTime: true,
          deliveryFormats: { select: { format: true } },
          game: { select: { name: true, tier: true, tier1CN: true } },
        },
      },
    },
  })

  const rows = orders
    .map((o) => {
      const b = o.broadcast!
      return {
        type: "broadcast",
        title: o.title,
        contentCategory: b.contentCategory, // broadcast-only (RAW/OPENER/…)
        tier: b.game.tier,
        tier1CN: b.game.tier1CN,
        game: b.game.name,
        sourceLanguages: b.sourceLanguage,
        targetLanguages: b.targetLanguages,
        format: b.deliveryFormats.map((f) => f.format),
        deadline: b.deadlineDate ? b.deadlineDate.toISOString() : null,
        deadlineHasTime: b.deadlineHasTime,
        priority: o.priority,
      }
    })
    // Soonest deadline first; nulls last.
    .sort((a, b) => {
      if (!a.deadline) return 1
      if (!b.deadline) return -1
      return a.deadline.localeCompare(b.deadline)
    })

  const json = JSON.stringify(rows, null, 2)
  console.log(json)

  const outPath = resolve(process.cwd(), `pending-orders-week-${WEEK}.json`)
  writeFileSync(outPath, json)
  console.error(`\nWeek ${WEEK}: ${rows.length} pending broadcast order(s) → ${outPath}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
