/**
 * DAILY ORDERS REPORT → Google Sheets
 * ===================================
 * A Google Sheets version of daily-report.ts. It deliberately leaves the Excel
 * script unchanged.
 *
 * ONE CSV = ONE TAB. Each CSV in server/logs/ becomes its own report tab, named
 * after the file (e.g. "07132026_10_10"). Drop a new CSV and re-run to add/update
 * its tab. The database is the source of truth for each order's current status and
 * status timestamps.
 *
 * NEVER DELETES: the script only clears/rewrites the tabs for the CSVs currently
 * present (plus "Daily Report - Overview"); every other tab is left untouched. So
 * past report windows stay forever, even after you remove their CSV from the folder.
 *
 * Usage (from server/):
 *   npx tsx prisma/scripts/daily-report-google-sheets.ts [path] [options]
 *
 * Options:
 *   --sheet=<spreadsheet-id>  Write to an existing Google Sheet. Defaults to
 *                              GOOGLE_SHEETS_SPREADSHEET_ID, or creates one.
 *   --title=<name>            Title used if the script creates a new Sheet.
 *   --date=YYYY-MM-DD         Only include events on this UTC day.
 *   --base=https://...        Base app URL for clickable order titles.
 *   --dry-run                 Parse and prepare the report without Google API
 *                              credentials or network writes.
 *
 * Required Google service-account environment variables (choose one form):
 *   GOOGLE_SERVICE_ACCOUNT_JSON='{"client_email":"...","private_key":"..."}'
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL=...
 *   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...'
 *
 * The Google Sheet must be shared with the service account as an Editor.
 */

import "dotenv/config" // loads server/.env so GOOGLE_* / DATABASE_URL / CLIENT_URL are available
import { readFileSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  getServiceAccount,
  getGoogleAccessToken,
  googleRequest,
} from "../../src/lib/googleSheets.js"

const DEFAULT_LOGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "logs")
const REPORT_TAB_PREFIX = "Daily Report - "
const OVERVIEW_TAB = `${REPORT_TAB_PREFIX}Overview`
const UTC_DAY_MS = 24 * 60 * 60 * 1000
// Report-only rule: the website gives RAW/ASAP a tight ~20-min deadline, but in
// this report a RAW order only counts as "delayed" if it took more than 2 hours
// from source-added (ready) to completion.
const RAW_REPORT_THRESHOLD_MS = 2 * 60 * 60 * 1000

// Only these statuses appear in the report (no Pending, Ready, or Deleted).
const SHOWN_STATUSES = new Set(["IN_PROGRESS", "COMPLETED"])

// Sentinel placed in a row's first cell to render it as a solid black divider.
const DIVIDER_MARK = "▬▬▬"

const ORDER_ACTIONS = new Set([
  "CREATE_ORDER",
  "CREATE_SUB_ORDERS",
  "DUPLICATE_SUB_ORDER",
  "UPDATE_ORDER",
  "UPDATE_ORDER_STATUS",
  "DELETE_ORDER",
  "ASSIGN_USERS_TO_ORDER",
  "CREATE_FEEDBACK",
])

type CsvEvent = { ts: string; action: string; attrs: any }
type StatusName = "PENDING" | "READY_FOR_TRANSLATION" | "IN_PROGRESS" | "COMPLETED" | "DELETED"
type Delay = { hours: number; kind: "late" | "overdue" | "early" | "left" }

type OrderReport = {
  orderId: string
  title: string
  createdBy?: string
  type: string
  event?: string
  priority?: string
  deliveryFormat?: string
  contentCategory?: string
  currentStatus?: string
  readyAt?: string
  inProgressAt?: string
  completedAt?: string
  completedBy?: string
  deadline?: string
  deadlineHasTime?: boolean
  /** Roles the source-file email was routed to (the order's Notify pills). */
  notifyPositions?: string[]
  assignedTo: string[]
  deletedBy?: string
  deletedAt?: string
  activeDates: Set<string>
}

type Column = { header: string; width: number }
type SheetSpec = { name: string; columns: Column[]; rows: string[][] }

function gatherCsvFiles(inputArg?: string): { files: string[]; baseDir: string } {
  const target = inputArg || DEFAULT_LOGS_DIR
  let st
  try { st = statSync(target) } catch {
    console.error(`Path not found: ${target}`)
    if (!inputArg) console.error("Create server/logs and drop Railway CSV exports there.")
    process.exit(1)
  }

  if (!st.isDirectory()) return { files: [target], baseDir: dirname(target) }

  const files = readdirSync(target)
    .filter((file) => /\.csv$/i.test(file))
    .map((file) => join(target, file))
    .sort()
  if (files.length === 0) {
    console.error("No .csv files found. Drop Railway CSV exports into the selected folder and try again.")
    process.exit(1)
  }
  return { files, baseDir: target }
}

/** Minimal RFC-4180 parser — the attributes column contains JSON with commas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += char
    } else if (char === '"') inQuotes = true
    else if (char === ",") { row.push(field); field = "" }
    else if (char === "\r") { /* Skip CR in CRLF input. */ }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = "" }
    else field += char
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

const pad = (value: number) => String(value).padStart(2, "0")

function utcTimestamp(value?: string | Date | null): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

