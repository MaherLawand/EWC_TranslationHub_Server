/**
 * DAILY ORDERS REPORT  →  styled Excel (.xlsx)
 * ============================================
 * Turns a Railway logs CSV export into a formatted Excel workbook of everything
 * that happened to ORDERS, with the important facts highlighted:
 *   • who added each order and when
 *   • every edit — what changed, by whom, when
 *   • every status change — from → to, by whom, when
 *   • when it was completed and by whom
 *   • deletions and assignments (who's assigned to what)
 *
 * The Railway logs are the event history. The database (DATABASE_URL) is used
 * only to turn ids into names (users, games) where older logs stored just an id.
 * Newer logs already include the name, so this also works with no DB connection.
 *
 * USAGE (run from the `server/` folder):
 *   npx tsx prisma/scripts/daily-report.ts [path] [options]
 *
 * With NO path it reads every *.csv in `server/logs/` (drop your Railway
 * exports there — one per day, named like logs.1783789145234.csv), merges +
 * de-duplicates them, and writes the report into that same folder.
 * A [path] can be a single CSV file OR a different folder of CSVs.
 *
 * Options:
 *   --date=YYYY-MM-DD   Only include this one day (UTC). Default: every day found.
 *   --out=report.xlsx   Output file path. Default: daily-orders-report-<range>.xlsx next to the input.
 *
 * The workbook has two tabs:
 *   "Orders"       — one row per order: created by/when, edits, status history,
 *                    completed by/when, deleted, assigned-to. Key cells colored.
 *   "Activity Log" — every event in time order, color-coded by action.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import ExcelJS from "exceljs"

// Default drop folder: server/logs (this file lives at server/prisma/scripts/).
const DEFAULT_LOGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "logs")

/** Resolve the input arg into a concrete list of CSV files + a base folder. */
function gatherCsvFiles(inputArg?: string): { files: string[]; baseDir: string } {
  const target = inputArg || DEFAULT_LOGS_DIR
  let st
  try { st = statSync(target) } catch {
    console.error(`Path not found: ${target}`)
    if (!inputArg) console.error(`(Create it and drop your Railway log exports there, e.g. logs.1783789145234.csv)`)
    process.exit(1)
  }
  if (st.isDirectory()) {
    const files = readdirSync(target)
      .filter((f) => /\.csv$/i.test(f))
      .map((f) => join(target, f))
      .sort()
    if (files.length === 0) {
      console.error(`No .csv files in ${target}.\nDrop your Railway log exports there (e.g. logs.1783789145234.csv) and re-run.`)
      process.exit(1)
    }
    return { files, baseDir: target }
  }
  return { files: [target], baseDir: dirname(target) }
}

// prisma is optional — if the DB isn't reachable we still produce the report,
// just with ids instead of names where the log didn't already include a name.
let prisma: any = null
try {
  prisma = (await import("../../src/lib/prisma.js")).prisma
} catch {
  /* no DB — degrade to ids */
}

// ── The order-related actions we care about (everything else is ignored) ─────
const ORDER_ACTIONS = new Set([
  "CREATE_ORDER",
  "CREATE_SUB_ORDERS",
  "DUPLICATE_SUB_ORDER",
  "UPDATE_ORDER",
  "UPDATE_ORDER_STATUS",
  "DELETE_ORDER",
  "ASSIGN_USERS_TO_ORDER",
  "ASSIGN_GAMES_TO_USER",
  "CREATE_FEEDBACK",
])

// ── Colors ───────────────────────────────────────────────────────────────────
const C = {
  headerFill: "FF1F2937",   // dark slate
  headerText: "FFFFFFFF",
  created:    "FFDDEBF7",   // light blue
  completed:  "FFC6EFCE",   // light green
  deletedRow: "FFFCE4E4",   // light red
  // status pills
  COMPLETED:  "FFC6EFCE",
  IN_PROGRESS:"FFBDD7EE",
  READY_FOR_TRANSLATION: "FFD9F2F7",
  PENDING:    "FFFFF2CC",
  DELETED:    "FFF4CCCC",
  // activity-log row tints by action
  actCreated: "FFEAF7EA",
  actEdited:  "FFFFF7E0",
  actStatus:  "FFE9F1FB",
  actDeleted: "FFFCE8E8",
  actOther:   "FFF3EEFA",
} as const

