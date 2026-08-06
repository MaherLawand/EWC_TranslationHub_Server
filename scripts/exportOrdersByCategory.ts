/**
 * Broadcast orders per event week, broken down by content category.
 *
 * For each week (games defined in client/src/constants/weeklyGames.ts) it counts
 * every non-parent BROADCAST order whose game belongs to that week, grouped by
 * content category (RAW, OPENER, HYPE_PROMO, ENGAGEMENT, LONG_FORM, EXPLAINER,
 * plus "Uncategorized" for orders with no category). All statuses are counted.
 *
 * A game can belong to more than one week, so an order for such a game is counted
 * in each of those weeks.
 *
 * Usage (from server/):
 *   npx tsx scripts/exportOrdersByCategory.ts             # all weeks -> orders-by-category.json
 *   npx tsx scripts/exportOrdersByCategory.ts 5           # one week  -> orders-by-category-week-5.json
 *   npx tsx scripts/exportOrdersByCategory.ts --upto=4    # weeks 0..4 -> orders-by-category-upto-week-4.json
 */
import "dotenv/config"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { PrismaClient } from "@prisma/client"
import { EWC_WEEKS } from "../../client/src/constants/weeklyGames.js"

const prisma = new PrismaClient()

const CATEGORIES = ["RAW", "OPENER", "HYPE_PROMO", "ENGAGEMENT", "LONG_FORM", "EXPLAINER"] as const
const UNCATEGORIZED = "Uncategorized"

const arg = process.argv.find((a) => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1])
const ONLY_WEEK = arg ? String(arg).trim() : null
// --upto=N limits output to weeks 0..N (ignored when a single week is given).
const uptoArg = process.argv.find((a) => a.startsWith("--upto="))?.slice("--upto=".length)
const UPTO = uptoArg != null && uptoArg !== "" ? Number(uptoArg) : null

/** Match names ignoring case, spaces, and punctuation — mirrors weeklyGames resolution. */
function normalize(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function emptyCounts(): Record<string, number> {
  const c: Record<string, number> = {}
  for (const cat of CATEGORIES) c[cat] = 0
  c[UNCATEGORIZED] = 0
  return c
}

async function main() {
  const weeks = ONLY_WEEK
    ? EWC_WEEKS.filter((w) => w.week === ONLY_WEEK)
    : UPTO != null
    ? EWC_WEEKS.filter((w) => Number(w.week) <= UPTO)
    : EWC_WEEKS
  if (ONLY_WEEK && weeks.length === 0) {
    throw new Error(`Unknown week "${ONLY_WEEK}". Available: ${EWC_WEEKS.map((w) => w.week).join(", ")}`)
  }

  // Pull every non-parent broadcast order once, with its game name + category.
  const orders = await prisma.translationOrder.findMany({
    where: { type: "BROADCAST", isParent: false },
    select: { broadcast: { select: { contentCategory: true, game: { select: { name: true } } } } },
  })
  const flat = orders
    .filter((o) => o.broadcast?.game)
    .map((o) => ({ gameKey: normalize(o.broadcast!.game.name), category: o.broadcast!.contentCategory || UNCATEGORIZED }))

  const result = weeks.map((weekEntry) => {
    // Normalized names/aliases that count as this week's games.
    const keys = new Set<string>()
    for (const g of weekEntry.games) {
      for (const n of [g.game, g.display, ...(g.aliases ?? [])]) if (n) keys.add(normalize(n))
    }
    const byContentCategory = emptyCounts()
    let total = 0
    for (const o of flat) {
      if (!keys.has(o.gameKey)) continue
      byContentCategory[o.category] = (byContentCategory[o.category] ?? 0) + 1
      total++
    }
    return {
      week: weekEntry.week,
      games: weekEntry.games.map((g) => g.display || g.game),
      total,
      byContentCategory,
    }
  })

  const payload = {
    generatedAt: new Date().toISOString(),
    categories: [...CATEGORIES, UNCATEGORIZED],
    scope: "All non-parent broadcast orders, all statuses",
    weeks: result,
  }

  const json = JSON.stringify(payload, null, 2)
  console.log(json)
  const outName = ONLY_WEEK
    ? `orders-by-category-week-${ONLY_WEEK}.json`
    : UPTO != null
    ? `orders-by-category-upto-week-${UPTO}.json`
    : "orders-by-category.json"
  const outPath = resolve(process.cwd(), outName)
  writeFileSync(outPath, json)
  console.error(`\n${result.length} week(s) → ${outPath}`)
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
