/**
 * Weekly Content Report → Google Sheet.
 *
 * Counts VIDEOS (= target-language versions per order), not orders. Parent "big
 * orders" are placeholders and are excluded (matching the website).
 *
 *  - Broadcast: per event week (games from client/src/constants/weeklyGames.ts),
 *    videos grouped by content category.
 *  - Marketing: videos grouped by content title (marketing has no game/week).
 *
 * Writes two tabs ("Broadcast", "Marketing") into the target sheet. The sheet must
 * be shared (Editor) with the service account.
 *
 * Usage (from server/):
 *   npx tsx scripts/exportVideoCounts.ts
 */
import "dotenv/config"
import { PrismaClient } from "@prisma/client"
import { EWC_WEEKS } from "../../client/src/constants/weeklyGames.js"
import { CONTENT_TITLES } from "../../client/src/constants/contentTitles.js"
import { getServiceAccount, getGoogleAccessToken, googleRequest } from "../src/lib/googleSheets.js"

const SHEET_ID = process.argv[2] || "1lQ0Mh6aPS8OfsYNip9HJ3JQ8IFNk76EzfPXs08X4khI"
const prisma = new PrismaClient()

const CATS: { key: string; label: string }[] = [
  { key: "RAW", label: "RAW" },
  { key: "OPENER", label: "Opener" },
  { key: "HYPE_PROMO", label: "Hype Promo" },
  { key: "ENGAGEMENT", label: "Engagement" },
  { key: "LONG_FORM", label: "Long Form" },
  { key: "EXPLAINER", label: "Explainer" },
  { key: "Uncategorized", label: "Uncategorized" },
]
const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "")
const col = (r: number, g: number, b: number) => ({ red: r / 255, green: g / 255, blue: b / 255 })
const WHITE = col(255, 255, 255)