// ── Minimal RFC-4180 CSV parser (attributes column is JSON full of commas). ──
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ",") { row.push(field); field = "" }
      else if (c === "\r") { /* skip */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = "" }
      else field += c
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

const pad = (n: number) => String(n).padStart(2, "0")
function fmtWhen(iso: string): { date: string; time: string; full: string } {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return { date: iso, time: "", full: iso }
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return { date, time, full: `${date} ${time}` }
}
function show(v: any): string {
  if (v === null || v === undefined || v === "") return "(empty)"
  if (Array.isArray(v)) {
    if (v.length === 0) return "(none)"
    // Arrays of objects (e.g. deliveries) would stringify to "[object Object]".
    if (typeof v[0] === "object") return `${v.length} item(s)`
    return v.join(", ")
  }
  if (typeof v === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(v)
    if (m) return v.endsWith("T00:00:00.000Z") ? m[1] : `${m[1]} ${m[2]} UTC`
    return v
  }
  return String(v)
}
const nice = (s: string) => (s ?? "").replace(/_/g, " ").toLowerCase()

// Keep the earliest of two ISO timestamps (ISO strings sort chronologically).
const earlier = (a?: string, b?: string) => (!a ? b : !b ? a : a < b ? a : b)

/** Human duration between two ISO instants, e.g. "5h 23m", "1d 4h", "12m". */
function fmtDuration(fromIso?: string, toIso?: string): string {
  if (!fromIso || !toIso) return ""
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime()
  if (isNaN(ms) || ms < 0) return ""
  const mins = Math.round(ms / 60000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m || parts.length === 0) parts.push(`${m}m`)
  return parts.join(" ")
}

// Friendly, non-technical labels for the raw field names in a diff.
const FIELD_LABEL: Record<string, string> = {
  title: "Title", notes: "Notes", status: "Status", priority: "Priority",
  event: "Event", sourceLanguage: "Source language", targetLanguages: "Target languages",
  deadline: "Deadline", deliveryDate: "Delivery date", estimatedMinutes: "Estimated minutes",
  contentTitle: "Content title", aspectRatios: "Aspect ratios",
  sourceFileLink: "Source file", srtAvailableLink: "SRT link",
  deliveries: "Delivery links", deliveryFormats: "Delivery formats",
}
const LINK_FIELDS = new Set(["sourceFileLink", "srtAvailableLink"])
const NOISY_FIELDS = new Set(["deliveries", "deliveryFormats"])

/** Turn a diffOrders() result into neat, readable, human phrases (one per change). */
function formatChanges(changes: Record<string, any>): string[] {
  const out: string[] = []
  for (const [f, v] of Object.entries(changes || {})) {
    const label = FIELD_LABEL[f] || f
    if (NOISY_FIELDS.has(f)) { out.push(`${label} updated`); continue }
    if (LINK_FIELDS.has(f)) {
      const fromEmpty = !v?.from, toEmpty = !v?.to
      out.push(`${label} ${fromEmpty ? "added" : toEmpty ? "removed" : "changed"}`)
      continue
    }
    if (f === "title") { out.push(`Renamed: "${show(v?.from)}" → "${show(v?.to)}"`); continue }
    out.push(`${label}: ${show(v?.from)} → ${show(v?.to)}`)
  }
  return out
}

// The app URL used to build clickable order links (same shape as the site's
// "copy link"): <base>?page=Broadcast|marketing&orderId=…&event=…
function orderUrl(base: string, o: { orderId: string; type?: string; event?: string }): string {
  if (!base || !o.orderId) return ""
  const page = (o.type || "").toUpperCase() === "MARKETING" ? "marketing" : "Broadcast"
  const root = base.replace(/\/+$/, "")
  return `${root}/?page=${page}&orderId=${encodeURIComponent(o.orderId)}${o.event ? `&event=${encodeURIComponent(o.event)}` : ""}`
}