function utcDay(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

function displayDeadline(value?: string, hasTime = false): string {
  if (!value) return ""
  if (hasTime) return utcTimestamp(value)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} (end of day UTC)`
}

function nice(value?: string): string {
  return (value || "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase())
}

// Broadcast content categories + their expected turnaround (mirrors the client
// constants). Shown as "Hype Promo (4h)".
const CONTENT_CATEGORY_INFO: Record<string, { label: string; hours: string }> = {
  RAW: { label: "Raw", hours: "ASAP" },
  OPENER: { label: "Opener", hours: "2h" },
  HYPE_PROMO: { label: "Hype Promo", hours: "4h" },
  ENGAGEMENT: { label: "Engagement", hours: "5h" },
  LONG_FORM: { label: "Long Form", hours: "8h" },
  EXPLAINER: { label: "Explainer", hours: "12h" },
}
// External vendors the source-file email can be routed to. TRANSLATOR is the
// in-house team, so it's deliberately absent — the report tracks vendor
// assignment only, and an order sent only to Translator shows blank here.
// Key order fixes the display order, so it never varies with pill click order.
const VENDOR_LABELS: Record<string, string> = {
  TRANSPERFECT: "TransPerfect",
  TARJAMA: "Tarjama",
}
function vendorCell(notifyPositions?: string[]): string {
  if (!notifyPositions?.length) return ""
  const chosen = new Set(notifyPositions)
  return Object.keys(VENDOR_LABELS)
    .filter((role) => chosen.has(role))
    .map((role) => VENDOR_LABELS[role])
    .join(", ")
}

function contentCategoryCell(value?: string): string {
  if (!value) return ""
  const info = CONTENT_CATEGORY_INFO[value]
  return info ? info.label : nice(value)
}
// Plain-English turnaround target, e.g. "Should be delivered within 5 hours".
// RAW/ASAP maps to 2 hours (the report's RAW rule).
function deliveryTargetCell(value?: string): string {
  if (!value) return ""
  const info = CONTENT_CATEGORY_INFO[value]
  if (!info) return ""
  const hours = info.hours === "ASAP" ? 2 : parseInt(info.hours, 10)
  if (!hours) return ""
  return `Should be delivered within ${hours} hour${hours === 1 ? "" : "s"}`
}

function personName(user: any): string {
  return `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim()
}

/**
 * Mirrors the existing order sidebar: date-only deadlines are due at the end
 * of their UTC day; timed deadlines are compared as exact instants.
 */
function getDelay(order: OrderReport): Delay | null {
  // Deleted orders aren't in flight.
  if (order.deletedAt || order.currentStatus === "DELETED") return null

  // Target instant: RAW = source-added + 2h; else the deadline (date-only → end of day).
  let targetMs: number
  if (order.contentCategory === "RAW") {
    if (!order.readyAt) return null
    const readyMs = new Date(order.readyAt).getTime()
    if (Number.isNaN(readyMs)) return null
    targetMs = readyMs + RAW_REPORT_THRESHOLD_MS
  } else {
    if (!order.deadline) return null
    const storedDeadlineMs = new Date(order.deadline).getTime()
    if (Number.isNaN(storedDeadlineMs)) return null
    targetMs = order.deadlineHasTime ? storedDeadlineMs : storedDeadlineMs + UTC_DAY_MS - 1
  }

  const H = 60 * 60 * 1000
  if (order.completedAt) {
    const completedMs = new Date(order.completedAt).getTime()
    if (Number.isNaN(completedMs)) return null
    const diff = completedMs - targetMs
    if (diff > 0) return { hours: diff / H, kind: "late" }
    if (diff < 0) return { hours: -diff / H, kind: "early" } // completed before target
    return null // exactly on time
  }

  // Not completed yet → overdue if now is past the target, otherwise "time left"
  // counting down to the deadline.
  const diff = Date.now() - targetMs
  if (diff > 0) return { hours: diff / H, kind: "overdue" }
  if (diff < 0) return { hours: -diff / H, kind: "left" }
  return null // exactly at the deadline
}

// Under this many hours a late/overdue delay is "minor" (light orange); at/above
// it's bigger (red). Markers: ⚠ minor late, ⛔ big late/overdue, ✅ early.
const MINOR_DELAY_MAX_HOURS = 1