async function main() {
  const token = await getGoogleAccessToken(getServiceAccount())

  // ── Broadcast: videos per week per content category ──────────────────────
  const bOrders = await prisma.translationOrder.findMany({
    where: { type: "BROADCAST", isParent: false },
    select: { broadcast: { select: { contentCategory: true, targetLanguages: true, game: { select: { name: true } } } } },
  })
  const bFlat = bOrders
    .filter((o) => o.broadcast?.game)
    .map((o) => ({
      gameKey: norm(o.broadcast!.game.name),
      cat: o.broadcast!.contentCategory || "Uncategorized",
      videos: (o.broadcast!.targetLanguages || []).length,
    }))

  const bWeeks = EWC_WEEKS.map((w) => {
    const keys = new Set<string>()
    for (const g of w.games) for (const n of [g.game, g.display, ...(g.aliases ?? [])]) if (n) keys.add(norm(n))
    const counts: Record<string, number> = {}
    for (const c of CATS) counts[c.key] = 0
    let total = 0
    for (const o of bFlat) {
      if (!keys.has(o.gameKey)) continue
      counts[o.cat] = (counts[o.cat] ?? 0) + o.videos
      total += o.videos
    }
    return { week: w.week, games: w.games.map((g) => g.display || g.game).join(", "), counts, total }
  })

  // ── Marketing: videos per content title ──────────────────────────────────
  const mOrders = await prisma.translationOrder.findMany({
    where: { type: "MARKETING", isParent: false },
    select: { marketing: { select: { contentTitle: true, targetLanguages: true } } },
  })
  // Seed every known content title at 0 so titles with no videos still appear.
  const mMap = new Map<string, number>()
  for (const t of CONTENT_TITLES) mMap.set(t, 0)
  for (const o of mOrders) {
    if (!o.marketing) continue
    const title = (o.marketing.contentTitle || "").trim() || "(no content title)"
    mMap.set(title, (mMap.get(title) ?? 0) + (o.marketing.targetLanguages || []).length)
  }
  // Most videos first; ties alphabetical (0-video titles fall to the bottom).
  const mRows = [...mMap.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const mTotal = mRows.reduce((s, [, v]) => s + v, 0)

  // ── Sheet: ensure two tabs, write values, format ─────────────────────────
  const meta = await googleRequest<any>("GET", `spreadsheets/${encodeURIComponent(SHEET_ID)}?fields=sheets(properties(sheetId,title,index))`, token)
  const props: { sheetId: number; title: string; index: number }[] = meta.sheets.map((s: any) => s.properties)
  const first = props[0]
  const q = (n: string) => `'${n.replace(/'/g, "''")}'`

  // Rename first tab -> Broadcast; add Marketing if missing.
  const setup: any[] = [{ updateSheetProperties: { properties: { sheetId: first.sheetId, title: "Broadcast" }, fields: "title" } }]
  let marketing = props.find((p) => p.title === "Marketing")
  if (!marketing) setup.push({ addSheet: { properties: { title: "Marketing" } } })
  await googleRequest("POST", `spreadsheets/${encodeURIComponent(SHEET_ID)}:batchUpdate`, token, { requests: setup })
  const meta2 = await googleRequest<any>("GET", `spreadsheets/${encodeURIComponent(SHEET_ID)}?fields=sheets(properties(sheetId,title))`, token)
  const bId = meta2.sheets.find((s: any) => s.properties.title === "Broadcast").properties.sheetId
  const mId = meta2.sheets.find((s: any) => s.properties.title === "Marketing").properties.sheetId

  // Broadcast grid.
  const bHeaders = ["Week", "Games", ...CATS.map((c) => c.label), "Total videos"]
  const bGrid: (string | number)[][] = []
  bGrid.push(["Broadcast — videos per content category (per event week). Videos = target-language versions; parent orders excluded."])
  bGrid.push(bHeaders)
  for (const w of bWeeks) bGrid.push([`Week ${w.week}`, w.games, ...CATS.map((c) => w.counts[c.key]), w.total])

  // Marketing grid.
  const mGrid: (string | number)[][] = []
  mGrid.push(["Marketing — videos per content title. Videos = target-language versions; parent orders excluded."])
  mGrid.push(["Content Title", "Total videos"])
  for (const [title, v] of mRows) mGrid.push([title, v])
  mGrid.push(["TOTAL", mTotal])

  await googleRequest("POST", `spreadsheets/${encodeURIComponent(SHEET_ID)}/values:batchUpdate`, token, {
    valueInputOption: "RAW",
    data: [
      { range: `${q("Broadcast")}!A1`, values: bGrid },
      { range: `${q("Marketing")}!A1`, values: mGrid },
    ],
  })

  // Formatting.
  const reqs: any[] = []
  const BAND = col(244, 247, 251) // subtle zebra stripe
  const styleTab = (sheetId: number, ncols: number, nrows: number, titleColsMerge: number, headerRow = 1, totalRowIdx?: number) => {
    reqs.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: headerRow + 1, hideGridlines: true } }, fields: "gridProperties.frozenRowCount,gridProperties.hideGridlines" } })
    reqs.push({ mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: titleColsMerge }, mergeType: "MERGE_ALL" } })
    reqs.push({ repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: titleColsMerge }, cell: { userEnteredFormat: { backgroundColor: col(31, 41, 55), verticalAlignment: "MIDDLE", wrapStrategy: "WRAP", padding: { top: 6, bottom: 6, left: 12, right: 12 }, textFormat: { bold: true, fontSize: 13, fontFamily: "Arial", foregroundColor: WHITE } } }, fields: "userEnteredFormat(backgroundColor,verticalAlignment,wrapStrategy,padding,textFormat)" } })
    reqs.push({ repeatCell: { range: { sheetId, startRowIndex: headerRow, endRowIndex: headerRow + 1, startColumnIndex: 0, endColumnIndex: ncols }, cell: { userEnteredFormat: { backgroundColor: col(55, 65, 81), horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP", padding: { top: 6, bottom: 6, left: 8, right: 8 }, textFormat: { bold: true, fontSize: 12, fontFamily: "Arial", foregroundColor: WHITE } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,padding,textFormat)" } })
    const dataStart = headerRow + 1
    reqs.push({ repeatCell: { range: { sheetId, startRowIndex: dataStart, endRowIndex: nrows, startColumnIndex: 0, endColumnIndex: ncols }, cell: { userEnteredFormat: { verticalAlignment: "MIDDLE", wrapStrategy: "WRAP", padding: { top: 6, bottom: 6, left: 10, right: 10 }, textFormat: { fontSize: 11, fontFamily: "Arial" } } }, fields: "userEnteredFormat(verticalAlignment,wrapStrategy,padding,textFormat)" } })
    // Zebra striping on data rows (skip the total row so it keeps its own emphasis).
    for (let ri = dataStart; ri < nrows; ri++) {
      if (ri === totalRowIdx) continue
      if ((ri - dataStart) % 2 === 1) reqs.push({ repeatCell: { range: { sheetId, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 0, endColumnIndex: ncols }, cell: { userEnteredFormat: { backgroundColor: BAND } }, fields: "userEnteredFormat.backgroundColor" } })
    }
    const thin = { style: "SOLID", color: col(217, 217, 217) }
    reqs.push({ updateBorders: { range: { sheetId, startRowIndex: headerRow, endRowIndex: nrows, startColumnIndex: 0, endColumnIndex: ncols }, top: thin, bottom: thin, left: thin, right: thin, innerHorizontal: thin, innerVertical: thin } })
    if (totalRowIdx != null) reqs.push({ repeatCell: { range: { sheetId, startRowIndex: totalRowIdx, endRowIndex: totalRowIdx + 1, startColumnIndex: 0, endColumnIndex: ncols }, cell: { userEnteredFormat: { backgroundColor: col(226, 232, 240), textFormat: { bold: true, fontSize: 11, fontFamily: "Arial" } } }, fields: "userEnteredFormat(backgroundColor,textFormat)" } })
    // Comfortable header height.
    reqs.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 40 }, fields: "pixelSize" } })
    reqs.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: headerRow, endIndex: headerRow + 1 }, properties: { pixelSize: 34 }, fields: "pixelSize" } })
  }

  // Broadcast: center the numeric columns (2..ncols-1) and the Total.
  styleTab(bId, bHeaders.length, bGrid.length, bHeaders.length)
  reqs.push({ repeatCell: { range: { sheetId: bId, startRowIndex: 2, endRowIndex: bGrid.length, startColumnIndex: 2, endColumnIndex: bHeaders.length }, cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat.horizontalAlignment" } })
  // Roomier broadcast rows (Games wraps → give them height).
  reqs.push({ updateDimensionProperties: { range: { sheetId: bId, dimension: "ROWS", startIndex: 2, endIndex: bGrid.length }, properties: { pixelSize: 46 }, fields: "pixelSize" } })
  // Widths: Week, Games (wide), category cols, Total.
  const bWidths = [90, 460, ...CATS.map(() => 118), 120]
  bWidths.forEach((w, i) => reqs.push({ updateDimensionProperties: { range: { sheetId: bId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: "pixelSize" } }))

  // Marketing.
  styleTab(mId, 2, mGrid.length, 2, 1, mGrid.length - 1)
  reqs.push({ repeatCell: { range: { sheetId: mId, startRowIndex: 2, endRowIndex: mGrid.length, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat.horizontalAlignment" } })
  reqs.push({ updateDimensionProperties: { range: { sheetId: mId, dimension: "ROWS", startIndex: 2, endIndex: mGrid.length }, properties: { pixelSize: 32 }, fields: "pixelSize" } })
  ;[360, 140].forEach((w, i) => reqs.push({ updateDimensionProperties: { range: { sheetId: mId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: "pixelSize" } }))

  await googleRequest("POST", `spreadsheets/${encodeURIComponent(SHEET_ID)}:batchUpdate`, token, { requests: reqs })

  console.log(`Wrote Broadcast (${bWeeks.length} weeks) + Marketing (${mRows.length} titles, ${mTotal} videos) to`)
  console.log(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