// ── Aggregated per-order lifecycle ───────────────────────────────────────────
type Edit = { at: string; by: string; changes: string[] }
type StatusChange = { at: string; by: string; from: string; to: string }
type OrderAgg = {
  orderId: string
  title: string
  type: string
  event?: string
  priority?: string
  createdBy?: string
  createdAt?: string
  createdTs?: string      // ISO — for duration math
  duplicated?: boolean
  edits: Edit[]
  statusChanges: StatusChange[]
  sourceReadyTs?: string  // ISO — when a source file first made it ready
  completedTs?: string    // ISO — when it was (last) completed
  completedBy?: string
  completedAt?: string
  currentStatus?: string
  deletedBy?: string
  deletedAt?: string
  assignedTo: string[]
  /** Days (YYYY-MM-DD, UTC) this order had any activity — used to place it on per-day tabs. */
  activeDates: Set<string>
}

async function main() {
  const args = process.argv.slice(2)
  const inputArg = args.find((a) => !a.startsWith("--"))
  const dateFilter = args.find((a) => a.startsWith("--date="))?.slice("--date=".length) || ""
  const outArg = args.find((a) => a.startsWith("--out="))?.slice("--out=".length) || ""

  const { files, baseDir } = gatherCsvFiles(inputArg)

  type Event = { ts: string; action: string; attrs: any }
  const events: Event[] = []
  const userIds = new Set<string>()
  const gameIds = new Set<string>()
  // De-dup across (possibly overlapping) daily exports.
  const seen = new Set<string>()

  for (const file of files) {
    const rows = parseCsv(readFileSync(file, "utf8"))
    if (rows.length === 0) continue
    const header = rows[0].map((h) => h.trim().toLowerCase())
    const attrIdx = header.indexOf("attributes")
    const tsIdx = header.indexOf("timestamp")
    if (attrIdx === -1) { console.warn(`⚠️  Skipping ${basename(file)} — no 'attributes' column.`); continue }

    for (let r = 1; r < rows.length; r++) {
      const attrRaw = rows[r][attrIdx]
      if (!attrRaw) continue
      let attrs: any
      try { attrs = JSON.parse(attrRaw) } catch { continue }
      if (!ORDER_ACTIONS.has(attrs?.action)) continue
      const ts = attrs.ts || (tsIdx >= 0 ? rows[r][tsIdx] : "") || ""
      if (dateFilter && !String(ts).startsWith(dateFilter)) continue
      // Same event can appear in two overlapping exports — key it out.
      const key = `${ts}|${attrs.action}|${attrs.orderId || attrs.newId || attrs.targetUserId || ""}|${attrs.userId || attrs.byUserId || ""}`
      if (seen.has(key)) continue
      seen.add(key)
      events.push({ ts, action: attrs.action, attrs })
      for (const k of ["userId", "byUserId", "targetUserId"]) if (attrs[k]) userIds.add(attrs[k])
      if (Array.isArray(attrs.gameIds)) attrs.gameIds.forEach((g: string) => gameIds.add(g))
    }
  }

  if (events.length === 0) {
    console.error(`No order events found${dateFilter ? ` for ${dateFilter}` : ""} in ${files.length} file(s).`)
    process.exit(1)
  }

  // Resolve ids → names (best-effort).
  const userName = new Map<string, string>()
  const gameName = new Map<string, string>()
  if (prisma) {
    try {
      const users = await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, firstName: true, lastName: true } })
      for (const u of users) userName.set(u.id, `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.id)
      const games = await prisma.game.findMany({ where: { id: { in: [...gameIds] } }, select: { id: true, name: true } })
      for (const g of games) gameName.set(g.id, g.name)
    } catch {
      console.warn("⚠️  Could not reach the database — ids won't be resolved to names.")
    }
  }
  const resolveUser = (id?: string) => (id ? userName.get(id) || `id:${String(id).slice(0, 8)}` : "")
  const who = (a: any, idField = "userId", nameField = "userName") =>
    a[nameField] || resolveUser(a[idField]) || "Unknown"

  events.sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0))

  // ── Aggregate per order + build the flat activity log ──────────────────────
  const orders = new Map<string, OrderAgg>()
  const getOrder = (id: string): OrderAgg => {
    let o = orders.get(id)
    if (!o) { o = { orderId: id, title: "", type: "", edits: [], statusChanges: [], assignedTo: [], activeDates: new Set() }; orders.set(id, o) }
    return o
  }

  type LogRow = { date: string; time: string; action: string; what: string; order: string; actor: string; orderId: string; cat: keyof typeof CAT }
  const CAT = { created: C.actCreated, edited: C.actEdited, status: C.actStatus, deleted: C.actDeleted, other: C.actOther }
  const log: LogRow[] = []

  for (const ev of events) {
    const a = ev.attrs
    const { date, time, full } = fmtWhen(ev.ts)
    const actor = who(a)
    let type = a.type || a.deleted?.type || ""
    let orderTitle = a.title || a.orderTitle || a.deleted?.title || ""
    let orderId = a.orderId || a.newId || a.deleted?.id || ""
    let what = ""
    let action = ""
    let cat: keyof typeof CAT = "other"

    switch (ev.action) {
      case "CREATE_ORDER": {
        action = "Order created"; cat = "created"
        const o = getOrder(orderId)
        o.createdBy = actor; o.createdAt = full; o.createdTs = ev.ts; o.title ||= orderTitle; o.type ||= type
        if (a.priority) o.priority ||= a.priority
        if (a.event) o.event ||= a.event
        what = `${actor} added a new ${nice(type)} order "${orderTitle}"` + (a.event ? ` for ${a.event}` : "") + (a.priority ? ` (priority ${nice(a.priority)})` : "") + "."
        break
      }
      case "DUPLICATE_SUB_ORDER": {
        action = "Sub-order duplicated"; cat = "created"
        const o = getOrder(orderId)
        o.createdBy = actor; o.createdAt = full; o.createdTs = ev.ts; o.title ||= orderTitle; o.type ||= type; o.duplicated = true
        what = `${actor} duplicated a sub-order as "${orderTitle}".`
        break
      }
      case "CREATE_SUB_ORDERS": {
        action = "Sub-orders added"; cat = "created"
        orderTitle = a.parentId ? `(parent ${String(a.parentId).slice(0, 8)})` : orderTitle
        orderId = a.parentId || orderId
        what = `${actor} added ${a.count ?? "some"} sub-order(s) to a big order.`
        break
      }
      case "UPDATE_ORDER": {
        action = "Order edited"; cat = "edited"
        const changes = a.changes && typeof a.changes === "object" ? a.changes : {}
        const parts = formatChanges(changes)
        if (a.sourceChanged && !("sourceFileLink" in changes)) parts.push("source file changed")
        const text = parts.join("; ")
        const o = getOrder(orderId); o.title ||= orderTitle; o.type ||= type
        o.edits.push({ at: full, by: actor, changes: parts.length ? parts : ["(no visible change)"] })
        // Adding/attaching a source file makes the order "ready" — mark the earliest such moment.
        if (a.sourceChanged || "sourceFileLink" in changes) o.sourceReadyTs = earlier(o.sourceReadyTs, ev.ts)
        what = parts.length ? `${actor} edited "${orderTitle}" — ${text}.` : `${actor} edited "${orderTitle}".`
        break
      }
      case "UPDATE_ORDER_STATUS": {
        action = "Status changed"; cat = "status"
        const o = getOrder(orderId); o.title ||= orderTitle; o.type ||= type
        o.statusChanges.push({ at: full, by: actor, from: a.from, to: a.to })
        o.currentStatus = a.to
        // Source-ready timing: entering READY marks source availability; if we only
        // ever see it LEAVING ready (source was added before the logs), fall back to creation.
        if (a.to === "READY_FOR_TRANSLATION") o.sourceReadyTs = earlier(o.sourceReadyTs, ev.ts)
        else if (a.from === "READY_FOR_TRANSLATION" && !o.sourceReadyTs) o.sourceReadyTs = o.createdTs
        if (a.to === "COMPLETED") { o.completedBy = actor; o.completedAt = full; o.completedTs = ev.ts }
        what = `${actor} changed the status of "${orderTitle}" from ${nice(a.from)} to ${nice(a.to)}.`
        break
      }
      case "DELETE_ORDER": {
        action = "Order deleted"; cat = "deleted"
        const d = a.deleted || {}
        const o = getOrder(orderId); o.title = d.title || o.title || orderTitle; o.type ||= d.type || type
        if (d.priority) o.priority ||= d.priority
        if (d.event) o.event ||= d.event
        o.deletedBy = actor; o.deletedAt = full; o.currentStatus = "DELETED"
        what = `${actor} deleted the ${nice(d.type || "")} order "${d.title || orderTitle}"` +
          (d.status ? ` (was ${nice(d.status)})` : "") + (d.game ? `, game ${d.game}` : "") +
          (Array.isArray(d.targetLanguages) && d.targetLanguages.length ? `, target langs: ${d.targetLanguages.join(", ")}` : "") + "."
        break
      }
      case "ASSIGN_USERS_TO_ORDER": {
        action = "Users assigned"; cat = "other"
        const names = Array.isArray(a.userIds) ? a.userIds.map((id: string) => resolveUser(id)) : []
        const o = getOrder(orderId); o.title ||= orderTitle; o.type ||= type
        for (const n of names) if (n && !o.assignedTo.includes(n)) o.assignedTo.push(n)
        what = `${actor} assigned ${a.count ?? ""} user(s)${names.length ? ` (${names.join(", ")})` : ""} to "${orderTitle}".`
        break
      }
      case "ASSIGN_GAMES_TO_USER": {
        action = "Games assigned to user"; cat = "other"
        const target = resolveUser(a.targetUserId) || "a user"
        const games = Array.isArray(a.gameIds) ? a.gameIds.map((id: string) => gameName.get(id) || `id:${String(id).slice(0, 8)}`).join(", ") : ""
        orderTitle = ""; orderId = ""; type = ""
        what = `${who(a, "byUserId")} assigned game(s) [${games}] to ${target}.`
        break
      }
      case "CREATE_FEEDBACK": {
        action = "Feedback added"; cat = "other"
        what = `${actor} left feedback on order "${orderTitle || orderId}".`
        break
      }
    }
    log.push({ date, time, action, what, order: orderTitle, actor, orderId, cat })

    // Mark this order as "active on this day" so it lands on the right per-day tab.
    // (ASSIGN_GAMES_TO_USER clears orderId — it isn't order-specific — so it's skipped.)
    if (orderId) {
      const o = getOrder(orderId)
      o.activeDates.add(date)
      o.title ||= orderTitle
      o.type ||= type
    }
  }

  // ── Enrich from the database ───────────────────────────────────────────────
  // Logs alone don't carry an order's CURRENT status/priority (e.g. an order
  // created but never status-changed has no status in the logs). The DB is the
  // source of truth, so fill those in here.
  const nm = (u: any) => `${u?.firstName ?? ""} ${u?.lastName ?? ""}`.trim()
  if (prisma) {
    try {
      const dbOrders = await prisma.translationOrder.findMany({
        where: { id: { in: [...orders.keys()] } },
        select: {
          id: true, status: true, priority: true, title: true, type: true, event: true, dateAdded: true,
          createdBy: { select: { firstName: true, lastName: true } },
          // Marketing orders are assigned per-order; broadcast orders inherit the
          // translators assigned to their game.
          marketing: { select: { assignments: { select: { user: { select: { firstName: true, lastName: true } } } } } },
          broadcast: { select: { game: { select: { assignedUsers: { select: { user: { select: { firstName: true, lastName: true } } } } } } } },
        },
      })
      for (const d of dbOrders) {
        const o = orders.get(d.id)
        if (!o) continue
        o.title ||= d.title
        o.type ||= d.type
        o.event ||= d.event
        o.priority = o.priority || d.priority
        if (!o.deletedAt) o.currentStatus = d.status // DB is authoritative for live orders
        // Creator from the DB — fills in orders whose CREATE event predates the logs
        // (so no more "before log window").
        if (!o.createdBy && d.createdBy) { o.createdBy = nm(d.createdBy); if (!o.createdAt && d.dateAdded) o.createdAt = fmtWhen(new Date(d.dateAdded).toISOString()).full }
        if (!o.createdTs && d.dateAdded) o.createdTs = new Date(d.dateAdded).toISOString()
        // Assignments straight from the DB (source of truth).
        const names: string[] = d.marketing
          ? (d.marketing.assignments || []).map((a: any) => nm(a.user))
          : (d.broadcast?.game?.assignedUsers || []).map((a: any) => nm(a.user))
        o.assignedTo = [...new Set(names.filter(Boolean))]
      }
    } catch {
      /* DB unreachable — fall back below */
    }
  }
  // Fallbacks for anything still missing (order deleted, or no DB).
  for (const o of orders.values()) {
    if (!o.currentStatus) o.currentStatus = o.deletedAt ? "DELETED" : "PENDING"
    if (!o.priority) o.priority = ""
    if (!o.createdBy) o.createdBy = "(not in database)"
  }

  // ── Build the workbook ─────────────────────────────────────────────────────
  // App base URL for clickable order links (same shape as the site's copy-link).
  const baseArg = args.find((a) => a.startsWith("--base="))?.slice("--base=".length) || ""
  const siteBase = baseArg || process.env.CLIENT_URL || process.env.SITE_URL || ""

  const wb = new ExcelJS.Workbook()
  wb.creator = "EWC Translation Hub — daily report"
  wb.created = new Date()

  const fill = (cell: ExcelJS.Cell, argb: string) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } } }
  const colLetter = (n: number) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }

  // Create a sheet with a professional title banner (row 1) + styled, frozen,
  // filterable header (row 2). Data rows are added from row 3.
  const startSheet = (name: string, title: string, columns: { header: string; key: string; width: number }[]): ExcelJS.Worksheet => {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 2 }] })
    columns.forEach((c, i) => { const col = ws.getColumn(i + 1); col.key = c.key; col.width = c.width })
    const last = colLetter(columns.length)
    // Row 1 — title banner
    ws.mergeCells(`A1:${last}1`)
    const t = ws.getCell("A1")
    t.value = title
    t.font = { bold: true, size: 14, color: { argb: "FFF5D98A" } }
    t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.headerFill } }
    t.alignment = { vertical: "middle", horizontal: "left", indent: 1 }
    ws.getRow(1).height = 28
    // Row 2 — column headers (filter + freeze anchor here)
    const hr = ws.getRow(2)
    columns.forEach((c, i) => { hr.getCell(i + 1).value = c.header })
    hr.height = 22
    hr.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: C.headerText }, size: 11 }
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF374151" } }
      cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true }
    })
    ws.autoFilter = `A2:${last}2`
    return ws
  }

  const ORDER_COLUMNS = [
    { header: "Order (click to open)", key: "title", width: 38 },
    { header: "Type", key: "type", width: 11 },
    { header: "Priority", key: "priority", width: 10 },
    { header: "Status", key: "status", width: 15 },
    { header: "Created by", key: "createdBy", width: 18 },
    { header: "Created (UTC)", key: "createdAt", width: 16 },
    { header: "Completed by", key: "completedBy", width: 18 },
    { header: "Completed (UTC)", key: "completedAt", width: 16 },
    { header: "Time to complete", key: "turnaround", width: 15 },
    { header: "Status history", key: "statusHist", width: 46 },
    { header: "Edit history", key: "editHist", width: 64 },
    { header: "Assigned to", key: "assigned", width: 26 },
    { header: "Deleted by", key: "deletedBy", width: 16 },
    { header: "Deleted (UTC)", key: "deletedAt", width: 16 },
  ]

  // Write one order-lifecycle row (full lifecycle, highlighted, bulleted).
  const addOrderRow = (ws: ExcelJS.Worksheet, o: OrderAgg) => {
    // Bullet points — one per status change / edit; each edit lists its changes
    // as indented sub-bullets so the cell reads like a tidy list.
    const statusHist = o.statusChanges
      .map((s) => `•  ${nice(s.from)} → ${nice(s.to)}   ·   ${s.by}   ·   ${s.at}`)
      .join("\n")
    const editHist = o.edits
      .map((e) => `•  ${e.by}   ·   ${e.at}\n${e.changes.map((c) => `      –  ${c}`).join("\n")}`)
      .join("\n")

    const row = ws.addRow({
      title: o.title || "(unknown)",
      type: nice(o.type),
      priority: o.priority ? nice(o.priority) : "",
      status: o.currentStatus ? nice(o.currentStatus) : "",
      createdBy: o.createdBy || "",
      createdAt: o.createdAt || "",
      completedBy: o.completedBy || "",
      completedAt: o.completedAt || "",
      turnaround: fmtDuration(o.sourceReadyTs, o.completedTs),
      statusHist,
      editHist,
      assigned: o.assignedTo.join(", "),
      deletedBy: o.deletedBy || "",
      deletedAt: o.deletedAt || "",
    })
    row.alignment = { vertical: "top", wrapText: true }

    // Clickable order title → the website (same link as the site's copy button).
    const url = orderUrl(siteBase, o)
    const titleCell = row.getCell("title")
    if (url) {
      titleCell.value = { text: o.title || "(unknown)", hyperlink: url } as any
      titleCell.font = { color: { argb: "FF2563EB" }, underline: true }
    }
    if (o.duplicated) titleCell.note = "Created by duplicating another sub-order"

    fill(row.getCell("createdBy"), C.created)
    fill(row.getCell("createdAt"), C.created)
    const statusKey = (o.currentStatus || "") as keyof typeof C
    if (o.currentStatus && (C as any)[statusKey]) fill(row.getCell("status"), (C as any)[statusKey])
    const p = (o.priority || "").toUpperCase()
    if (p === "HIGH") row.getCell("priority").font = { color: { argb: "FFC00000" }, bold: true }
    else if (p === "LOW") row.getCell("priority").font = { color: { argb: "FF548235" } }
    if (o.completedAt) { fill(row.getCell("completedBy"), C.completed); fill(row.getCell("completedAt"), C.completed) }
    if (o.deletedAt) row.eachCell((c) => fill(c, C.deletedRow))
  }

  const dates = [...new Set(log.map((l) => l.date))].sort()

  // ---- Overview tab (navigation + per-day counts) ----
  const wsOv = startSheet("Overview", "Daily Orders Report  ·  Overview", [
    { header: "Day (UTC)", key: "day", width: 14 },
    { header: "Orders active", key: "orders", width: 14 },
    { header: "Created", key: "created", width: 10 },
    { header: "Edited", key: "edited", width: 10 },
    { header: "Status changes", key: "status", width: 15 },
    { header: "Completed", key: "completed", width: 11 },
    { header: "Deleted", key: "deleted", width: 10 },
  ])

  // ---- One tab per day (orders that had activity that day; full lifecycle) ----
  for (const day of dates) {
    const dayOrders = [...orders.values()]
      .filter((o) => o.activeDates.has(day))
      .sort((a, b) => (a.createdAt || "z").localeCompare(b.createdAt || "z"))

    const ws = startSheet(day, `Daily Orders Report  ·  ${day} (UTC)`, ORDER_COLUMNS)
    for (const o of dayOrders) addOrderRow(ws, o)

    // Overview counts for this day (from the flat activity log).
    const dayRows = log.filter((l) => l.date === day)
    const n = (act: string) => dayRows.filter((r) => r.action === act).length
    wsOv.addRow({
      day,
      orders: dayOrders.length,
      created: n("Order created") + n("Sub-order duplicated"),
      edited: n("Order edited"),
      status: n("Status changed"),
      completed: dayOrders.filter((o) => (o.completedAt || "").startsWith(day)).length,
      deleted: n("Order deleted"),
    })
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  const rangeTag = dateFilter || (dates.length ? `${dates[0]}_to_${dates[dates.length - 1]}` : "report")
  const outPath = outArg || join(baseDir, `daily-orders-report-${rangeTag}.xlsx`)
  await wb.xlsx.writeFile(outPath)

  // ── Console summary ────────────────────────────────────────────────────────
  console.log(`\n📊 Daily Orders Report (Excel)`)
  console.log(`   Source : ${files.length} file(s) — ${files.map((f) => basename(f)).join(", ")}`)
  console.log(`   Orders : ${orders.size}   Events: ${log.length}   Days: ${dates.length}${dateFilter ? ` (filtered to ${dateFilter})` : ""}`)
  console.log(`   Output : ${outPath}\n`)
  for (const day of dates) {
    const dayRows = log.filter((l) => l.date === day)
    const byAction: Record<string, number> = {}
    for (const r of dayRows) byAction[r.action] = (byAction[r.action] || 0) + 1
    console.log(`   ${day} — ${dayRows.length} events: ${Object.entries(byAction).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")}`)
  }
  console.log(`\n✅ One tab per day (named by date) with each order's full lifecycle, plus an "Overview" tab.\n`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(async () => { if (prisma) await prisma.$disconnect().catch(() => {}) })