function delayCell(delay: Delay | null): string {
  if (!delay) return ""
  const totalMin = Math.round(delay.hours * 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  const amount = h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`
  if (delay.kind === "early") return `✅ ${amount} early`
  if (delay.kind === "left") return `⏳ ${amount} left` // in progress, deadline not reached
  const marker = delay.hours < MINOR_DELAY_MAX_HOURS ? "⚠" : "⛔"
  return `${marker} ${amount} ${delay.kind === "overdue" ? "overdue" : "late"}`
}

/** Human duration between two ISO instants, e.g. "3h 12m", "45m". Blank if
 *  either is missing or the range is negative. */
function durationLabel(fromIso?: string, toIso?: string): string {
  if (!fromIso || !toIso) return ""
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime()
  if (Number.isNaN(ms) || ms < 0) return ""
  const mins = Math.round(ms / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}

/** Allotted window from when the source was added to the deadline (date-only
 *  deadlines are treated as end-of-day, matching getDelay). Blank if missing. */
function sourceToDeadlineLabel(order: OrderReport): string {
  if (!order.readyAt || !order.deadline) return ""
  const readyMs = new Date(order.readyAt).getTime()
  const storedMs = new Date(order.deadline).getTime()
  if (Number.isNaN(readyMs) || Number.isNaN(storedMs)) return ""
  const deadlineMs = order.deadlineHasTime ? storedMs : storedMs + UTC_DAY_MS - 1
  const ms = deadlineMs - readyMs
  if (ms < 0) return ""
  const mins = Math.round(ms / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}

function orderUrl(base: string, order: OrderReport): string {
  if (!base || !order.orderId) return ""
  const page = order.type.toUpperCase() === "MARKETING" ? "marketing" : "Broadcast"
  const root = base.replace(/\/+$/, "")
  return `${root}/?page=${page}&orderId=${encodeURIComponent(order.orderId)}${order.event ? `&event=${encodeURIComponent(order.event)}` : ""}`
}

function sheetsFormulaString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function orderTitleCell(order: OrderReport, siteBase: string): string {
  const title = order.title || "(unknown order)"
  const url = orderUrl(siteBase, order)
  if (!url) return title
  return `=HYPERLINK(${sheetsFormulaString(url)},${sheetsFormulaString(title)})`
}

function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`
}

function findArgument(args: string[], name: string): string {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || ""
}

function getOrder(orders: Map<string, OrderReport>, orderId: string): OrderReport {
  let order = orders.get(orderId)
  if (!order) {
    order = { orderId, title: "", type: "", assignedTo: [], activeDates: new Set() }
    orders.set(orderId, order)
  }
  return order
}

// Each CSV becomes its own tab, named after the file (minus extension). Sheets
// tab names can't contain []:*?/\ and cap at 100 chars.
export function tabNameFromFile(file: string): string {
  const base = basename(file).replace(/\.csv$/i, "")
  return base.replace(/[[\]:*?/\\]/g, "-").slice(0, 100) || "Report"
}

type GoogleSheetInfo = { properties: { sheetId: number; title: string }; conditionalFormats?: unknown[] }
type GoogleSpreadsheet = { spreadsheetId: string; spreadsheetUrl: string; sheets: GoogleSheetInfo[] }

async function createSpreadsheet(token: string, title: string): Promise<GoogleSpreadsheet> {
  return googleRequest<GoogleSpreadsheet>("POST", "spreadsheets", token, {
    properties: { title },
    sheets: [{ properties: { title: OVERVIEW_TAB } }],
  })
}

async function fetchSpreadsheet(token: string, spreadsheetId: string): Promise<GoogleSpreadsheet> {
  return googleRequest<GoogleSpreadsheet>("GET", `spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,spreadsheetUrl,sheets(properties,conditionalFormats)`, token)
}

function sheetIdByName(spreadsheet: GoogleSpreadsheet): Map<string, number> {
  return new Map(spreadsheet.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]))
}

// How many conditional-format rules each existing sheet currently has (so we can
// delete them before re-applying, otherwise old rules pile up every run).
function conditionalRuleCounts(spreadsheet: GoogleSpreadsheet): Map<number, number> {
  return new Map(spreadsheet.sheets.map((sheet) => [sheet.properties.sheetId, sheet.conditionalFormats?.length ?? 0]))
}

/**
 * The Overview tab accumulates one row per report (CSV) across days. Since each
 * run only knows about the CSVs currently present, we read the existing Overview
 * rows so archived days aren't lost — the caller merges them with this run's rows.
 * Returns the data rows only (title/header rows filtered out). Empty on first run.
 */
