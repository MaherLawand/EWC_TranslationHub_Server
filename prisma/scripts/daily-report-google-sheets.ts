/**
 * DAILY ORDERS REPORT → Google Sheets
 * ===================================
 * A Google Sheets version of daily-report.ts. It deliberately leaves the Excel
 * script unchanged.
 *
 * The CSV exports decide which orders belong on each daily tab. The database is
 * the source of truth for each order's current status and status timestamps.
 * There is intentionally no edit history or order-creation timestamp.
 *
 * Usage (from server/):
 *   npx tsx prisma/scripts/daily-report-google-sheets.ts [path] [options]
 *
 * Options:
 *   --sheet=<spreadsheet-id>  Write to an existing Google Sheet. Defaults to
 *                              GOOGLE_SHEETS_SPREADSHEET_ID, or creates one.
 *   --title=<name>            Title used if the script creates a new Sheet.
 *   --date=YYYY-MM-DD         Include one UTC day only.
 *   --base=https://...        Base app URL for clickable order titles.
 *   --dry-run                 Parse and prepare the report without Google API
 *                              credentials or network writes.
 *
 * Required Google service-account environment variables (choose one form):
 *   GOOGLE_SERVICE_ACCOUNT_JSON='{"client_email":"...","private_key":"..."}'
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL=...
 *   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...'
 *
 * Existing Sheets must be shared with the service account as an Editor. This
 * script only owns/rebuilds tabs named "Daily Report - Overview" and
 * "Daily Report - YYYY-MM-DD", leaving every other tab untouched.
 */

import "dotenv/config" // loads server/.env so GOOGLE_* / DATABASE_URL / CLIENT_URL are available
import { createSign } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_LOGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "logs")
const REPORT_TAB_PREFIX = "Daily Report - "
const OVERVIEW_TAB = `${REPORT_TAB_PREFIX}Overview`
const UTC_DAY_MS = 24 * 60 * 60 * 1000
// Report-only rule: the website gives RAW/ASAP a tight ~20-min deadline, but in
// this report a RAW order only counts as "delayed" if it took more than 2 hours
// from source-added (ready) to completion.
const RAW_REPORT_THRESHOLD_MS = 2 * 60 * 60 * 1000

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
type Delay = { hours: number }

type OrderReport = {
  orderId: string
  title: string
  createdBy?: string
  type: string
  event?: string
  priority?: string
  contentCategory?: string
  currentStatus?: string
  readyAt?: string
  inProgressAt?: string
  completedAt?: string
  completedBy?: string
  deadline?: string
  deadlineHasTime?: boolean
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
function contentCategoryCell(value?: string): string {
  if (!value) return ""
  const info = CONTENT_CATEGORY_INFO[value]
  return info ? `${info.label} (expected ${info.hours})` : nice(value)
}

function personName(user: any): string {
  return `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim()
}

/**
 * Mirrors the existing order sidebar: date-only deadlines are due at the end
 * of their UTC day; timed deadlines are compared as exact instants.
 */
function getDelay(order: OrderReport): Delay | null {
  if (!order.completedAt) return null

  // RAW/ASAP is judged against a 2h turnaround from source-added, not its deadline.
  if (order.contentCategory === "RAW") {
    if (!order.readyAt) return null
    const completedMs = new Date(order.completedAt).getTime()
    const readyMs = new Date(order.readyAt).getTime()
    if (Number.isNaN(completedMs) || Number.isNaN(readyMs)) return null
    const overMs = completedMs - readyMs - RAW_REPORT_THRESHOLD_MS
    if (overMs <= 0) return null
    return { hours: overMs / (60 * 60 * 1000) }
  }

  if (!order.deadline) return null
  const completedMs = new Date(order.completedAt).getTime()
  const storedDeadlineMs = new Date(order.deadline).getTime()
  if (Number.isNaN(completedMs) || Number.isNaN(storedDeadlineMs)) return null
  const deadlineMs = order.deadlineHasTime ? storedDeadlineMs : storedDeadlineMs + UTC_DAY_MS - 1
  const delayMs = completedMs - deadlineMs
  if (delayMs <= 0) return null
  return { hours: delayMs / (60 * 60 * 1000) }
}

// Under this many hours the delay is "minor" (light orange); at/above it's a
// bigger delay (red). The ⚠ / ⛔ markers let the sheet color the cell.
const MINOR_DELAY_MAX_HOURS = 1

function delayCell(delay: Delay | null): string {
  if (!delay) return ""
  const totalMin = Math.round(delay.hours * 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  const amount = h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`
  const marker = delay.hours < MINOR_DELAY_MAX_HOURS ? "⚠" : "⛔"
  return `${marker} ${amount} late`
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

function isReportTab(title: string): boolean {
  return title === OVERVIEW_TAB || new RegExp(`^${REPORT_TAB_PREFIX}\\d{4}-\\d{2}-\\d{2}$`).test(title)
}

type ServiceAccount = { client_email: string; private_key: string }

function getServiceAccount(): ServiceAccount {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (json) {
    try {
      const parsed = JSON.parse(json)
      if (parsed.client_email && parsed.private_key) {
        return { client_email: parsed.client_email, private_key: parsed.private_key.replace(/\\n/g, "\n") }
      }
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.")
    }
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  if (email && privateKey) return { client_email: email, private_key: privateKey.replace(/\\n/g, "\n") }

  throw new Error(
    "Missing Google service-account credentials. Set GOOGLE_SERVICE_ACCOUNT_JSON, or both GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY."
  )
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url")
}

async function getGoogleAccessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claim = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }))
  const unsigned = `${header}.${claim}`
  const signer = createSign("RSA-SHA256")
  signer.update(unsigned)
  signer.end()
  const assertion = `${unsigned}.${base64Url(signer.sign(account.private_key))}`

  try {
    const response = await fetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      }
    )
    const body = await response.json() as { access_token?: string; error?: string; error_description?: string }
    if (!response.ok || !body.access_token) throw new Error(body.error_description || body.error || response.statusText)
    return body.access_token
  } catch (error: any) {
    const detail = error?.message
    throw new Error(`Could not authenticate the Google service account: ${detail}`)
  }
}

