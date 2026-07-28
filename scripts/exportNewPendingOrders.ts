/**
 * Export only the NEW pending broadcast orders for an event week — i.e. the ones
 * that are not already in the previous JSON export. Same query/logic as
 * exportPendingOrders.ts (PENDING, non-parent broadcast orders for the week's
 * games; big orders excluded; marketing excluded), then it drops any order that
 * already appears in the old file, matched by TITLE + GAME.
 *
 * Usage (from the server/ directory):
 *   npx tsx scripts/exportNewPendingOrders.ts                 # week 4, old = pending-orders-week-4.json
 *   npx tsx scripts/exportNewPendingOrders.ts 5               # week 5, old = pending-orders-week-5.json
 *   npx tsx scripts/exportNewPendingOrders.ts 4 --old=path    # explicit baseline file
 *   WEEK=6 npx tsx scripts/exportNewPendingOrders.ts
 *
 * Output: prints the NEW-only JSON to the console AND writes
 * pending-orders-week-<N>-new.json in the current directory. The old file is left
 * untouched, so it stays the baseline until you replace it.
 */
import "dotenv/config"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { PrismaClient } from "@prisma/client"
import { EWC_WEEKS } from "../../client/src/constants/weeklyGames.js"

const prisma = new PrismaClient()

const args = process.argv.slice(2)
// Which week to export: first non-flag arg wins, then WEEK env, then default "4".
const WEEK = String(args.find((a) => !a.startsWith("--")) ?? process.env.WEEK ?? "4").trim()
// Baseline file: --old=path, else the previous export for this week.
const oldArg = args.find((a) => a.startsWith("--old="))?.slice("--old=".length)

/** Match names ignoring case, spaces, and punctuation — mirrors weeklyGames resolution. */
function normalize(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

/** Identity of an order for duplicate detection: title + game. */
function orderKey(title: string, game: string): string {
  return `${normalize(title)}|${normalize(game)}`
}

async function main() {
  const weekEntry = EWC_WEEKS.find((w) => w.week === WEEK)
  if (!weekEntry) {
    const available = EWC_WEEKS.map((w) => w.week).join(", ")
    throw new Error(`Unknown week "${WEEK}". Available weeks: ${available}`)
  }

  // Load the previous export as the baseline. Missing/invalid → treat everything
  // as new (nothing to dedupe against).
  const oldPath = resolve(process.cwd(), oldArg || `pending-orders-week-${WEEK}.json`)
  const seen = new Set<string>()
  try {
    const parsed = JSON.parse(readFileSync(oldPath, "utf8"))
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (row && typeof row.title === "string") seen.add(orderKey(row.title, row.game || ""))
      }
    }
    console.error(`Baseline: ${seen.size} order(s) from ${oldPath}`)
  } catch {
    console.error(`No baseline found at ${oldPath} — every current order will be treated as new.`)
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

  // Pending, non-parent (no big orders) broadcast orders whose game is in this week.
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
    // Keep only orders NOT already in the baseline (new since the old file).
    .filter((row) => !seen.has(orderKey(row.title, row.game)))
    // Soonest deadline first; nulls last.
    .sort((a, b) => {
      if (!a.deadline) return 1
      if (!b.deadline) return -1
      return a.deadline.localeCompare(b.deadline)
    })

  const json = JSON.stringify(rows, null, 2)
  console.log(json)

  const outPath = resolve(process.cwd(), `pending-orders-week-${WEEK}-new.json`)
  writeFileSync(outPath, json)
  console.error(`\nWeek ${WEEK}: ${rows.length} NEW pending broadcast order(s) → ${outPath}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