async function fetchOverviewDataRows(token: string, spreadsheetId: string): Promise<string[][]> {
  if (!spreadsheetId) return []
  try {
    const res = await googleRequest<{ values?: string[][] }>(
      "GET",
      `spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${quoteSheetName(OVERVIEW_TAB)}!A:D`)}`,
      token
    )
    const rows = res.values ?? []
    return rows.filter((row) => row[0] && row[0] !== "Report (CSV)" && !String(row[0]).startsWith("Daily Orders Report"))
  } catch {
    return [] // Overview tab doesn't exist yet (first run) or couldn't be read.
  }
}

function rangeFor(sheetId: number, rows: number, columns: number, startRow = 0) {
  return { sheetId, startRowIndex: startRow, endRowIndex: Math.max(startRow + 1, rows), startColumnIndex: 0, endColumnIndex: columns }
}

function gridColor(red: number, green: number, blue: number) {
  return { red: red / 255, green: green / 255, blue: blue / 255 }
}

/** 0 → "A", 1 → "B", 25 → "Z", 26 → "AA" … (for A1-style formulas). */
function columnLetter(index: number): string {
  let n = index + 1
  let s = ""
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
  return s
}

async function publishGoogleSheets(
  token: string,
  existingId: string,
  spreadsheetTitle: string,
  sheets: SheetSpec[]
): Promise<GoogleSpreadsheet> {
  let spreadsheet = existingId
    ? await fetchSpreadsheet(token, existingId)
    : await createSpreadsheet(token, spreadsheetTitle)

  const existingNames = sheetIdByName(spreadsheet)
  // IMPORTANT: never delete tabs. Only clear the tabs we're about to (re)write —
  // every other tab (past report windows) is left completely untouched.
  const clearRanges = sheets
    .filter((spec) => existingNames.has(spec.name))
    .map((spec) => `${quoteSheetName(spec.name)}!A:Z`)
  if (clearRanges.length > 0) {
    await googleRequest("POST", `spreadsheets/${encodeURIComponent(spreadsheet.spreadsheetId)}/values:batchClear`, token, { ranges: clearRanges })
  }

  const setupRequests: any[] = []
  for (const spec of sheets) {
    if (!existingNames.has(spec.name)) setupRequests.push({ addSheet: { properties: { title: spec.name } } })
  }
  if (setupRequests.length > 0) {
    await googleRequest("POST", `spreadsheets/${encodeURIComponent(spreadsheet.spreadsheetId)}:batchUpdate`, token, { requests: setupRequests })
    spreadsheet = await fetchSpreadsheet(token, spreadsheet.spreadsheetId)
  }

  const ids = sheetIdByName(spreadsheet)
  const ruleCounts = conditionalRuleCounts(spreadsheet)
  const values = sheets.map((spec) => ({ range: `${quoteSheetName(spec.name)}!A1`, values: spec.rows }))
  await googleRequest("POST", `spreadsheets/${encodeURIComponent(spreadsheet.spreadsheetId)}/values:batchUpdate`, token, {
    valueInputOption: "USER_ENTERED",
    data: values,
  })

  const styleRequests: any[] = []
  const headerFill = gridColor(31, 41, 55)
  const headerText = gridColor(255, 255, 255)
  const titleText = gridColor(245, 217, 138)
  // Delay severity colors (fills the Delay cell only, so the title stays a link).
  const minorDelayFill = gridColor(255, 224, 178) // light orange
  const minorDelayText = gridColor(120, 63, 4)
  const majorDelayFill = gridColor(244, 199, 195) // light red
  const majorDelayText = gridColor(153, 0, 0)
  const earlyFill = gridColor(217, 234, 211) // light green (completed ahead of target)
  const earlyText = gridColor(39, 78, 19)
  const leftFill = gridColor(207, 226, 243) // light blue (in progress, time remaining)
  const leftText = gridColor(28, 69, 135)
  // Status section band — STRONG saturated color + white text, so it clearly
  // reads as a major divider (everything below belongs to that status).
  const statusBand: Record<string, { fill: any; text: any }> = {
    IN_PROGRESS: { fill: gridColor(52, 101, 164), text: gridColor(255, 255, 255) },
    COMPLETED: { fill: gridColor(67, 129, 62), text: gridColor(255, 255, 255) },
  }
  // Type subsection band (Marketing / Broadcast) — a clean light slate, clearly
  // secondary to the strong status band above it.
  const subsectionFill = gridColor(222, 228, 236)
  const subsectionText = gridColor(30, 41, 59)
  const statusColors: Record<StatusName, any> = {
    PENDING: gridColor(255, 242, 204),
    READY_FOR_TRANSLATION: gridColor(217, 242, 247),
    IN_PROGRESS: gridColor(189, 215, 238),
    COMPLETED: gridColor(198, 239, 206),
    DELETED: gridColor(244, 204, 204),
  }

  for (const spec of sheets) {
    const sheetId = ids.get(spec.name)
    if (sheetId === undefined) throw new Error(`Google Sheets did not create tab "${spec.name}".`)
    const rowCount = spec.rows.length
    const columnCount = spec.columns.length
    const titleRange = rangeFor(sheetId, 1, columnCount)
    const headerRange = rangeFor(sheetId, 2, columnCount, 1)
    const dataRange = rangeFor(sheetId, rowCount, columnCount, 2)

    // Reset the tab's formatting first so nothing accumulates across runs:
    // delete every existing conditional-format rule, then clear all cell formats
    // (fixes old wider-column colors lingering after columns were removed).
    const existingRules = ruleCounts.get(sheetId) ?? 0
    for (let i = 0; i < existingRules; i++) styleRequests.push({ deleteConditionalFormatRule: { sheetId, index: 0 } })
    styleRequests.push({ repeatCell: { range: { sheetId }, cell: {}, fields: "userEnteredFormat" } })

    styleRequests.push(
      { unmergeCells: { range: { sheetId } } },
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2, hideGridlines: false } }, fields: "gridProperties.frozenRowCount,gridProperties.hideGridlines" } },
      { mergeCells: { range: titleRange, mergeType: "MERGE_ALL" } },
      { repeatCell: { range: titleRange, cell: { userEnteredFormat: { backgroundColor: headerFill, textFormat: { bold: true, fontSize: 14, foregroundColor: titleText }, verticalAlignment: "MIDDLE", horizontalAlignment: "LEFT" } }, fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment,horizontalAlignment)" } },
      { repeatCell: { range: headerRange, cell: { userEnteredFormat: { backgroundColor: gridColor(55, 65, 81), textFormat: { bold: true, foregroundColor: headerText }, verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" } }, fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)" } },
      { repeatCell: { range: dataRange, cell: { userEnteredFormat: { verticalAlignment: "TOP", wrapStrategy: "WRAP" } }, fields: "userEnteredFormat(verticalAlignment,wrapStrategy)" } },
      { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columnCount } } } },
    )

    // Delay cell: bold + color by kind — light red bigger late/overdue (⛔),
    // light orange minor late (⚠), light green early (✅), light blue time-left (⏳),
    // while the order title keeps its link color.
    const delayIndex = spec.columns.findIndex((column) => column.header === "Late / Early")
    if (delayIndex >= 0) {
      const delayRef = `$${columnLetter(delayIndex)}3`
      const delayCol = { ...dataRange, startColumnIndex: delayIndex, endColumnIndex: delayIndex + 1 }
      styleRequests.push(
        { addConditionalFormatRule: { index: 0, rule: { ranges: [delayCol], booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=REGEXMATCH(${delayRef},"✅")` }] }, format: { backgroundColor: earlyFill, textFormat: { bold: true, foregroundColor: earlyText } } } } } },
        { addConditionalFormatRule: { index: 0, rule: { ranges: [delayCol], booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=REGEXMATCH(${delayRef},"⏳")` }] }, format: { backgroundColor: leftFill, textFormat: { bold: true, foregroundColor: leftText } } } } } },
        { addConditionalFormatRule: { index: 0, rule: { ranges: [delayCol], booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=REGEXMATCH(${delayRef},"⛔")` }] }, format: { backgroundColor: majorDelayFill, textFormat: { bold: true, foregroundColor: majorDelayText } } } } } },
        { addConditionalFormatRule: { index: 0, rule: { ranges: [delayCol], booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=REGEXMATCH(${delayRef},"⚠")` }] }, format: { backgroundColor: minorDelayFill, textFormat: { bold: true, foregroundColor: minorDelayText } } } } } },
      )
    }

    // Color the Status cells by value. Locate the column dynamically so inserting
    // other columns (e.g. "Created by") can't misalign the formatting. The overview
    // tab has no Status column, so this is simply skipped there.
    const statusIndex = spec.columns.findIndex((column) => column.header === "Status")
    if (statusIndex >= 0) {
      const statusRef = `$${columnLetter(statusIndex)}3`
      for (const [status, color] of Object.entries(statusColors)) {
        styleRequests.push({
          addConditionalFormatRule: {
            index: 0,
            rule: {
              ranges: [{ ...dataRange, startColumnIndex: statusIndex, endColumnIndex: statusIndex + 1 }],
              booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=${statusRef}=\"${nice(status)}\"` }] }, format: { backgroundColor: color } },
            },
          },
        })
      }

      // Full-width status SECTION header bands (rows whose Order cell starts
      // with "▸ STATUS"): strong color + white bold + larger font.
      for (const status of ["IN_PROGRESS", "COMPLETED"] as const) {
        const band = statusBand[status]
        styleRequests.push({
          addConditionalFormatRule: {
            index: 0,
            rule: {
              ranges: [dataRange],
              booleanRule: {
                condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=REGEXMATCH($A3,"^▸ ${status.replace(/_/g, " ")}")` }] },
                format: { backgroundColor: band.fill, textFormat: { bold: true, foregroundColor: band.text } },
              },
            },
          },
        })
      }

      // Type SUBSECTION header bands (rows whose Order cell starts with "▪ ").
      styleRequests.push({
        addConditionalFormatRule: {
          index: 0,
          rule: {
            ranges: [dataRange],
            booleanRule: {
              condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: '=REGEXMATCH($A3,"^▪ ")' }] },
              format: { backgroundColor: subsectionFill, textFormat: { bold: true, foregroundColor: subsectionText } },
            },
          },
        },
      })

      // Solid BLACK divider row (between status blocks). Black text hides the
      // marker so the whole row reads as one clean black bar.
      styleRequests.push({
        addConditionalFormatRule: {
          index: 0,
          rule: {
            ranges: [dataRange],
            booleanRule: {
              condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: '=REGEXMATCH($A3,"^▬")' }] },
              format: { backgroundColor: gridColor(0, 0, 0), textFormat: { foregroundColor: gridColor(0, 0, 0) } },
            },
          },
        },
      })
    }

    spec.columns.forEach((column, index) => {
      styleRequests.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 }, properties: { pixelSize: column.width }, fields: "pixelSize" } })
    })
    styleRequests.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 32 }, fields: "pixelSize" } })
  }

  await googleRequest("POST", `spreadsheets/${encodeURIComponent(spreadsheet.spreadsheetId)}:batchUpdate`, token, { requests: styleRequests })
  return spreadsheet
}

export type DailyReportInput = { tabName: string; csvText: string }
export type DailyReportOptions = {
  sheetId: string
  sheetTitle?: string
  siteBase?: string
  dateFilter?: string
  dryRun?: boolean
}
export type DailyReportResult = {
  spreadsheetUrl: string
  tabs: { name: string; rows: number }[]
  orders: number
  events: number
  delayed: number
}

/**
 * Core generator, shared by the CLI wrapper below and the /reports/daily endpoint.
 * Works from already-read CSV TEXT — it never reads files, parses argv, calls
 * process.exit, or disconnects Prisma (callers own the process lifecycle). Throws
 * on failure instead of exiting.
 */
export async function runDailyReport(
  inputs: DailyReportInput[],
  opts: DailyReportOptions
): Promise<DailyReportResult> {
  const sheetId = opts.sheetId
  const sheetTitle = opts.sheetTitle || "EWC Daily Orders Report"
  const siteBase = opts.siteBase || ""
  const dateFilter = opts.dateFilter || ""
  const dryRun = opts.dryRun || false

  // Parse each CSV into its OWN event list. Every input becomes its own report tab
  // (named by the caller), so download windows are never merged, split by day, or
  // deleted — a new CSV just adds/updates that one tab.
  type FileReport = { tab: string; events: CsvEvent[]; orderIds: Set<string> }
  const fileReports: FileReport[] = []
  const allOrderIds = new Set<string>()

  for (const input of inputs) {
    const rows = parseCsv(input.csvText)
    if (rows.length === 0) continue
    const header = rows[0].map((cell) => cell.trim().toLowerCase())
    const attributesIndex = header.indexOf("attributes")
    const timestampIndex = header.indexOf("timestamp")
    if (attributesIndex === -1) { console.warn(`Skipping ${input.tabName} — no attributes column.`); continue }

    const events: CsvEvent[] = []
    const seen = new Set<string>()
    const orderIds = new Set<string>()
    for (const row of rows.slice(1)) {
      const rawAttributes = row[attributesIndex]
      if (!rawAttributes) continue
      let attrs: any
      try { attrs = JSON.parse(rawAttributes) } catch { continue }
      if (!ORDER_ACTIONS.has(attrs?.action)) continue
      const ts = attrs.ts || (timestampIndex >= 0 ? row[timestampIndex] : "") || ""
      if (!ts || (dateFilter && !String(ts).startsWith(dateFilter))) continue
      const key = `${ts}|${JSON.stringify(attrs)}`
      if (seen.has(key)) continue
      seen.add(key)
      events.push({ ts, action: attrs.action, attrs })
           const orderId = attrs.orderId || attrs.newId || attrs.deleted?.id || attrs.parentId || ""
      if (orderId) { orderIds.add(orderId); allOrderIds.add(orderId) }
      // // A tab only includes orders whose STATUS actually changed in this window
      // // (In Progress / Completed happened here) — NOT old orders that were merely
      // // edited, reassigned, or had feedback added during the window.
      // if (attrs.action === "UPDATE_ORDER_STATUS" && attrs.orderId) {
      //   orderIds.add(attrs.orderId)
      //   allOrderIds.add(attrs.orderId)
      // }
    }
    if (events.length > 0) fileReports.push({ tab: input.tabName, events, orderIds })
  }

  if (fileReports.length === 0) {
    throw new Error(`No order events found${dateFilter ? ` for ${dateFilter}` : ""} in ${inputs.length} CSV input(s).`)
  }

  // One global order map from every event (across all files), sorted by time.
  const orders = new Map<string, OrderReport>()
  const allEvents = fileReports.flatMap((fr) => fr.events).sort((a, b) => a.ts.localeCompare(b.ts))
  for (const event of allEvents) {
    const attrs = event.attrs
    const orderId = attrs.orderId || attrs.newId || attrs.deleted?.id || attrs.parentId || ""
    if (!orderId) continue
    const order = getOrder(orders, orderId)
    order.activeDates.add(utcDay(event.ts))
    order.title ||= attrs.title || attrs.orderTitle || attrs.deleted?.title || ""
    order.type ||= attrs.type || attrs.deleted?.type || ""
    order.event ||= attrs.event || attrs.deleted?.event || ""
    order.priority ||= attrs.priority || attrs.deleted?.priority || ""

    if (event.action === "UPDATE_ORDER_STATUS") order.currentStatus = attrs.to || order.currentStatus
    if (event.action === "DELETE_ORDER") {
      order.currentStatus = "DELETED"
      order.deletedBy = attrs.userName || "Unknown"
      order.deletedAt = event.ts
    }
  }

  // The database supplies the status timestamp fields added to TranslationOrder,
  // current status, deadline, completion actor, and live assignments.
  let prisma: any = null
  try { prisma = (await import("../../src/lib/prisma.js")).prisma } catch { /* dry-run still works without Prisma */ }
  if (prisma) {
    try {
      const dbOrders = await prisma.translationOrder.findMany({
        where: { id: { in: [...orders.keys()] } },
        select: {
          id: true, title: true, type: true, event: true, priority: true, status: true,
          readyAt: true, inProgressAt: true, completedAt: true, notifyPositions: true,
          createdBy: { select: { firstName: true, lastName: true } },
          completedBy: { select: { firstName: true, lastName: true } },
          marketing: {
            select: {
              deadlineDate: true, deadlineHasTime: true,
              deliveryFormats: { select: { format: true } },
              assignments: { select: { user: { select: { firstName: true, lastName: true } } } },
            },
          },
          broadcast: {
            select: {
              deadlineDate: true, deadlineHasTime: true, contentCategory: true,
              deliveryFormats: { select: { format: true } },
              game: { select: { assignedUsers: { select: { user: { select: { firstName: true, lastName: true } } } } } },
            },
          },
        },
      })
      for (const dbOrder of dbOrders) {
        const order = orders.get(dbOrder.id)
        if (!order) continue
        order.title ||= dbOrder.title
        order.type ||= dbOrder.type
        order.event ||= dbOrder.event
        order.priority ||= dbOrder.priority
        if (!order.deletedAt) order.currentStatus = dbOrder.status
        order.createdBy = personName(dbOrder.createdBy)
        order.readyAt = dbOrder.readyAt?.toISOString()
        order.inProgressAt = dbOrder.inProgressAt?.toISOString()
        order.completedAt = dbOrder.completedAt?.toISOString()
        order.completedBy = personName(dbOrder.completedBy)
        order.notifyPositions = dbOrder.notifyPositions
        const details = dbOrder.broadcast || dbOrder.marketing
        order.deadline = details?.deadlineDate?.toISOString()
        order.deadlineHasTime = details?.deadlineHasTime || false
        order.contentCategory = dbOrder.broadcast?.contentCategory || "" // broadcast only
        const deliveryFormats = [
          ...(dbOrder.marketing?.deliveryFormats || []),
          ...(dbOrder.broadcast?.deliveryFormats || []),
        ].map((entry: any) => entry?.format).filter(Boolean)
        order.deliveryFormat = [...new Set(deliveryFormats)].join(", ")
        const assignees: string[] = dbOrder.marketing
          ? dbOrder.marketing.assignments.map((assignment: any) => personName(assignment.user))
          : dbOrder.broadcast?.game.assignedUsers.map((assignment: any) => personName(assignment.user)) || []
        order.assignedTo = [...new Set(assignees.filter(Boolean))]
      }
    } catch (error) {
      console.warn(`Could not enrich from the database; reporting available log data only. ${(error as Error).message}`)
    }
  }

  for (const order of orders.values()) {
    order.currentStatus ||= order.deletedAt ? "DELETED" : "PENDING"
    order.priority ||= ""
  }

  // Note: "Source added" = when the source file was added, which is exactly when
  // the order became Ready for Translation (readyAt). Keep Status at index 4 —
  // the status color formatting below relies on that position.
  const orderColumns: Column[] = [
    { header: "Order (click to open)", width: 340 },
    { header: "Created by", width: 160 },
    { header: "Type", width: 100 },
    { header: "Event", width: 90 },
    { header: "Priority", width: 90 },
    { header: "Delivery Format", width: 140 },
    { header: "Status", width: 150 },
    { header: "Late / Early", width: 130 },
    { header: "Content Category", width: 140 },
    { header: "Expected Delivery", width: 230 },
    { header: "Time To Deliver", width: 150 },
    { header: "Deadline (UTC)", width: 170 },
    { header: "Source Added / Ready (UTC)", width: 190 },
    { header: "In Progress (UTC)", width: 175 },
    { header: "Ready → In Progress", width: 140 },
    { header: "Completed (UTC)", width: 175 },
    { header: "Source → Completed", width: 150 },
    { header: "Completed by", width: 160 },
    { header: "Assigned Vendor", width: 150 },
    { header: "Assigned to", width: 220 },
  ]

  const reportSheets: SheetSpec[] = []
  const overviewRows: string[][] = [["Report (CSV)", "In Progress", "Completed", "Delayed"]]

  // One tab per CSV file — the orders that had activity in that window.
  for (const fr of fileReports) {
    const fileOrders = [...fr.orderIds]
      .map((id) => orders.get(id))
      .filter((order): order is OrderReport => !!order && SHOWN_STATUSES.has(order.currentStatus || ""))
    const orderRow = (order: OrderReport): string[] => [
      orderTitleCell(order, siteBase),
      order.createdBy || "",
      nice(order.type),
      nice(order.event),
      nice(order.priority),
      nice(order.deliveryFormat),
      nice(order.currentStatus),
      delayCell(getDelay(order)),
      contentCategoryCell(order.contentCategory),
      deliveryTargetCell(order.contentCategory),
      sourceToDeadlineLabel(order),
      displayDeadline(order.deadline, order.deadlineHasTime),
      utcTimestamp(order.readyAt),
      utcTimestamp(order.inProgressAt),
      durationLabel(order.readyAt, order.inProgressAt),
      utcTimestamp(order.completedAt),
      durationLabel(order.readyAt, order.completedAt),
      order.completedBy || "",
      vendorCell(order.notifyPositions),
      order.assignedTo.join(", "),
    ]
    // Two-level grouping for readability: STATUS section (In Progress, then
    // Completed) → TYPE subsection (Marketing, then Broadcast). Section rows carry
    // a marker in column A ("▸ " status band, "▪ " type band) that the styling
    // step colors. A blank spacer row separates the blocks.
    const blank = () => Array(orderColumns.length).fill("")
    const rows: string[][] = [
      [`Daily Orders Report · ${fr.tab}`],
      orderColumns.map((column) => column.header),
    ]
    for (const status of ["IN_PROGRESS", "COMPLETED"]) {
      const statusGroup = fileOrders.filter((order) => order.currentStatus === status)
      if (statusGroup.length === 0) continue
      // One solid black divider row between status blocks (not before the first).
      if (rows.length > 2) {
        const divider = blank()
        divider[0] = DIVIDER_MARK
        rows.push(divider)
      }

      const statusHeader = blank()
      statusHeader[0] = `▸ ${status.replace(/_/g, " ")} — ${statusGroup.length} order${statusGroup.length === 1 ? "" : "s"}`
      rows.push(statusHeader)

      let firstSubsection = true
      for (const type of ["MARKETING", "BROADCAST"]) {
        const typeGroup = statusGroup
          .filter((order) => (order.type || "").toUpperCase() === type)
          .sort((a, b) => a.title.localeCompare(b.title))
        if (typeGroup.length === 0) continue

        if (!firstSubsection) rows.push(blank()) // one blank between subsections
        firstSubsection = false

        const typeHeader = blank()
        typeHeader[0] = `▪ ${nice(type)} (${typeGroup.length})`
        rows.push(typeHeader)
        for (const order of typeGroup) rows.push(orderRow(order))
      }
    }
    reportSheets.push({ name: fr.tab, columns: orderColumns, rows })
    overviewRows.push([
      fr.tab,
      String(fileOrders.filter((order) => order.currentStatus === "IN_PROGRESS").length),
      String(fileOrders.filter((order) => order.currentStatus === "COMPLETED").length),
      String(fileOrders.filter((order) => { const d = getDelay(order); return d && (d.kind === "late" || d.kind === "overdue") }).length),
    ])
  }

  const delayed = [...orders.values()].filter((order) => { const d = getDelay(order); return d && (d.kind === "late" || d.kind === "overdue") }).length

  if (dryRun) {
    // Overview tab isn't built in a dry run (it needs the live sheet), so tabs
    // here are the per-CSV report tabs only.
    return {
      spreadsheetUrl: "",
      tabs: reportSheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.length })),
      orders: orders.size,
      events: allEvents.length,
      delayed,
    }
  }

  const token = await getGoogleAccessToken(getServiceAccount())

  // Overview accumulates across days: merge this run's rows with the ones already
  // in the sheet, keyed by report (CSV) name. Prior rows for archived CSVs stay;
  // rows for CSVs in this run are refreshed; new CSVs are appended at the bottom.
  const overviewHeader = overviewRows[0]
  const currentByKey = new Map(overviewRows.slice(1).map((row) => [row[0], row]))
  const priorOverview = await fetchOverviewDataRows(token, sheetId)
  const seen = new Set<string>()
  const mergedOverview: string[][] = []
  for (const row of priorOverview) {
    mergedOverview.push(currentByKey.get(row[0]) ?? row)
    seen.add(row[0])
  }
  for (const [key, row] of currentByKey) if (!seen.has(key)) mergedOverview.push(row)
  reportSheets.unshift({
    name: OVERVIEW_TAB,
    columns: [
      { header: "Report (CSV)", width: 260 },
      { header: "In Progress", width: 110 },
      { header: "Completed", width: 110 },
      { header: "Delayed", width: 100 },
    ],
    rows: [["Daily Orders Report · Overview"], overviewHeader, ...mergedOverview],
  })

  const spreadsheet = await publishGoogleSheets(token, sheetId, sheetTitle, reportSheets)
  return {
    spreadsheetUrl: spreadsheet.spreadsheetUrl,
    tabs: reportSheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.length })),
    orders: orders.size,
    events: allEvents.length,
    delayed,
  }
}

/**
 * CLI wrapper: read CSVs from disk / argv, run the report, print a summary. Only
 * runs when this file is executed directly (see the entry guard) — importing the
 * module (e.g. from the /reports endpoint) has no side effects.
 */
async function main() {
  const args = process.argv.slice(2)
  const inputArg = args.find((arg) => !arg.startsWith("--"))
  const dateFilter = findArgument(args, "date")
  const sheetId = findArgument(args, "sheet") || process.env.GOOGLE_SHEETS_SPREADSHEET_ID || ""
  const sheetTitle = findArgument(args, "title") || "EWC Daily Orders Report"
  // Prefer a report-specific / production URL. CLIENT_URL is usually localhost in
  // a dev .env, so it's the LAST fallback — set REPORT_BASE_URL (or SITE_URL) to
  // the real site so order links point to production.
  const siteBase = findArgument(args, "base") || process.env.REPORT_BASE_URL || process.env.SITE_URL || process.env.CLIENT_URL || ""
  const dryRun = args.includes("--dry-run")
  const { files } = gatherCsvFiles(inputArg)
  const inputs = files.map((file) => ({ tabName: tabNameFromFile(file), csvText: readFileSync(file, "utf8") }))

  const result = await runDailyReport(inputs, { sheetId, sheetTitle, siteBase, dateFilter, dryRun })

  console.log(`\n📊 Daily Orders Report (Google Sheets)`)
  console.log(`   Source : ${files.length} file(s) — ${files.map((file) => basename(file)).join(", ")}`)
  console.log(`   Orders : ${result.orders}   Events: ${result.events}   Tabs: ${result.tabs.length}`)
  console.log(`   Delayed orders (incl. ongoing): ${result.delayed}`)
  if (dryRun) {
    console.log("   Dry run: Google Sheets was not contacted.\n")
    return
  }
  console.log(`   Sheet  : ${result.spreadsheetUrl}`)
  console.log(`   Tabs   : ${result.tabs.map((tab) => tab.name).join(", ")}\n`)
}

// Run the CLI only when executed directly (`tsx daily-report-google-sheets.ts`),
// never when imported by the server — an import must have no side effects.
const isCliEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCliEntry) {
  main()
    .catch((error) => { console.error(error); process.exit(1) })
    .finally(async () => {
      try {
        const prisma = (await import("../../src/lib/prisma.js")).prisma
        await prisma.$disconnect().catch(() => {})
      } catch { /* Prisma was unavailable. */ }
    })
}