async function googleRequest<T>(method: "GET" | "POST", path: string, token: string, data?: unknown): Promise<T> {
  try {
    const response = await fetch(`https://sheets.googleapis.com/v4/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const body = await response.json() as T & { error?: { message?: string } }
    if (!response.ok) throw new Error(body.error?.message || response.statusText)
    return body
  } catch (error: any) {
    const detail = error?.message
    throw new Error(`Google Sheets API request failed: ${detail}`)
  }
}

type GoogleSheetInfo = { properties: { sheetId: number; title: string } }
type GoogleSpreadsheet = { spreadsheetId: string; spreadsheetUrl: string; sheets: GoogleSheetInfo[] }

async function createSpreadsheet(token: string, title: string): Promise<GoogleSpreadsheet> {
  return googleRequest<GoogleSpreadsheet>("POST", "spreadsheets", token, {
    properties: { title },
    sheets: [{ properties: { title: OVERVIEW_TAB } }],
  })
}

async function fetchSpreadsheet(token: string, spreadsheetId: string): Promise<GoogleSpreadsheet> {
  return googleRequest<GoogleSpreadsheet>("GET", `spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,spreadsheetUrl,sheets.properties`, token)
}

function sheetIdByName(spreadsheet: GoogleSpreadsheet): Map<string, number> {
  return new Map(spreadsheet.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]))
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

  const desiredNames = new Set(sheets.map((sheet) => sheet.name))
  const existingNames = sheetIdByName(spreadsheet)
  const clearRanges = [...existingNames.keys()].filter(isReportTab).map((name) => `${quoteSheetName(name)}!A:Z`)
  if (clearRanges.length > 0) {
    await googleRequest("POST", `spreadsheets/${encodeURIComponent(spreadsheet.spreadsheetId)}/values:batchClear`, token, { ranges: clearRanges })
  }

  const setupRequests: any[] = []
  for (const [name, sheetId] of existingNames) {
    if (isReportTab(name) && name !== OVERVIEW_TAB && !desiredNames.has(name)) setupRequests.push({ deleteSheet: { sheetId } })
  }
  if (!existingNames.has(OVERVIEW_TAB)) setupRequests.push({ addSheet: { properties: { title: OVERVIEW_TAB } } })
  for (const spec of sheets) {
    if (spec.name !== OVERVIEW_TAB && !existingNames.has(spec.name)) setupRequests.push({ addSheet: { properties: { title: spec.name } } })
  }
  if (setupRequests.length > 0) {
    await googleRequest("POST", `spreadsheets/${encodeURIComponent(spreadsheet.spreadsheetId)}:batchUpdate`, token, { requests: setupRequests })
    spreadsheet = await fetchSpreadsheet(token, spreadsheet.spreadsheetId)
  }

  const ids = sheetIdByName(spreadsheet)
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

    styleRequests.push(
      { unmergeCells: { range: { sheetId } } },
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2, hideGridlines: true } }, fields: "gridProperties.frozenRowCount,gridProperties.hideGridlines" } },
      { mergeCells: { range: titleRange, mergeType: "MERGE_ALL" } },
      { repeatCell: { range: titleRange, cell: { userEnteredFormat: { backgroundColor: headerFill, textFormat: { bold: true, fontSize: 14, foregroundColor: titleText }, verticalAlignment: "MIDDLE", horizontalAlignment: "LEFT" } }, fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment,horizontalAlignment)" } },
      { repeatCell: { range: headerRange, cell: { userEnteredFormat: { backgroundColor: gridColor(55, 65, 81), textFormat: { bold: true, foregroundColor: headerText }, verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" } }, fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)" } },
      { repeatCell: { range: dataRange, cell: { userEnteredFormat: { verticalAlignment: "TOP", wrapStrategy: "WRAP" } }, fields: "userEnteredFormat(verticalAlignment,wrapStrategy)" } },
      { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columnCount } } } },
    )

    // Delay cell: bold + severity color (light orange minor / light red bigger),
    // so it's clearly visible while the order title keeps its link color.
    const delayIndex = spec.columns.findIndex((column) => column.header === "Delay")
    if (delayIndex >= 0) {
      const delayRef = `$${columnLetter(delayIndex)}3`
      const delayCol = { ...dataRange, startColumnIndex: delayIndex, endColumnIndex: delayIndex + 1 }
      styleRequests.push(
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
    }

    spec.columns.forEach((column, index) => {
      styleRequests.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 }, properties: { pixelSize: column.width }, fields: "pixelSize" } })
    })
    styleRequests.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 32 }, fields: "pixelSize" } })
  }

  await googleRequest("POST", `spreadsheets/${encodeURIComponent(spreadsheet.spreadsheetId)}:batchUpdate`, token, { requests: styleRequests })
  return spreadsheet
}

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

  const events: CsvEvent[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const rows = parseCsv(readFileSync(file, "utf8"))
    if (rows.length === 0) continue
    const header = rows[0].map((cell) => cell.trim().toLowerCase())
    const attributesIndex = header.indexOf("attributes")
    const timestampIndex = header.indexOf("timestamp")
    if (attributesIndex === -1) { console.warn(`Skipping ${basename(file)} — no attributes column.`); continue }

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
    }
  }

  if (events.length === 0) {
    console.error(`No order events found${dateFilter ? ` for ${dateFilter}` : ""} in ${files.length} CSV file(s).`)
    process.exit(1)
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts))

  const orders = new Map<string, OrderReport>()
  for (const event of events) {
    const attrs = event.attrs
    const orderId = attrs.orderId || attrs.newId || attrs.deleted?.id || attrs.parentId || ""
    if (!orderId) continue
    const order = getOrder(orders, orderId)
    const date = utcDay(event.ts)
    order.activeDates.add(date)
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
          readyAt: true, inProgressAt: true, completedAt: true,
          createdBy: { select: { firstName: true, lastName: true } },
          completedBy: { select: { firstName: true, lastName: true } },
          marketing: {
            select: {
              deadlineDate: true, deadlineHasTime: true,
              assignments: { select: { user: { select: { firstName: true, lastName: true } } } },
            },
          },
          broadcast: {
            select: {
              deadlineDate: true, deadlineHasTime: true, contentCategory: true,
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
        const details = dbOrder.broadcast || dbOrder.marketing
        order.deadline = details?.deadlineDate?.toISOString()
        order.deadlineHasTime = details?.deadlineHasTime || false
        order.contentCategory = dbOrder.broadcast?.contentCategory || "" // broadcast only
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

  const dates = [...new Set(events.map((event) => utcDay(event.ts)))].sort()
  // Note: "Source added" = when the source file was added, which is exactly when
  // the order became Ready for Translation (readyAt). Keep Status at index 4 —
  // the status color formatting below relies on that position.
  const orderColumns: Column[] = [
    { header: "Order (click to open)", width: 340 },
    { header: "Created by", width: 160 },
    { header: "Type", width: 100 },
    { header: "Event", width: 90 },
    { header: "Priority", width: 90 },
    { header: "Status", width: 150 },
    { header: "Delay", width: 130 },
    { header: "Content Category (expected)", width: 180 },
    { header: "Deadline (UTC)", width: 170 },
    { header: "Source Added / Ready (UTC)", width: 190 },
    { header: "In Progress (UTC)", width: 175 },
    { header: "Ready → In Progress", width: 140 },
    { header: "Completed (UTC)", width: 175 },
    { header: "Source → Completed", width: 150 },
    { header: "Completed by", width: 160 },
    { header: "Assigned to", width: 220 },
    { header: "Deleted by", width: 160 },
    { header: "Deleted (UTC)", width: 175 },
  ]

  const reportSheets: SheetSpec[] = []
  const overviewRows: string[][] = [["Day (UTC)", "Orders active", "Status changes", "Completed", "Deleted", "Completed late"]]

  for (const date of dates) {
    const dayEvents = events.filter((event) => utcDay(event.ts) === date)
    const dayOrders = [...orders.values()]
      .filter((order) => order.activeDates.has(date))
      .sort((a, b) => a.title.localeCompare(b.title))
    const rowData = dayOrders.map((order) => [
      orderTitleCell(order, siteBase),
      order.createdBy || "",
      nice(order.type),
      nice(order.event),
      nice(order.priority),
      nice(order.currentStatus),
      delayCell(getDelay(order)),
      contentCategoryCell(order.contentCategory),
      displayDeadline(order.deadline, order.deadlineHasTime),
      utcTimestamp(order.readyAt),
      utcTimestamp(order.inProgressAt),
      durationLabel(order.readyAt, order.inProgressAt),
      utcTimestamp(order.completedAt),
      durationLabel(order.readyAt, order.completedAt),
      order.completedBy || "",
      order.assignedTo.join(", "),
      order.deletedBy || "",
      utcTimestamp(order.deletedAt),
    ])
    reportSheets.push({
      name: `${REPORT_TAB_PREFIX}${date}`,
      columns: orderColumns,
      rows: [[`Daily Orders Report · ${date} (UTC)`], orderColumns.map((column) => column.header), ...rowData],
    })
    overviewRows.push([
      date,
      String(dayOrders.length),
      String(dayEvents.filter((event) => event.action === "UPDATE_ORDER_STATUS").length),
      String(dayOrders.filter((order) => utcDay(order.completedAt || "") === date).length),
      String(dayOrders.filter((order) => utcDay(order.deletedAt || "") === date).length),
      String(dayOrders.filter((order) => getDelay(order)).length),
    ])
  }

  reportSheets.unshift({
    name: OVERVIEW_TAB,
    columns: [
      { header: "Day (UTC)", width: 135 },
      { header: "Orders active", width: 120 },
      { header: "Status changes", width: 130 },
      { header: "Completed", width: 105 },
      { header: "Deleted", width: 90 },
      { header: "Completed late", width: 125 },
    ],
    rows: [["Daily Orders Report · Overview"], ...overviewRows],
  })

  const delayed = [...orders.values()].filter((order) => getDelay(order)).length
  console.log(`\n📊 Daily Orders Report (Google Sheets)`)
  console.log(`   Source : ${files.length} file(s) — ${files.map((file) => basename(file)).join(", ")}`)
  console.log(`   Orders : ${orders.size}   Events: ${events.length}   Days: ${dates.length}`)
  console.log(`   Delayed completed orders: ${delayed}`)

  if (dryRun) {
    console.log("   Dry run: Google Sheets was not contacted.\n")
    return
  }

  const token = await getGoogleAccessToken(getServiceAccount())
  const spreadsheet = await publishGoogleSheets(token, sheetId, sheetTitle, reportSheets)
  console.log(`   Sheet  : ${spreadsheet.spreadsheetUrl}`)
  console.log(`   Tabs   : ${reportSheets.map((sheet) => sheet.name).join(", ")}\n`)
}

main()
  .catch((error) => { console.error(error); process.exit(1) })
  .finally(async () => {
    try {
      const prisma = (await import("../../src/lib/prisma.js")).prisma
      await prisma.$disconnect().catch(() => {})
    } catch { /* Prisma was unavailable. */ }
  })
