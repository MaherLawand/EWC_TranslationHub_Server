// controllers/orders.controller.ts

import type { Response } from "express"

import type {
  AuthRequest,
} from "../middleware/auth.middleware.js"

import { randomUUID } from "node:crypto"
import { prisma } from "../lib/prisma.js"
import { triggerNotifications, getIo } from "../lib/socket.js"
import { notifyTranslatorsSourceReady, notifyTranslatorsOrderDeleted, notifyTranslatorsSourceRemoved } from "./notification.controller.js"
import { logger } from "../lib/logger.js"
import { ordersCache } from "../lib/ordersCache.js"
import { isTranslatorPosition, sanitizeNotifyPositions, orderVisibilityWhere, canSeeOrder, canSeeDeliveryVendor, canSeeAllDeliveryVendors, NOTIFY_POSITION_OPTIONS } from "../lib/positions.js"

/** Normalise a delivery-link vendor tag: a valid vendor role, or "" for shared. */
function sanitizeVendor(input: unknown): string {
  const v = typeof input === "string" ? input.trim() : ""
  return (NOTIFY_POSITION_OPTIONS as readonly string[]).includes(v) ? v : ""
}

/** Strip delivery links the viewer isn't allowed to see, in place on a detail object. */
function filterDeliveryVisibility(detail: any, role?: string | null, position?: string | null): void {
  if (!detail?.deliveries) return
  detail.deliveries = detail.deliveries.filter((d: any) => canSeeDeliveryVendor(d?.vendor, role, position))
}
import {
  Prisma,
  DeliveryFormat,
  ContentCategory,
  OrderStatus,
  OrderPriority,
  OrderType,
  EventType,
  UserRole,
  UserPosition,
  UserDepartment,
} from "@prisma/client"

// Builds a deep-link to an order on the site, matching the client's URL params
// (?page=marketing|Broadcast&orderId=...&event=...). Prefer an explicit public
// site URL; CLIENT_URL is the fallback (may be localhost in dev).
function orderPageLink(type: string, orderId: string, event?: string | null): string {
  const base = process.env.SITE_URL || process.env.REPORT_BASE_URL || process.env.CLIENT_URL || ""
  if (!base || !orderId) return ""
  const root = base.replace(/\/+$/, "")
  const page = String(type).toUpperCase() === "MARKETING" ? "marketing" : "Broadcast"
  return `${root}/?page=${page}&orderId=${encodeURIComponent(orderId)}${event ? `&event=${encodeURIComponent(String(event))}` : ""}`
}

// Shared per-row fields used for both top-level rows and nested sub-orders.
const orderRowFields = {
  id: true,
  type: true,
  title: true,
  status: true,
  priority: true,
  dateAdded: true,
  sourceChangedAt: true,
  isParent: true,
  parentId: true,
  broadcast: {
    select: {
      id: true,
      sourceLanguage: true,
      targetLanguages: true,
      deadlineDate: true,
      deadlineHasTime: true,
      deliveryType: true,
      contentCategory: true,
      deliveryFormats: {
        select: {
          id: true,
          format: true,
        },
      },
      game: {
        select: {
          id: true,
          name: true,
          logo: true,
          tier: true,
          tier1CN: true,
        },
      },
    },
  },
  marketing: {
    select: {
      id: true,
      contentTitle: true,
      sourceLanguage: true,
      targetLanguages: true,
      deadlineDate: true,
      deadlineHasTime: true,
      deliveryFormats: {
        select: {
          id: true,
          format: true,
        },
      },
      assignments: {
        select: {
          id: true,
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              position: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.TranslationOrderSelect

// Sub-orders are rendered with the same shape as top-level rows.
const subOrderSelect = orderRowFields

// Grouped mode (default): top-level rows carry only a sub-order COUNT badge.
// Sub-orders are lazy-fetched on expand via getSubOrders — never eagerly nested.
const listOrderSelectGrouped = {
  ...orderRowFields,
  _count: { select: { subOrders: true, feedback: true } },
  // Lightweight pull of non-completed sub-order deadlines so a collapsed parent
  // can display the NEAREST upcoming sub-order deadline (computed below, then
  // stripped from the response). Avoids the confusion of a parent showing its
  // own far-off deadline while a sub-order is due in hours.
  subOrders: {
    where: { status: { not: OrderStatus.COMPLETED } },
    select: {
      broadcast: { select: { deadlineDate: true, deadlineHasTime: true } },
      marketing: { select: { deadlineDate: true, deadlineHasTime: true } },
    },
  },
} satisfies Prisma.TranslationOrderSelect

// Flat mode (search/filter active): sub-orders appear as their own rows, each
// annotated with a lightweight reference to its parent for the breadcrumb.
const listOrderSelectFlat = {
  ...orderRowFields,
  parent: { select: { id: true, title: true } },
  _count: { select: { feedback: true } },
} satisfies Prisma.TranslationOrderSelect

// Core order fields — no editHistory so this query is leaner.
// Used by getOrderById (parallel fetch) and as the base for orderSelect.
const orderSelectCore = {

  id: true,

  type: true,
  event: true,

  title: true,

  notes: true,

  status: true,

  priority: true,

  dateAdded: true,

  completedAt: true,

  readyAt: true,
  inProgressAt: true,

  lastEditedAt: true,

  sourceChangedAt: true,

  notifyPositions: true,

  _count: { select: { feedback: true } },

  // Sub-order relations
  isParent: true,
  parentId: true,
  parent: {
    select: { id: true, title: true, type: true },
  },
  subOrders: {
    orderBy: { title: "asc" as const },
    select: {
      id: true,
      title: true,
      type: true,
      status: true,
      priority: true,
    },
  },

  createdBy: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      role: true,
      department: true,
      position: true,
    },
  },

  completedBy: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
    },
  },

  lastEditedBy: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
    },
  },

  broadcast: {
    select: {
      id: true,
      gameId: true,
      estimatedMinutes: true,
      sourceLanguage: true,
      targetLanguages: true,
      deliveryFormats: {
        select: {
          id: true,
          format: true,
          deliveryLink: true,
        },
      },
      sourceFileLink: true,
      srtAvailableLink: true,
      deliveryDate: true,
      deadlineDate: true,
      deadlineHasTime: true,
      deliveryType: true,
      contentCategory: true,
      game: {
        select: {
          id: true,
          name: true,
          logo: true,
          tier: true,
          tier1CN: true,
          assignedUsers: {
            select: {
              id: true,
              assignedAt: true,
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  role: true,
                  department: true,
                  position: true,
                  isActive: true,
                },
              },
            },
          },
        },
      },
      deliveries: {
        select: {
          id: true,
          language: true,
          vendor: true,
          deliveryLink: true,
        },
      },
    },
  },

  marketing: {
    select: {
      id: true,
      contentTitle: true,
      aspectRatios: true,
      sourceLanguage: true,
      targetLanguages: true,
      sourceFileLink: true,
      srtAvailableLink: true,
      deadlineDate: true,
      deadlineHasTime: true,
      deliveryFormats: {
        select: {
          id: true,
          format: true,
          deliveryLink: true,
        },
      },
      deliveries: {
        select: {
          id: true,
          language: true,
          vendor: true,
          deliveryLink: true,
        },
      },
      assignments: {
        select: {
          id: true,
          assignedAt: true,
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              position: true,
              department: true,
            },
          },
        },
      },
    },
  },

} satisfies Prisma.TranslationOrderSelect

// Edit history sub-select — shared between the parallel getOrderById fetch
// and the inline orderSelect used by write endpoints.
const editHistorySelect = {
  take: 10,
  orderBy: { editedAt: "desc" as const },
  select: {
    id: true,
    editedAt: true,
    editedBy: {
      select: {
        id: true,
        firstName: true,
        lastName: true,
      },
    },
  },
} as const

// Full select used by write endpoints (updateOrder / updateOrderStatus) that
// need the complete shape returned inline from a transaction.
const orderSelect = {
  ...orderSelectCore,
  editHistory: editHistorySelect,
} satisfies Prisma.TranslationOrderSelect

// ── Audit helpers (for rich logging) ────────────────────────────────────────
// Flatten an order (orderSelect/orderSelectCore shape) into comparable values.
function orderAuditFields(o: any): Record<string, any> {
  if (!o) return {}
  const d = o.type === "BROADCAST" ? o.broadcast : o.marketing
  return {
    title: o.title ?? null,
    notes: o.notes ?? null,
    status: o.status ?? null,
    priority: o.priority ?? null,
    event: o.event ?? null,
    game: o.broadcast?.game?.name ?? o.broadcast?.gameId ?? null,
    contentTitle: o.marketing?.contentTitle ?? null,
    aspectRatios: o.marketing?.aspectRatios ?? null,
    sourceLanguage: d?.sourceLanguage ?? null,
    targetLanguages: d?.targetLanguages ?? null,
    sourceFileLink: d?.sourceFileLink ?? null,
    srtAvailableLink: d?.srtAvailableLink ?? null,
    estimatedMinutes: o.broadcast?.estimatedMinutes ?? null,
    deliveryDate: o.broadcast?.deliveryDate ? new Date(o.broadcast.deliveryDate).toISOString() : null,
    deadline: d?.deadlineDate ? new Date(d.deadlineDate).toISOString() : null,
    deliveryFormats: (d?.deliveryFormats ?? []).map((f: any) => f.format),
    deliveries: (d?.deliveries ?? []).map((x: any) => ({ language: x.language, vendor: x.vendor ?? "", link: x.deliveryLink ?? "" })),
  }
}

// from→to diff between two orders of the same shape; returns only changed fields.
function diffOrders(before: any, after: any): Record<string, { from: any; to: any }> {
  const b = orderAuditFields(before)
  const a = orderAuditFields(after)
  const changes: Record<string, { from: any; to: any }> = {}
  for (const key of Object.keys(a)) {
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      changes[key] = { from: b[key], to: a[key] }
    }
  }
  return changes
}

// Full snapshot of an order's data (for delete logs).
function orderSnapshot(o: any) {
  if (!o) return null
  return {
    id: o.id,
    type: o.type,
    isParent: o.isParent,
    parentId: o.parentId,
    createdBy: o.createdBy ? `${o.createdBy.firstName} ${o.createdBy.lastName}`.trim() : null,
    subOrders: (o.subOrders ?? []).map((s: any) => s.title),
    ...orderAuditFields(o),
  }
}

function isStringArray(
  value: unknown
): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "string"
    )
  )
}

// Parse the gameId query param into a list of ids. Accepts repeated params
// (?gameId=a&gameId=b) OR a single comma-joined value (?gameId=a,b) — the latter
// is how a whole-week filter is sent so orders/counts span every game that week.
function parseGameIds(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : raw != null && raw !== "" ? [raw] : []
  return arr
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim())
    .filter(Boolean)
}

// Build the broadcast game-id where-fragment (single id → equals, many → in),
// merged onto any existing `broadcast.is` constraints.
function gameIdBroadcastWhere(
  gameIds: string[],
  existing: Prisma.TranslationOrderWhereInput["broadcast"]
): Prisma.BroadcastDetailsWhereInput {
  const prevIs =
    existing && typeof existing === "object" && "is" in existing && existing.is
      ? existing.is
      : {}
  if (gameIds.length === 1) return { ...prevIs, gameId: gameIds[0] }
  return { ...prevIs, gameId: { in: gameIds } }
}

function isDeliveryFormat(
  value: unknown
): value is DeliveryFormat {
  return DELIVERY_FORMATS
  .includes(
    value as DeliveryFormat
  )
}

function isOrderStatus(
  value: unknown
): value is OrderStatus {
  return ORDER_STATUSES.includes(
    value as OrderStatus
  )
}

function isEventType(
  value: unknown
): value is EventType {
  return EVENT_TYPES.includes(
    value as EventType
  )
}

function isOrderPriority(
  value: unknown
): value is OrderPriority {
  return ORDER_PRIORITY.includes(
    value as OrderPriority
  )
}

function isOrderType(
  value: unknown
): value is OrderType {
  return ORDER_TYPE.includes(
    value as OrderType
  )
}

type PermissionUser = {
  role: UserRole
  position: UserPosition | null
}

function canManageOrders(
  user: PermissionUser
) {
  return (
    user.role === "ADMIN" ||
    user.position ===
      "PRODUCER" ||
    user.position ===
      "POST_PRODUCTION_MANAGER"
  )
}

function canUpdateStatus(
  user: PermissionUser
) {
  return (
    canManageOrders(user) ||
    isTranslatorPosition(user.position) ||
    user.position === "EDITOR"
  )
}

const EVENT_TYPES =
  Object.values(EventType)

const ORDER_STATUSES =
  Object.values(OrderStatus)

const DELIVERY_FORMATS =
  Object.values(DeliveryFormat)

  const ORDER_PRIORITY =
  Object.values(OrderPriority)

  const ORDER_TYPE =
  Object.values(OrderType)

const CONTENT_CATEGORIES = Object.values(ContentCategory)
function isContentCategory(value: unknown): value is ContentCategory {
  return CONTENT_CATEGORIES.includes(value as ContentCategory)
}


export async function getOrders(
  req: AuthRequest,
  res: Response
) {
  try {

    /*
      PAGINATION
    */

const page = Math.max(
  Number(req.query.page) || 1,
  1
)

const limit = Math.min(
  Math.max(
    Number(req.query.limit) || 50,
    1
  ),
  100
)

    const skip =
      (page - 1) * limit

    /*
      FILTERS
    */

    const search =
      String(
        req.query.search || ""
      )

    if (search.length > 100) {
      return res.status(400).json({
        message: "Search query too long",
      })
    }

const assignedOnly =
  req.query.assignedOnly ===
  "true"

    const status =
      String(
        req.query.status || ""
      )

    const priority =
      String(
        req.query.priority || ""
      )

    const type =
      String(
        req.query.type || ""
      )

      const event =
  String(
    req.query.event || ""
  )

    const formatRaw = req.query.format
    const formatValues = Array.isArray(formatRaw)
      ? formatRaw
      : formatRaw
      ? [String(formatRaw)]
      : []

    // One id (single game) or many (a whole-week filter).
    const gameIds = parseGameIds(req.query.gameId)

    const tier =
      String(
        req.query.tier || ""
      )

    const contentTitle =
      String(
        req.query.contentTitle || ""
      )

    const deadlineSort =
      String(
        req.query.deadlineSort || ""
      )

    const tierSort =
      String(
        req.query.tierSort || ""
      )

    const orderId =
      String(
        req.query.orderId || ""
      )

const [
  firstNameSearch = "",
  lastNameSearch = "",
] = search.split(" ")

    /*
      WHERE
    */

const where: Prisma.TranslationOrderWhereInput = {}

    // Exact ID match — short-circuits all other filters when set
    if (orderId) {
      where.id = orderId
    }
    // NOTE: when no orderId, the grouped/flat decision (whether to restrict to
    // top-level rows via parentId = null) is made below, once parsedFormats is known.

    /*
      SEARCH
    */

    if (search) {

where.OR = [
  {
    title: {
      contains: search,
      mode: "insensitive",
    },
  },

  {
    notes: {
      contains: search,
      mode: "insensitive",
    },
  },

 {
  marketing: {
    is: {
      contentTitle: {
        contains: search,
        mode: "insensitive",
      },
    },
  },
},
{
createdBy: {
  is: {
    firstName: {
      contains: search,
      mode: "insensitive",
    },
  },
},
},
  {
    createdBy: {
      is: {
      lastName: {
        contains: search,
        mode: "insensitive",
      },
    },
    },
  },
]

if (
  firstNameSearch &&
  lastNameSearch
) {
  where.OR.push({
    createdBy: {
      is:{
      AND: [
        {
          firstName: {
            contains:
              firstNameSearch,
            mode:
              "insensitive",
          },
        },

        {
          lastName: {
            contains:
              lastNameSearch,
            mode:
              "insensitive",
          },
        },
      ],
    },
    },
  })
}
    }

// Status is applied later (once grouped/flat is known): grouped keeps parents
// visible if their own status OR any sub-order's status matches.

if(isEventType(event)
){
  where.event = 
  event
}

if (
 isOrderPriority(priority)
) {
  where.priority =
    priority
}

if (
  isOrderType(type)
) {
  where.type =
    type
}



const existingAnd = Array.isArray(
  where.AND
)
  ? where.AND
  : where.AND
    ? [where.AND]
    : []

    
    /*
      FORMAT
    */
    const parsedFormats = formatValues
      .filter(isDeliveryFormat)

    if (parsedFormats.length > 0) {
      where.AND = [
        ...existingAnd,
        {
          OR: [
            {
              broadcast: {
                is: {
                  deliveryFormats: {
                    some: {
                      format: {
                        in: parsedFormats,
                      },
                    },
                  },
                },
              },
            },
            {
              marketing: {
                is: {
                  deliveryFormats: {
                    some: {
                      format: {
                        in: parsedFormats,
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      ]
    }

    /*
      GAME FILTER
    */

if (gameIds.length > 0) {
  where.broadcast = { is: gameIdBroadcastWhere(gameIds, where.broadcast) }
}

/*
  TIER FILTER (Broadcast only) — isolate orders whose game is a given tier.
*/
if (tier) {
  const prevIs =
    where.broadcast &&
    typeof where.broadcast === "object" &&
    "is" in where.broadcast &&
    where.broadcast.is
      ? where.broadcast.is
      : {}
  // "cn" → the extra Tier 1 CN designation; otherwise a numeric tier.
  if (tier === "cn") {
    where.broadcast = { is: { ...prevIs, game: { is: { tier1CN: true } } } }
  } else {
    const tierNum = Number(tier)
    if (!Number.isNaN(tierNum)) {
      where.broadcast = { is: { ...prevIs, game: { is: { tier: tierNum } } } }
    }
  }
}

    /*
      CONTENT TITLE
    */

    if (contentTitle) {

      where.marketing = {
  is: {
    contentTitle: {
      equals: contentTitle,
      mode: "insensitive",
    },
  },
}
    }

    /*
      ORDER BY
    */

    // Default ordering: alphabetical by title (A→Z). The deadline / tier sort
    // buttons below override this when the user activates them.
    let orderBy:
  Prisma.TranslationOrderOrderByWithRelationInput =
{
  title: "asc",
}

    /*
      DEADLINE SORT
    */

    if (deadlineSort === "ASC") {

      orderBy = {
        broadcast: {
          deadlineDate: "asc" as const,
        },
      }
    }

    if (deadlineSort === "DESC") {

      orderBy = {
        broadcast: {
          deadlineDate: "desc" as const,
        },
      }
    }

    /*
      TIER SORT (Broadcast only — sorts by the order's game tier).
      Mutually exclusive with deadline sort on the client, but tier wins here
      if both are somehow present.
    */

    if (tierSort === "ASC") {
      orderBy = {
        broadcast: { game: { tier: "asc" as const } },
      }
    }

    if (tierSort === "DESC") {
      orderBy = {
        broadcast: { game: { tier: "desc" as const } },
      }
    }

    /*
  ASSIGNED ONLY
*/

if (
  assignedOnly &&
  req.userId
) {
  if (type === "MARKETING") {
    // For marketing: filter by user assigned to the order
    where.marketing = {
      is: {
        ...(where.marketing &&
        typeof where.marketing === "object" &&
        "is" in where.marketing &&
        where.marketing.is
          ? where.marketing.is
          : {}),
        assignments: {
          some: {
            userId: req.userId,
          },
        },
      },
    }
  } else {
    // For broadcast: filter by user assigned to the game
    where.broadcast = {
      is: {
        ...(where.broadcast &&
        typeof where.broadcast ===
          "object" &&
        "is" in where.broadcast &&
        where.broadcast.is
          ? where.broadcast.is
          : {}),
        game: {
          assignedUsers: {
            some: {
              userId: req.userId,
            },
          },
        },
      },
    }
  }
}

    /*
      LIST MODE — grouped (default) vs flat (search/filter active)

      Grouped: restrict to top-level rows (parentId = null), each parent carries
               only a sub-order count badge; sub-orders are lazy-fetched on expand.
      Flat:    a narrowing filter/search is active, so drop the parentId = null
               restriction and let matching sub-orders surface as their own rows,
               each annotated with its parent for a breadcrumb.
    */

    // Only a TEXT SEARCH flattens the list (so a matching sub-order surfaces as
    // its own row). Structured filters — including status — keep the grouped,
    // collapsible view so a big order stays visible + expandable.
    const flatten = !!search

    // Only constrain to top-level rows when NOT flattening and not an exact-id lookup.
    if (!orderId && !flatten) {
      where.parentId = null
    }

    // STATUS filter:
    //  • flat (search): match each order's own status.
    //  • grouped: a big order's own status is a rollup we no longer key on — show
    //    a top-level order if its OWN status matches (standalone orders) OR it has
    //    a sub-order in that status (big orders). Below, the parent's sub-order
    //    COUNT + nearest deadline are narrowed to only the matching sub-orders,
    //    and getSubOrders filters the expanded rows the same way.
    const statusActive = isOrderStatus(status)
    if (statusActive) {
      if (flatten) {
        where.status = status as OrderStatus
      } else {
        const statusOr: Prisma.TranslationOrderWhereInput = {
          OR: [
            { status: status as OrderStatus },
            { subOrders: { some: { status: status as OrderStatus } } },
          ],
        }
        const currentAnd = Array.isArray(where.AND)
          ? where.AND
          : where.AND
          ? [where.AND]
          : []
        where.AND = [...currentAnd, statusOr]
      }
    }

    // In grouped mode with an active status filter, narrow the parent's sub-order
    // COUNT badge and the nearest-deadline sub-select to only the matching
    // sub-orders (so a big order under "Pending" reflects just its pending subs).
    const groupedSelect: Prisma.TranslationOrderSelect = statusActive
      ? {
          ...listOrderSelectGrouped,
          _count: {
            select: {
              subOrders: { where: { status: status as OrderStatus } },
              feedback: true,
            },
          },
          subOrders: {
            where: { status: status as OrderStatus },
            select: {
              broadcast: { select: { deadlineDate: true, deadlineHasTime: true } },
              marketing: { select: { deadlineDate: true, deadlineHasTime: true } },
            },
          },
        }
      : listOrderSelectGrouped

    const listSelect = flatten ? listOrderSelectFlat : groupedSelect
    const mode = flatten ? "flat" : "grouped"

    /*
      VISIBILITY — the Notify pills act as an assignment: a translator-side role
      only sees orders whose selection names their role (or that have no
      selection yet). Admins/other positions are unrestricted. Folded into `where`
      BEFORE the cache key is built, so each audience caches separately.
    */
    const visibility = orderVisibilityWhere(req.userRole, req.userPosition)
    if (visibility) {
      const currentAnd = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []
      where.AND = [...currentAnd, visibility]
    }

    /*
      CACHE CHECK
    */

    const cacheKey = `orders:${JSON.stringify({ page, limit, skip, where, orderBy, mode })}:${assignedOnly ? req.userId : "all"}`
    const cached = ordersCache.get(cacheKey)
    if (cached) return res.json(cached)

    /*
      FETCH
    */

    const [
      orders,
      total,
    ] = await Promise.all([

      prisma.translationOrder.findMany({
        where,

        orderBy,

        skip,

        take: limit,

        select: listSelect,
      }),

      prisma.translationOrder.count({
        where,
      }),
    ])

    /*
      NEAREST SUB-ORDER DEADLINE (grouped mode)
      For each parent, surface the soonest non-completed sub-order deadline so
      the collapsed parent row reflects the most urgent work beneath it. Then
      drop the raw subOrders payload (only needed for this computation).
    */
    if (!flatten) {
      for (const o of orders as any[]) {
        if (o.isParent && Array.isArray(o.subOrders)) {
          let nearest: { deadlineDate: Date; deadlineHasTime: boolean } | null = null
          for (const s of o.subOrders) {
            const det = s.broadcast ?? s.marketing
            if (!det?.deadlineDate) continue
            if (!nearest || det.deadlineDate < nearest.deadlineDate) {
              nearest = { deadlineDate: det.deadlineDate, deadlineHasTime: !!det.deadlineHasTime }
            }
          }
          o.nearestSubDeadline = nearest
        }
        delete o.subOrders
      }
    }

    /*
      RESPONSE
    */

    const result = {
      orders,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      mode,
    }

    ordersCache.set(cacheKey, result, 3_000) // 3s TTL

    return res.json(result)

  } catch (error) {

    logger.error({ action: "GET_ORDERS_ERROR", userId: req.userId, userName: req.userName, err: error })

    return res.status(500).json({
      message:
        "Failed to fetch orders",
    })
  }
}
export async function getOrderById(
  req: AuthRequest,
  res: Response
) {
  try {
    const id = String(req.params.id)

    // Run the core order query and edit-history in parallel.
    // Prisma serialises nested-relation sub-queries, so separating
    // editHistory (which requires its own round-trip + a user IN-query)
    // from the main fetch saves ~2 sequential DB round-trips.
    const [order, editHistory] = await Promise.all([
      prisma.translationOrder.findUnique({
        where: { id },
        select: orderSelectCore,
      }),
      prisma.translationOrderEdit.findMany({
        where: { orderId: id },
        ...editHistorySelect,
      }),
    ])

    if (!order) {
      return res.status(404).json({ message: "Order not found" })
    }

    // Assignment-based visibility — a translator-side role can only open an order
    // whose Notify selection names their role (404 so we don't leak existence).
    if (!canSeeOrder(req.userRole, req.userPosition, (order as any).notifyPositions)) {
      return res.status(404).json({ message: "Order not found" })
    }

    // A translator (Translator / TransPerfect / Tarjama) opening the order clears
    // the "source changed" caution (they've seen the update). Managers viewing it —
    // including the one who just made the change — must NOT clear it, or the flag
    // would vanish before translators see it.
    if ((order as any).sourceChangedAt && req.userId) {
      prisma.user
        .findUnique({ where: { id: req.userId }, select: { position: true } })
        .then((u) => {
          if (isTranslatorPosition(u?.position)) {
            return prisma.translationOrder
              .update({ where: { id }, data: { sourceChangedAt: null } })
              .then(() => ordersCache.invalidate())
          }
        })
        .catch(() => {})
    }

    // Hide delivery links belonging to vendors this viewer isn't allowed to see.
    filterDeliveryVisibility((order as any).broadcast, req.userRole, req.userPosition)
    filterDeliveryVisibility((order as any).marketing, req.userRole, req.userPosition)

    return res.json({ ...order, editHistory })
  } catch (error) {
    logger.error({ action: "GET_ORDER_BY_ID_ERROR", userId: req.userId, userName: req.userName, orderId: req.params.id, err: error })
    return res.status(500).json({ message: "Failed to fetch order" })
  }
}

/*
  Recompute a parent order's status from its sub-orders.
  All COMPLETED -> COMPLETED; all PENDING -> PENDING; otherwise IN_PROGRESS.
  A parent with no sub-orders is left untouched.
*/
export async function recomputeParentStatus(
  parentId: string | null | undefined
) {
  if (!parentId) return

  const [parent, subs] = await Promise.all([
    prisma.translationOrder.findUnique({ where: { id: parentId }, select: { status: true } }),
    prisma.translationOrder.findMany({ where: { parentId }, select: { status: true } }),
  ])

  if (subs.length === 0) return undefined

  // Roll the sub-orders up by "most advanced active" state:
  //   all completed → COMPLETED; any in progress → IN_PROGRESS;
  //   else any ready for translation → READY_FOR_TRANSLATION; else PENDING.
  const allCompleted = subs.every((s) => s.status === OrderStatus.COMPLETED)
  const anyInProgress = subs.some((s) => s.status === OrderStatus.IN_PROGRESS)
  const anyReady = subs.some((s) => s.status === OrderStatus.READY_FOR_TRANSLATION)

  const newStatus = allCompleted
    ? OrderStatus.COMPLETED
    : anyInProgress
    ? OrderStatus.IN_PROGRESS
    : anyReady
    ? OrderStatus.READY_FOR_TRANSLATION
    : OrderStatus.PENDING

  // Only stamp a transition timestamp when the parent's status actually CHANGES
  // into that stage (so it isn't reset every time a sub-order updates).
  const changed = parent?.status !== newStatus
  const data: any = { status: newStatus }
  if (newStatus === OrderStatus.COMPLETED) {
    if (changed) data.completedAt = new Date()
  } else {
    data.completedAt = null
    data.completedById = null
  }
  if (changed && newStatus === OrderStatus.READY_FOR_TRANSLATION) data.readyAt = new Date()
  if (changed && newStatus === OrderStatus.IN_PROGRESS) data.inProgressAt = new Date()

  await prisma.translationOrder.update({ where: { id: parentId }, data })

  return newStatus
}

// Soonest non-completed sub-order deadline for a parent (or null if none) — used
// to keep a collapsed parent's displayed deadline fresh after a sub-order's
// status changes. Mirrors the computation in the grouped list query.
export async function nearestSubDeadlineFor(
  parentId: string
): Promise<{ deadlineDate: Date; deadlineHasTime: boolean } | null> {
  const subs = await prisma.translationOrder.findMany({
    where: { parentId, status: { not: OrderStatus.COMPLETED } },
    select: {
      broadcast: { select: { deadlineDate: true, deadlineHasTime: true } },
      marketing: { select: { deadlineDate: true, deadlineHasTime: true } },
    },
  })
  let nearest: { deadlineDate: Date; deadlineHasTime: boolean } | null = null
  for (const s of subs) {
    const det = s.broadcast ?? s.marketing
    if (!det?.deadlineDate) continue
    if (!nearest || det.deadlineDate < nearest.deadlineDate) {
      nearest = { deadlineDate: det.deadlineDate, deadlineHasTime: !!det.deadlineHasTime }
    }
  }
  return nearest
}

/*
  Build the Prisma create-data object for a single order (standalone, parent,
  or sub-order). Shared by createOrder and createSubOrders so the broadcast /
  marketing detail shape stays in one place.

  Leniency: estimatedMinutes / source / target languages default to 0 / []
  when missing, so a "big order" (parent) carrying only shared fields
  (game + deadline) can still be created.
*/
function buildOrderData(
  body: any,
  userId: string,
  // Sub-orders inherit their audience from the parent instead of choosing one,
  // so legacy parents (source file, no saved selection) must not hard-fail.
  opts: { requireNotifyAudience?: boolean } = {}
): { data?: any; error?: string } {
  const { requireNotifyAudience = true } = opts
  const {
    title,
    notes,
    type,
    event,
    status,
    priority,
    game,
    estimatedMinutes,
    sourceLanguage,
    targetLanguages,
    contentTitle,
    aspectRatios,
    deliveryFormats,
    deliveries,
    sourceFileLink,
    srtAvailableLink,
    deliveryDate,
    deadline,
    deliveryType,
    contentCategory,
  } = body

  if (!title?.trim()) {
    return { error: "Title is required" }
  }

  // Broadcast only: Finished (SRT/burned-in) or Raw (SRT). Ignored for marketing.
  const parsedDeliveryType =
    deliveryType === "FINISHED" || deliveryType === "RAW" ? deliveryType : null

  // Broadcast content type (RAW / OPENER / HYPE_PROMO / …). Ignored for marketing.
  const parsedContentCategory = isContentCategory(contentCategory) ? contentCategory : null

  if (deliveryFormats && !Array.isArray(deliveryFormats)) {
    return { error: "Delivery formats must be an array" }
  }

  const srcLang = isStringArray(sourceLanguage) ? sourceLanguage : []
  const tgtLang = isStringArray(targetLanguages) ? targetLanguages : []

  const parsedEstimatedMinutes = Number.isNaN(Number(estimatedMinutes))
    ? 0
    : Number(estimatedMinutes)

  if (deliveryDate && isNaN(new Date(deliveryDate).getTime())) {
    return { error: "Invalid delivery date" }
  }
  if (deadline && isNaN(new Date(deadline).getTime())) {
    return { error: "Invalid deadline date" }
  }

  const orderType: OrderType =
    type === OrderType.MARKETING ? OrderType.MARKETING : OrderType.BROADCAST

  // A deadline string with a time component (full ISO) means a real time-of-day
  // deadline; a bare "YYYY-MM-DD" is date-only. (Marketing only.)
  const deadlineHasTime = typeof deadline === "string" && /T\d{2}:\d{2}/.test(deadline)

  const normalizedGame = typeof game === "string" ? game.trim() : ""

  if (orderType === OrderType.BROADCAST && !normalizedGame) {
    return { error: "Game is required" }
  }

  if (orderType === OrderType.BROADCAST && !parsedContentCategory) {
    return { error: "Content category is required" }
  }

  if (event && !isEventType(event)) {
    return { error: "Invalid event" }
  }

  const parsedDeliveries = Array.isArray(deliveries)
    ? deliveries
        .filter((delivery) => typeof delivery?.language === "string")
        .map((delivery: any) => ({
          language: delivery.language,
          // "" is the shared/"General" vendor. Only the three vendor roles are
          // valid; anything else collapses to General.
          vendor: sanitizeVendor(delivery.vendor),
          deliveryLink: delivery.deliveryLink || "",
        }))
    : []

  const formatsCreate = Array.isArray(deliveryFormats)
    ? deliveryFormats.map((item: any) => ({
        format: isDeliveryFormat(item.format)
          ? item.format
          : DeliveryFormat.SRT,
        deliveryLink: item.deliveryLink || "",
      }))
    : []

  // A source file present at creation → auto-advance from PENDING to
  // READY_FOR_TRANSLATION (an explicitly-set status still wins).
  const resolvedStatus = isOrderStatus(status) ? status : OrderStatus.PENDING
  const hasSourceAtCreate = typeof sourceFileLink === "string" && sourceFileLink.trim() !== ""
  const initialStatus =
    resolvedStatus === OrderStatus.PENDING && hasSourceAtCreate
      ? OrderStatus.READY_FOR_TRANSLATION
      : resolvedStatus

  // Email audience for the source-file notification (pills). Required when a
  // source file is present at creation.
  const notifyPositions = sanitizeNotifyPositions(body.notifyPositions)
  if (requireNotifyAudience && hasSourceAtCreate && notifyPositions.length === 0) {
    return { error: "Select at least one role to notify (Translator, TransPerfect, or Tarjama) when a source file is added" }
  }
  // A source file needs a target language, otherwise no translator can be matched.
  if (hasSourceAtCreate && tgtLang.length === 0) {
    return { error: "At least one target language is required when a source file is added" }
  }

  const data: any = {
    title: title.trim(),

    notes: typeof notes === "string" ? notes.trim() || null : undefined,

    type: orderType,

    event: isEventType(event) ? event : EventType.EWC,

    status: initialStatus,

    // Stamp the entry time for whichever stage it starts in.
    readyAt: initialStatus === OrderStatus.READY_FOR_TRANSLATION ? new Date() : undefined,
    inProgressAt: initialStatus === OrderStatus.IN_PROGRESS ? new Date() : undefined,
    completedAt: initialStatus === OrderStatus.COMPLETED ? new Date() : undefined,

    priority: isOrderPriority(priority) ? priority : OrderPriority.MEDIUM,

    createdById: userId,

    notifyPositions,

    ...(orderType === "BROADCAST"
      ? {
          broadcast: {
            create: {
              estimatedMinutes: parsedEstimatedMinutes,
              sourceLanguage: srcLang,
              targetLanguages: tgtLang,
              deliveryFormats: { create: formatsCreate },
              sourceFileLink: sourceFileLink || "",
              srtAvailableLink:
                typeof srtAvailableLink === "string"
                  ? srtAvailableLink.trim() || null
                  : null,
              deliveryDate: deliveryDate ? new Date(deliveryDate) : new Date(),
              deadlineDate: deadline ? new Date(deadline) : new Date(),
              deadlineHasTime,
              deliveryType: parsedDeliveryType,
              contentCategory: parsedContentCategory,
              deliveries: { create: parsedDeliveries },
              game: { connect: { id: normalizedGame } },
            },
          },
        }
      : {
          marketing: {
            create: {
              contentTitle:
                typeof contentTitle === "string"
                  ? contentTitle.trim() || null
                  : undefined,
              aspectRatios: isStringArray(aspectRatios) ? aspectRatios : [],
              sourceLanguage: srcLang,
              targetLanguages: tgtLang,
              sourceFileLink:
                typeof sourceFileLink === "string" ? sourceFileLink : undefined,
              srtAvailableLink:
                typeof srtAvailableLink === "string"
                  ? srtAvailableLink.trim() || null
                  : null,
              deadlineDate: deadline ? new Date(deadline) : null,
              deadlineHasTime,
              deliveryFormats: { create: formatsCreate },
              deliveries: { create: parsedDeliveries },
            },
          },
        }),
  }

  return { data }
}

export async function createOrder(
  req: AuthRequest,
  res: Response
) {
  try {

    if (!req.userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    /*
      USER
    */

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, role: true, position: true },
    })

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    /*
      PERMISSIONS
    */

    if (!canManageOrders(user)) {
      return res.status(403).json({ message: "Unauthorized" })
    }

    /*
      SUB-ORDER FLAGS
    */

    const isParent = req.body.isParent === true
    const parentId =
      typeof req.body.parentId === "string" && req.body.parentId.trim()
        ? req.body.parentId.trim()
        : null

    /*
      BUILD + CREATE
    */

    const built = buildOrderData(req.body, user.id)
    if (built.error || !built.data) {
      return res
        .status(400)
        .json({ message: built.error || "Invalid order data" })
    }

    const order = await prisma.translationOrder.create({
      data: {
        ...built.data,
        isParent,
        parentId,
      },
      select: orderSelect,
    })

    /*
      NOTIFICATIONS
    */

    if (req.body.sourceFileLink) {
      notifyTranslatorsSourceReady(order.id).catch((e) =>
        logger.error({ action: "NOTIFY_TRANSLATORS_ERROR", orderId: order.id, err: e })
      )
    }

    // Adding a sub-order may change the parent's rolled-up status.
    if (parentId) {
      await recomputeParentStatus(parentId)
    }

    logger.info({ action: "CREATE_ORDER", userId: req.userId, userName: req.userName, orderId: order.id, type: order.type, title: order.title, event: order.event, priority: order.priority })

    ordersCache.invalidate()
    try { getIo()?.emit("order-created", { type: order.type }) } catch {}
    return res.json(order)

  } catch (error) {

    logger.error({ action: "CREATE_ORDER_ERROR", userId: req.userId, userName: req.userName, err: error })

    return res.status(500).json({
      message:
        "Failed to create order",
    })
  }
}

/*
  Bulk-create sub-orders under an existing parent ("big order").
  Body: { items: [...] } or a raw array. Created atomically; parent status
  is recomputed once and a single socket event is emitted.
*/
export async function createSubOrders(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    const parentId = String(req.params.id)
    const items = Array.isArray(req.body?.items) ? req.body.items : req.body

    if (!Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ message: "Sub-orders must be a non-empty array" })
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, role: true, position: true },
    })

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    if (!canManageOrders(user)) {
      return res.status(403).json({ message: "Unauthorized" })
    }

    const parent = await prisma.translationOrder.findUnique({
      where: { id: parentId },
      select: { id: true, isParent: true, type: true, event: true, notifyPositions: true },
    })

    if (!parent) {
      return res.status(404).json({ message: "Parent order not found" })
    }

    /*
      Sub-orders inherit type/event from the parent unless explicitly provided.

      Instead of issuing one nested `create` per sub-order (each of which
      expands into several sequential INSERTs — order + detail + N deliveries +
      M formats — that add up to dozens of round-trips over the network), we
      pre-generate the row ids and flatten everything into a handful of bulk
      `createMany` calls. The whole thing runs in a single transaction, turning
      ~N×5 statements into ~5 statements total regardless of how many
      sub-orders are added.
    */
    const orderRows: any[] = []
    const broadcastRows: any[] = []
    const marketingRows: any[] = []
    const broadcastDeliveryRows: any[] = []
    const marketingDeliveryRows: any[] = []
    const broadcastFormatRows: any[] = []
    const marketingFormatRows: any[] = []

    for (const item of items) {
      const merged = {
        ...item,
        type: item?.type ?? parent.type,
        event: item?.event ?? parent.event,
        // Sub-orders inherit the parent's notify audience when none was sent
        // (the sidebar's Add Sub-Order panel has no pills).
        notifyPositions: sanitizeNotifyPositions(item?.notifyPositions).length
          ? item.notifyPositions
          : parent.notifyPositions,
      }
      // Inherited audience — don't reject a legacy parent that has a source file
      // but no saved selection.
      const built = buildOrderData(merged, user.id, { requireNotifyAudience: false })
      if (built.error || !built.data) {
        return res
          .status(400)
          .json({ message: built.error || "Invalid sub-order data" })
      }

      const d = built.data
      const orderId = randomUUID()

      orderRows.push({
        id: orderId,
        title: d.title,
        notes: d.notes ?? null,
        type: d.type,
        event: d.event,
        status: d.status,
        readyAt: d.readyAt ?? null,
        inProgressAt: d.inProgressAt ?? null,
        completedAt: d.completedAt ?? null,
        priority: d.priority,
        createdById: d.createdById,
        notifyPositions: d.notifyPositions ?? [],
        isParent: false,
        parentId,
      })

      if (d.broadcast) {
        const b = d.broadcast.create
        const broadcastId = randomUUID()
        broadcastRows.push({
          id: broadcastId,
          orderId,
          gameId: b.game.connect.id,
          estimatedMinutes: b.estimatedMinutes,
          sourceLanguage: b.sourceLanguage,
          targetLanguages: b.targetLanguages,
          sourceFileLink: b.sourceFileLink,
          srtAvailableLink: b.srtAvailableLink,
          deliveryDate: b.deliveryDate,
          deadlineDate: b.deadlineDate,
          deadlineHasTime: b.deadlineHasTime,
          deliveryType: b.deliveryType,
          contentCategory: b.contentCategory,
        })
        for (const dl of b.deliveries.create) {
          broadcastDeliveryRows.push({
            broadcastId,
            language: dl.language,
            deliveryLink: dl.deliveryLink,
          })
        }
        for (const f of b.deliveryFormats.create) {
          broadcastFormatRows.push({
            broadcastId,
            format: f.format,
            deliveryLink: f.deliveryLink,
          })
        }
      } else if (d.marketing) {
        const m = d.marketing.create
        const marketingId = randomUUID()
        marketingRows.push({
          id: marketingId,
          orderId,
          contentTitle: m.contentTitle ?? null,
          sourceLanguage: m.sourceLanguage,
          targetLanguages: m.targetLanguages,
          sourceFileLink: m.sourceFileLink ?? null,
          srtAvailableLink: m.srtAvailableLink,
          deadlineDate: m.deadlineDate,
          deadlineHasTime: m.deadlineHasTime,
        })
        for (const dl of m.deliveries.create) {
          marketingDeliveryRows.push({
            marketingId,
            language: dl.language,
            deliveryLink: dl.deliveryLink,
          })
        }
        for (const f of m.deliveryFormats.create) {
          marketingFormatRows.push({
            marketingId,
            format: f.format,
            deliveryLink: f.deliveryLink,
          })
        }
      }
    }

    await prisma.$transaction([
      ...(parent.isParent
        ? []
        : [
            prisma.translationOrder.update({
              where: { id: parentId },
              data: { isParent: true },
            }),
          ]),
      prisma.translationOrder.createMany({ data: orderRows }),
      ...(broadcastRows.length
        ? [prisma.broadcastDetails.createMany({ data: broadcastRows })]
        : []),
      ...(marketingRows.length
        ? [prisma.marketingDetails.createMany({ data: marketingRows })]
        : []),
      ...(broadcastDeliveryRows.length
        ? [prisma.broadcastDelivery.createMany({ data: broadcastDeliveryRows })]
        : []),
      ...(broadcastFormatRows.length
        ? [prisma.broadcastDeliveryFormat.createMany({ data: broadcastFormatRows })]
        : []),
      ...(marketingDeliveryRows.length
        ? [prisma.marketingDelivery.createMany({ data: marketingDeliveryRows })]
        : []),
      ...(marketingFormatRows.length
        ? [prisma.marketingDeliveryFormat.createMany({ data: marketingFormatRows })]
        : []),
    ])

    const builts = orderRows

    await recomputeParentStatus(parentId)

    const updatedParent = await prisma.translationOrder.findUnique({
      where: { id: parentId },
      select: listOrderSelectGrouped,
    })

    logger.info({ action: "CREATE_SUB_ORDERS", userId: req.userId, userName: req.userName, parentId, count: builts.length })

    ordersCache.invalidate()
    try { getIo()?.emit("order-created", { type: parent.type }) } catch {}

    return res.json(updatedParent)
  } catch (error) {
    logger.error({ action: "CREATE_SUB_ORDERS_ERROR", userId: req.userId, userName: req.userName, parentId: req.params.id, err: error })
    return res.status(500).json({ message: "Failed to create sub-orders" })
  }
}

/*
  DUPLICATE SUB-ORDER — instantly copy a sub-order into the same parent with an
  auto-incremented title. Copies every field (languages, formats, deliveries,
  deadline + time, delivery type). Recomputes the parent afterwards.
*/
export async function duplicateOrder(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, role: true, position: true },
    })
    if (!user) return res.status(404).json({ message: "User not found" })
    if (!canManageOrders(user)) return res.status(403).json({ message: "Unauthorized" })

    const sourceId = String(req.params.id)
    const source = await prisma.translationOrder.findUnique({
      where: { id: sourceId },
      select: {
        id: true, title: true, notes: true, type: true, event: true, status: true, priority: true, parentId: true, notifyPositions: true,
        broadcast: {
          select: {
            estimatedMinutes: true, sourceLanguage: true, targetLanguages: true,
            sourceFileLink: true, srtAvailableLink: true, deliveryDate: true,
            deadlineDate: true, deadlineHasTime: true, deliveryType: true, contentCategory: true, gameId: true,
            deliveries: { select: { language: true, vendor: true, deliveryLink: true } },
            deliveryFormats: { select: { format: true, deliveryLink: true } },
          },
        },
        marketing: {
          select: {
            contentTitle: true, aspectRatios: true, sourceLanguage: true, targetLanguages: true,
            sourceFileLink: true, srtAvailableLink: true, deadlineDate: true, deadlineHasTime: true,
            deliveries: { select: { language: true, vendor: true, deliveryLink: true } },
            deliveryFormats: { select: { format: true, deliveryLink: true } },
          },
        },
      },
    })
    if (!source) return res.status(404).json({ message: "Order not found" })
    if (!source.parentId) {
      return res.status(400).json({ message: "Only sub-orders can be duplicated this way" })
    }

    // Next title: "<prefix> <max sibling number + 1>", based on the source's
    // trailing number (or the whole title if it has none).
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const tm = source.title.match(/^(.*?)(\d+)\s*$/)
    const prefix = (tm ? tm[1] : source.title).trim()
    const siblings = await prisma.translationOrder.findMany({
      where: { parentId: source.parentId },
      select: { title: true },
    })
    const numRe = new RegExp(`^${escapeRe(prefix)}\\s*(\\d+)\\s*$`)
    let max = 0
    for (const s of siblings) {
      const mm = s.title.match(numRe)
      if (mm) max = Math.max(max, Number(mm[1]))
    }
    const newTitle = prefix ? `${prefix} ${max + 1}` : `${max + 1}`

    // A duplicate starts fresh — never inherit the source's status (which may be
    // Completed): Ready for Translation when it has a source file, else Pending.
    const dupSourceLink = (source.broadcast?.sourceFileLink ?? source.marketing?.sourceFileLink ?? "").trim()
    const dupStatus = dupSourceLink
      ? OrderStatus.READY_FOR_TRANSLATION
      : OrderStatus.PENDING

    const data: any = {
      title: newTitle,
      notes: source.notes ?? null,
      type: source.type,
      event: source.event,
      status: dupStatus,
      priority: source.priority,
      createdById: user.id,
      notifyPositions: source.notifyPositions ?? [],
      isParent: false,
      parentId: source.parentId,
    }
    if (source.broadcast) {
      const b = source.broadcast
      // Derive delivery type + formats the same way the modal duplicate does, so
      // legacy sub-orders (no saved type) come out consistent:
      //   Burned In (± SRT) → Finished (ensure SRT); only SRT → Raw; none → Finished + SRT.
      const srtItem = b.deliveryFormats.find((f) => f.format === "SRT") || { format: "SRT" as const, deliveryLink: null as string | null }
      const burnedItem = b.deliveryFormats.find((f) => f.format === "BURNED_IN") || { format: "BURNED_IN" as const, deliveryLink: null as string | null }
      const hasSRT = b.deliveryFormats.some((f) => f.format === "SRT")
      const hasBurned = b.deliveryFormats.some((f) => f.format === "BURNED_IN")
      let dType = b.deliveryType as "FINISHED" | "RAW" | null
      let formats: { format: any; deliveryLink: string | null }[] = b.deliveryFormats
      if (dType) {
        if (dType === "RAW") formats = [srtItem]
      } else if (hasBurned) {
        dType = "FINISHED"
        formats = [burnedItem, srtItem]
      } else if (hasSRT) {
        dType = "RAW"
        formats = [srtItem]
      } else {
        dType = "FINISHED"
        formats = [srtItem]
      }

      data.broadcast = {
        create: {
          estimatedMinutes: b.estimatedMinutes,
          sourceLanguage: b.sourceLanguage,
          targetLanguages: b.targetLanguages,
          sourceFileLink: b.sourceFileLink,
          srtAvailableLink: b.srtAvailableLink,
          deliveryDate: b.deliveryDate,
          deadlineDate: b.deadlineDate,
          deadlineHasTime: b.deadlineHasTime,
          deliveryType: dType,
          contentCategory: b.contentCategory,
          game: { connect: { id: b.gameId } },
          deliveries: { create: b.deliveries.map((d) => ({ language: d.language, vendor: d.vendor, deliveryLink: d.deliveryLink })) },
          deliveryFormats: { create: formats.map((f) => ({ format: f.format, deliveryLink: f.deliveryLink })) },
        },
      }
    } else if (source.marketing) {
      const m = source.marketing
      data.marketing = {
        create: {
          contentTitle: m.contentTitle,
          aspectRatios: m.aspectRatios,
          sourceLanguage: m.sourceLanguage,
          targetLanguages: m.targetLanguages,
          sourceFileLink: m.sourceFileLink,
          srtAvailableLink: m.srtAvailableLink,
          deadlineDate: m.deadlineDate,
          deadlineHasTime: m.deadlineHasTime,
          deliveries: { create: m.deliveries.map((d) => ({ language: d.language, vendor: d.vendor, deliveryLink: d.deliveryLink })) },
          deliveryFormats: { create: m.deliveryFormats.map((f) => ({ format: f.format, deliveryLink: f.deliveryLink })) },
        },
      }
    }

    const created = await prisma.translationOrder.create({ data, select: orderRowFields })

    logger.info({ action: "DUPLICATE_SUB_ORDER", userId: req.userId, userName: req.userName, sourceId, parentId: source.parentId, newId: created.id, title: newTitle })

    // Roll the new sub-order into the parent (status + nearest deadline) and
    // refresh lists.
    const pid = source.parentId
    const parentStatus = await recomputeParentStatus(pid)
    const nearestSubDeadline = await nearestSubDeadlineFor(pid)
    ordersCache.invalidate()
    // Only patch the parent row (status + nearest deadline). We deliberately do
    // NOT emit "order-created" — that refetches the top-level list back to page 1.
    // The acting client reloads the expanded parent's sub-orders itself.
    try { getIo()?.emit("order-patched", { id: pid, type: source.type, status: parentStatus, nearestSubDeadline }) } catch {}

    return res.json(created)
  } catch (error) {
    logger.error({ action: "DUPLICATE_SUB_ORDER_ERROR", userId: req.userId, userName: req.userName, sourceId: req.params.id, err: error })
    return res.status(500).json({ message: "Failed to duplicate sub-order" })
  }
}

/*
  GET SUB-ORDERS — lazy-loaded when a big-order parent row is expanded.
  Paginated; rows use the same shape as top-level list rows (orderRowFields).
*/
export async function getSubOrders(
  req: AuthRequest,
  res: Response
) {
  try {
    const parentId = String(req.params.id)

    const page = Math.max(Number(req.query.page) || 1, 1)
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
    const skip = (page - 1) * limit

    // Mirror the grouped list's status filter: when a status is active, an
    // expanded big order shows only its sub-orders in that status.
    const status = String(req.query.status || "")
    const where: Prisma.TranslationOrderWhereInput = { parentId }
    if (isOrderStatus(status)) where.status = status

    // Same assignment-based visibility as the top-level list.
    const visibility = orderVisibilityWhere(req.userRole, req.userPosition)
    if (visibility) where.AND = [visibility]

    // Cache per audience — otherwise one role's rows would be served to another.
    const cacheKey = `sub-orders:${parentId}:${page}:${limit}:${isOrderStatus(status) ? status : "all"}:${visibility ? req.userPosition : "all"}`
    const cached = ordersCache.get(cacheKey)
    if (cached) return res.json(cached)

    const [subOrders, total] = await Promise.all([
      prisma.translationOrder.findMany({
        where,
        orderBy: { title: "asc" },
        skip,
        take: limit,
        select: orderRowFields,
      }),
      prisma.translationOrder.count({ where }),
    ])

    const result = {
      subOrders,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    }

    ordersCache.set(cacheKey, result, 3_000) // 3s TTL; invalidated on every write

    return res.json(result)
  } catch (error) {
    logger.error({ action: "GET_SUB_ORDERS_ERROR", userId: req.userId, userName: req.userName, parentId: req.params.id, err: error })
    return res.status(500).json({ message: "Failed to fetch sub-orders" })
  }
}

export async function updateOrder(
  req: AuthRequest,
  res: Response
) {
  try {

    const orderId = String(
      req.params.id
    )

    /*
      AUTH
    */

    if (!req.userId) {
      return res.status(401).json({
        message: "Unauthorized",
      })
    }

    /*
      USER + EXISTING ORDER — fetched in parallel (independent queries)
    */

    const [user, existingOrder] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.userId },
        select: { id: true, role: true, position: true },
      }),
      prisma.translationOrder.findUnique({
        where: { id: orderId },
        // Full shape so we can log an exact from→to diff after the update.
        select: orderSelectCore,
      }),
    ])

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      })
    }

    /*
      PERMISSIONS — managers/admin get a full edit. A VIDEO_EDITOR may edit ONLY
      the source file link and delivery links; every other field is stripped from
      the body here (server-enforced), so the normal update logic below can only
      touch those two — while still running the source-added/removed + READY
      status handling.
    */

    const isManager = canManageOrders(user)
    const isVideoEditor = user.position === "VIDEO_EDITOR"
    if (!isManager && !isVideoEditor) {
      return res.status(403).json({
        message: "Unauthorized",
      })
    }

    if (isVideoEditor && !isManager) {
      req.body = {
        type: req.body.type,
        sourceFileLink: req.body.sourceFileLink,
        srtAvailableLink: req.body.srtAvailableLink,
        deliveries: req.body.deliveries,
        notifyPositions: req.body.notifyPositions,
        clientLastEditedAt: req.body.clientLastEditedAt,
      }
    }

    const {
      title,
      notes,
      status,
      priority,
      type,
      event,
      game,
      estimatedMinutes,
      sourceLanguage,
      targetLanguages,
      contentTitle,
      aspectRatios,
      deliveryFormats,
      sourceFileLink,
      srtAvailableLink,
      deliveryDate,
      deadline,
      deliveries,
      deliveryType,
      contentCategory,
      clientLastEditedAt, // ISO string | null | undefined — optimistic concurrency token
    } = req.body

    if (!existingOrder) {
      return res.status(404).json({
        message:
          "Order not found",
      })
    }
if (typeof req.body.type !== "string") {
  return res.status(400).json({
    message: "Order type is required",
  })
}

if (
  existingOrder.type.toUpperCase() !==
  req.body.type.toUpperCase()
) {
  return res.status(400).json({
    message: "Order type cannot be changed",
  })
}

    /*
      NOTIFY AUDIENCE (pills) — required whenever the order ends up with a source
      file. If the request omits notifyPositions, keep the existing selection.
    */
    const notifyPositionsProvided = req.body.notifyPositions !== undefined
    const parsedNotifyPositions = notifyPositionsProvided
      ? sanitizeNotifyPositions(req.body.notifyPositions)
      : sanitizeNotifyPositions((existingOrder as any).notifyPositions)
    const existingSourceLink =
      existingOrder.type === "BROADCAST"
        ? existingOrder.broadcast?.sourceFileLink
        : existingOrder.marketing?.sourceFileLink
    const finalSourceLink =
      typeof sourceFileLink === "string" ? sourceFileLink : (existingSourceLink || "")
    if (finalSourceLink.trim() && parsedNotifyPositions.length === 0) {
      return res.status(400).json({
        message: "Select at least one role to notify (Translator, TransPerfect, or Tarjama) when a source file is added",
      })
    }
    // A source file needs a target language, otherwise no translator can be matched.
    const existingTargets =
      existingOrder.type === "BROADCAST"
        ? existingOrder.broadcast?.targetLanguages
        : existingOrder.marketing?.targetLanguages
    const finalTargets = Array.isArray(targetLanguages) ? targetLanguages : (existingTargets || [])
    if (finalSourceLink.trim() && finalTargets.length === 0) {
      return res.status(400).json({
        message: "At least one target language is required when a source file is added",
      })
    }

    /*
      ORDER TYPE
    */

const orderType: OrderType =
  isOrderType(type)
    ? type
    : existingOrder.type

const normalizedGame =
  typeof game === "string"
    ? game.trim()
    : undefined

if (
  orderType === OrderType.BROADCAST &&
  game !== undefined &&
  !normalizedGame
) {
  return res.status(400).json({
    message: "Game is required",
  })
}

if (
  event &&
  !isEventType(event)
) {
  return res.status(400).json({
    message: "Invalid event",
  })
}

let parsedEstimatedMinutes:
  number | undefined

if (
  estimatedMinutes !== undefined
) {
  parsedEstimatedMinutes =
    Number(estimatedMinutes)

  if (
    Number.isNaN(
      parsedEstimatedMinutes
    )
  ) {
    return res.status(400).json({
      message:
        "Estimated minutes must be a number",
    })
  }
}

    if (deliveryDate && isNaN(new Date(deliveryDate).getTime())) {
      return res.status(400).json({ message: "Invalid delivery date" })
    }
    if (deadline && isNaN(new Date(deadline).getTime())) {
      return res.status(400).json({ message: "Invalid deadline date" })
    }

    /*
      UPDATE ORDER
    */
let updatedOrder: any
try {
  updatedOrder = await prisma.$transaction(async (tx) => {

    // OPTIMISTIC CONCURRENCY — if the client sent a lastEditedAt token,
    // verify it still matches the DB before writing. Mismatches mean
    // another user saved between when this user opened the modal and
    // submitted, so we abort with a conflict signal rather than silently
    // overwriting their work.
    if (clientLastEditedAt !== undefined) {
      const current = await tx.translationOrder.findUnique({
        where: { id: orderId },
        select: { lastEditedAt: true },
      })
      const clientTs = clientLastEditedAt ? new Date(clientLastEditedAt).getTime() : null
      const serverTs = current?.lastEditedAt?.getTime() ?? null
      if (clientTs !== serverTs) {
        throw { __conflict: true }
      }
    }

  await tx.translationOrder.update({
      where: {
        id: orderId,
      },

      data: {
       ...(typeof title === "string" && title.trim()
    ? {
        title: title.trim(),
      }
    : {}),
  ...(typeof notes === "string"
    ? {
        notes:
          notes.trim() || null,
      }
    : {}),

        ...(isOrderStatus(status) && !existingOrder.isParent
  ? { status }
  : {}),

...(isOrderPriority(priority)
? {priority}
: {}),

...(isEventType(event)
  ? { event }
  : {}),

        // Persist the notify-audience pills when the request includes them.
        ...(notifyPositionsProvided ? { notifyPositions: parsedNotifyPositions } : {}),

        type: orderType,

        lastEditedBy: {
  connect: {
    id: user.id,
  },
},

        lastEditedAt:
          new Date(),

        editHistory: {
          create: {
            editedById:
              user.id,
          },
        },

        ...(orderType ===
        "BROADCAST"
          ? {
            broadcast: {
  update: {
    ...(parsedEstimatedMinutes !==
    undefined
      ? {
          estimatedMinutes:
            parsedEstimatedMinutes,
        }
      : {}),

    ...(isStringArray(sourceLanguage)
      ? { sourceLanguage }
      : {}),

    ...(isStringArray(targetLanguages)
      ? { targetLanguages }
      : {}),

    ...(typeof sourceFileLink ===
    "string"
      ? {
          sourceFileLink,
        }
      : {}),

    ...(typeof srtAvailableLink === "string"
      ? {
          srtAvailableLink:
            srtAvailableLink.trim() || null,
        }
      : {}),

    ...(deliveryDate
      ? {
          deliveryDate:
            new Date(
              deliveryDate
            ),
        }
      : {}),

    ...(deadline
      ? {
          deadlineDate:
            new Date(deadline),
          deadlineHasTime: /T\d{2}:\d{2}/.test(String(deadline)),
        }
      : {}),

    ...(deliveryType === "FINISHED" || deliveryType === "RAW"
      ? { deliveryType }
      : {}),

    // Content category — set a valid value, clear when explicitly null/empty,
    // leave unchanged when the field isn't in the payload.
    ...(contentCategory !== undefined
      ? { contentCategory: isContentCategory(contentCategory) ? contentCategory : null }
      : {}),

...(normalizedGame
  ? {
      game: {
        connect: {
          id: normalizedGame,
        },
      },
    }
  : {}),
  },
},
            }
          : {
              marketing: {
                update: {
                  contentTitle:
  typeof contentTitle ===
  "string"
    ? contentTitle.trim() ||
      null
    : undefined,

                  ...(isStringArray(aspectRatios) ? { aspectRatios } : {}),

                  sourceLanguage,

                  targetLanguages,

                  sourceFileLink:typeof sourceFileLink === "string"
  ? sourceFileLink
  : undefined,

                  ...(typeof srtAvailableLink === "string"
                    ? {
                        srtAvailableLink:
                          srtAvailableLink.trim() || null,
                      }
                    : {}),

                  ...(deadline
                    ? { deadlineDate: new Date(deadline), deadlineHasTime: /T\d{2}:\d{2}/.test(String(deadline)) }
                    : { deadlineDate: null, deadlineHasTime: false }),
                },
              },
            }),
      },
    })

    /*
      DELIVERIES
    */

    if (
      deliveries &&
      Array.isArray(deliveries)
    ) {

      if (
        orderType === "BROADCAST" &&
        existingOrder.broadcast
      ) {


        const broadcastId =
            existingOrder.broadcast.id

            // Only delete rows the editor is ALLOWED to see. A vendor user
            // submits just their own + General links, so links for vendors they
            // can't see must be preserved rather than wiped.
            await tx.broadcastDelivery.deleteMany({
  where: {
    broadcastId,
    id: {
      notIn:
        deliveries
          .filter(
            (d: any) => d.id
          )
          .map(
            (d: any) => d.id
          ),
    },
    ...(canSeeAllDeliveryVendors(user.role, user.position)
      ? {}
      : { vendor: { in: ["", user.position as string] } }),
  },
})

        await Promise.all(
          deliveries.map(
            (delivery: any) => {

              if (delivery.id) {

                return tx.broadcastDelivery.update(
                  {
                    where: {
                      id: delivery.id,
                    },

                    data: {
                      language:
                        delivery.language,

                      vendor: sanitizeVendor(delivery.vendor),

                      deliveryLink:
                        delivery.deliveryLink ||
                        "",
                    },
                  }
                )
              }

              return tx.broadcastDelivery.create(
                {
                  data: {
                    language:
                      delivery.language,

                    vendor: sanitizeVendor(delivery.vendor),

                    deliveryLink:
                      delivery.deliveryLink ||
                      "",

                    broadcastId,
                  },
                }
              )
            }
          )
        )
      }

      if (
        orderType === "MARKETING" &&
        existingOrder.marketing
      ) {
const marketingId =
  existingOrder.marketing.id

  await tx.marketingDelivery.deleteMany({
  where: {
    marketingId,
    id: {
      notIn:
        deliveries
          .filter(
            (d: any) => d.id
          )
          .map(
            (d: any) => d.id
          ),
    },
    // Preserve links for vendors the editor can't see (see broadcast note).
    ...(canSeeAllDeliveryVendors(user.role, user.position)
      ? {}
      : { vendor: { in: ["", user.position as string] } }),
  },
})
        await Promise.all(
          deliveries.map(
            (delivery: any) => {

              if (delivery.id) {

                return tx.marketingDelivery.update(
                  {
                    where: {
                      id: delivery.id,
                    },

                    data: {
                      language:
                        delivery.language,

                      vendor: sanitizeVendor(delivery.vendor),

                      deliveryLink:
                        delivery.deliveryLink ||
                        "",
                    },
                  }
                )
              }

              return tx.marketingDelivery.create(
                {
                  data: {
                    language:
                      delivery.language,

                    vendor: sanitizeVendor(delivery.vendor),

                    deliveryLink:
                      delivery.deliveryLink ||
                      "",

                    marketingId,
                  },
                }
              )
            }
          )
        )
      }
    }

    /*
  DELIVERY FORMATS
*/

if (
  deliveryFormats &&
  Array.isArray(
    deliveryFormats
  )
) {
  if (
  orderType ===
    "BROADCAST" &&
  existingOrder.broadcast
) {
  const broadcastId =
    existingOrder.broadcast.id

  await tx.broadcastDeliveryFormat.deleteMany({
    where: {
      broadcastId,

      id: {
        notIn:
          deliveryFormats
            .filter(
              (item: any) =>
                item.id
            )
            .map(
              (item: any) =>
                item.id
            ),
      },
    },
  })



  await Promise.all(
    deliveryFormats.map(
      (item: any) => {

        if (item.id) {

          return tx.broadcastDeliveryFormat.update(
            {
              where: {
                id: item.id,
              },

              data: {
                format: isDeliveryFormat(
  item.format
)
  ? item.format
  : DeliveryFormat.SRT,

                deliveryLink:
                  item.deliveryLink ||
                  "",
              },
            }
          )
        }

        return tx.broadcastDeliveryFormat.create(
          {
            data: {
             format: isDeliveryFormat(
  item.format
)
  ? item.format
  : DeliveryFormat.SRT,

              deliveryLink:
                item.deliveryLink ||
                "",

              broadcastId,
            },
          }
        )
      }
    )
  )
}

if (
  orderType ===
    "MARKETING" &&
  existingOrder.marketing
) {
  const marketingId =
    existingOrder.marketing.id

  await tx.marketingDeliveryFormat.deleteMany({
    where: {
      marketingId,

      id: {
        notIn:
          deliveryFormats
            .filter(
              (item: any) =>
                item.id
            )
            .map(
              (item: any) =>
                item.id
            ),
      },
    },
  })

  await Promise.all(
    deliveryFormats.map(
      (item: any) => {

        if (item.id) {

          return tx.marketingDeliveryFormat.update(
            {
              where: {
                id: item.id,
              },

              data: {
               format: isDeliveryFormat(
  item.format
)
  ? item.format
  : DeliveryFormat.SRT,

                deliveryLink:
                  item.deliveryLink ||
                  "",
              },
            }
          )
        }

        return tx.marketingDeliveryFormat.create(
          {
            data: {
             format: isDeliveryFormat(
  item.format
)
  ? item.format
  : DeliveryFormat.SRT,

              deliveryLink:
                item.deliveryLink ||
                "",

              marketingId,
            },
          }
        )
      }
    )
  )
}
}

  return tx.translationOrder.findUnique({
    where: { id: orderId },
    select: orderSelect,
  })
  }, {
    // REPEATABLE READ ensures that if two users submit edits at the exact same
    // millisecond, PostgreSQL detects the concurrent write on the second
    // transaction and aborts it (error P2034 / PG code 40001) rather than
    // silently overwriting the first user's changes.
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  }) // end prisma.$transaction
} catch (txError: any) {
  if (txError?.__conflict === true) {
    logger.warn({ action: "UPDATE_ORDER_CONFLICT", userId: req.userId, userName: req.userName, orderId })
    return res.status(409).json({
      message: "This order was recently modified by someone else. Please refresh and try again.",
    })
  }
  if (
    txError instanceof Prisma.PrismaClientKnownRequestError &&
    txError.code === "P2034"
  ) {
    // PostgreSQL serialization failure — two writers hit the exact same row concurrently
    logger.warn({ action: "UPDATE_ORDER_SERIALIZATION_CONFLICT", userId: req.userId, userName: req.userName, orderId })
    return res.status(409).json({
      message: "This order was recently modified by someone else. Please refresh and try again.",
    })
  }
  throw txError // re-throw anything else to the outer catch → 500
}


    /*
      SOURCE FILE CHANGED
    */

// Notify when a (non-empty) source file link is set/changed — for BOTH
// broadcast and marketing orders.
const prevSourceLink =
  orderType === "BROADCAST"
    ? existingOrder.broadcast?.sourceFileLink
    : existingOrder.marketing?.sourceFileLink

const sourceWasChanged =
  typeof sourceFileLink === "string" &&
  sourceFileLink.trim() !== "" &&
  sourceFileLink !== prevSourceLink

// A CHANGE = there was already a source and it was replaced (vs. a first-time add).
const sourceIsChange = sourceWasChanged && !!(prevSourceLink && prevSourceLink.trim())

// A REMOVAL = there was a source and it was explicitly cleared to empty.
const sourceWasRemoved =
  typeof sourceFileLink === "string" &&
  sourceFileLink.trim() === "" &&
  !!(prevSourceLink && prevSourceLink.trim())

    if (sourceWasRemoved) {
      notifyTranslatorsSourceRemoved(orderId).catch((e) =>
        logger.error({ action: "NOTIFY_SOURCE_REMOVED_ERROR", orderId, err: e })
      )
    }

    if (sourceWasChanged) {

      // Flag the order so the table shows a caution icon for translators who may
      // be working off the old source. Only for real changes, not first-time adds.
      // readyAt is deliberately NOT moved — it marks when the order first became
      // translatable, and moving it would put the timeline behind inProgressAt /
      // completedAt on an order that's already underway.
      if (sourceIsChange) {
        prisma.translationOrder
          .update({ where: { id: orderId }, data: { sourceChangedAt: new Date() } })
          .then(() => ordersCache.invalidate())
          .catch((e) => logger.error({ action: "SET_SOURCE_CHANGED_ERROR", orderId, err: e }))
      }

      // First-time source add on a still-PENDING order → advance it to
      // READY_FOR_TRANSLATION and roll it up if it's a sub-order.
      if (!sourceIsChange && updatedOrder?.status === OrderStatus.PENDING) {
        prisma.translationOrder
          .update({ where: { id: orderId }, data: { status: OrderStatus.READY_FOR_TRANSLATION, readyAt: new Date() } })
          .then(async () => {
            ordersCache.invalidate()
            try { getIo()?.emit("order-patched", { id: orderId, type: updatedOrder?.type, status: OrderStatus.READY_FOR_TRANSLATION }) } catch {}
            if (existingOrder.parentId) {
              const parentStatus = await recomputeParentStatus(existingOrder.parentId)
              const nearestSubDeadline = await nearestSubDeadlineFor(existingOrder.parentId)
              ordersCache.invalidate()
              try { getIo()?.emit("order-patched", { id: existingOrder.parentId, type: updatedOrder?.type, status: parentStatus, nearestSubDeadline }) } catch {}
            }
          })
          .catch((e) => logger.error({ action: "SET_READY_FOR_TRANSLATION_ERROR", orderId, err: e }))
      }

      notifyTranslatorsSourceReady(
        orderId,
        sourceIsChange
      ).catch((e) => logger.error({ action: "NOTIFY_TRANSLATORS_ERROR", orderId, err: e }))
    }

    /*
      NOTIFY AUDIENCE EXPANDED — a new role (e.g. TransPerfect adding Translator)
      was added to notifyPositions on an order that already has a source and
      whose source link didn't change this edit (that case is fully handled
      above). Email only the newly-added roles — everyone already selected has
      already been notified and shouldn't get a duplicate "source added" email.
    */
    if (!sourceWasChanged && finalSourceLink.trim() && notifyPositionsProvided) {
      const previouslyNotified = new Set(sanitizeNotifyPositions((existingOrder as any).notifyPositions))
      const newlyAdded = parsedNotifyPositions.filter((p) => !previouslyNotified.has(p))
      if (newlyAdded.length > 0) {
        notifyTranslatorsSourceReady(orderId, false, newlyAdded).catch((e) =>
          logger.error({ action: "NOTIFY_TRANSLATORS_ERROR", orderId, err: e })
        )
      }
    }

    const changes = diffOrders(existingOrder, updatedOrder)
    logger.info({
      action: "UPDATE_ORDER", userId: req.userId, userName: req.userName, orderId,
      type: updatedOrder?.type, title: updatedOrder?.title,
      changes, sourceChanged: sourceWasChanged,
    })

    ordersCache.invalidate()
    try { getIo()?.emit("order-patched", { id: orderId, type: updatedOrder?.type }) } catch {}
    res.json(updatedOrder)

    // If a sub-order changed, roll its status up into the parent and refresh the
    // parent's nearest-sub-order deadline (a status OR deadline edit can change it).
    if (existingOrder.parentId) {
      const pid = existingOrder.parentId
      recomputeParentStatus(pid)
        .then(async (parentStatus) => {
          const nearestSubDeadline = await nearestSubDeadlineFor(pid)
          ordersCache.invalidate()
          try { getIo()?.emit("order-patched", { id: pid, type: updatedOrder?.type, status: parentStatus, nearestSubDeadline }) } catch {}
        })
        .catch((e) => logger.error({ action: "RECOMPUTE_PARENT_ERROR", parentId: pid, err: e }))
    }

    return

  } catch (error) {

    logger.error({ action: "UPDATE_ORDER_ERROR", userId: req.userId, userName: req.userName, orderId: req.params.id, err: error })

    return res.status(500).json({
      message:
        "Failed to update order",
    })
  }
}

export async function updateOrderStatus(
  req: AuthRequest,
  res: Response
) {
  try {

    const orderId = String(
      req.params.id
    )

    const { status } = req.body

    if (!isOrderStatus(status)) {
      return res.status(400).json({
        message: "Invalid status",
      })
    }

    /*
      USER + EXISTING ORDER — fetched in parallel (independent queries)
    */

    const [user, existingOrder] =
      await Promise.all([
        prisma.user.findUnique({
          where: {
            id: req.userId,
          },

          select: {
            id: true,
            role: true,
            position: true,
          },
        }),

        prisma.translationOrder.findUnique({
          where: {
            id: orderId,
          },

          select: {
            id: true,
            title: true,
            type: true,
            event: true,
            isParent: true,
            parentId: true,
            status: true,
            notifyPositions: true,
          },
        }),
      ])

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      })
    }

    /*
      PERMISSIONS
    */

    if (!canUpdateStatus(user)) {
      return res.status(403).json({
        message: "Unauthorized",
      })
    }

    if (!existingOrder) {
      return res.status(404).json({
        message:
          "Order not found",
      })
    }

    // Can't change the status of an order you aren't assigned to see.
    if (!canSeeOrder(user.role, user.position, existingOrder.notifyPositions)) {
      return res.status(404).json({ message: "Order not found" })
    }

    // A parent ("big order") status is derived from its sub-orders, not set manually.
    if (existingOrder.isParent) {
      return res.status(400).json({
        message: "Parent order status is derived from its sub-orders",
      })
    }

    /*
      UPDATE DATA
    */

    const parsedStatus = isOrderStatus(status) ? status : OrderStatus.PENDING

    // IDEMPOTENCY — skip the write entirely if the status hasn't changed.
    // This prevents double socket-emit when two users set the same status
    // simultaneously (the second request becomes a no-op).
    if (parsedStatus === existingOrder.status) {
      return res.json({ id: orderId, type: existingOrder.type, status: existingOrder.status })
    }

const updateData:
  Prisma.TranslationOrderUpdateInput =
{
  status: parsedStatus,
}

if (
  parsedStatus ===
  OrderStatus.COMPLETED
){
  updateData.completedBy = {
    connect: {
      id: user.id,
    },
  }
  updateData.completedAt =
    new Date()
  // Completing the order resolves the "source changed" caution for good, so it
  // won't reappear if the order is later reopened.
  updateData.sourceChangedAt = null
} else {
  updateData.completedBy = {
    disconnect: true,
  }
  updateData.completedAt =
    null
}

// Stamp the moment the order ENTERS Ready / In Progress so the sidebar can show
// when each stage began and how long it took.
if (parsedStatus === OrderStatus.READY_FOR_TRANSLATION) updateData.readyAt = new Date()
if (parsedStatus === OrderStatus.IN_PROGRESS) updateData.inProgressAt = new Date()

    /*
      UPDATE ORDER
    */

    const updatedOrder =
      await prisma.translationOrder.update({
        where: {
          id: orderId,
        },

        data: updateData,

        select: { id: true, type: true, status: true },
      })

    /*
      RESPOND IMMEDIATELY — notifications fire in the background
    */

    logger.info({ action: "UPDATE_ORDER_STATUS", userId: req.userId, userName: req.userName, orderId, title: existingOrder.title, from: existingOrder.status, to: parsedStatus, orderLink: orderPageLink(existingOrder.type, orderId, existingOrder.event) })

    ordersCache.invalidate()
    try { getIo()?.emit("order-patched", { id: updatedOrder.id, type: updatedOrder.type, status: updatedOrder.status }) } catch {}
    res.json(updatedOrder)

    // If this is a sub-order, roll its status up into the parent and refresh the
    // parent's nearest-sub-order deadline (the completed sub may no longer be it).
    if (existingOrder.parentId) {
      const pid = existingOrder.parentId
      recomputeParentStatus(pid)
        .then(async (parentStatus) => {
          const nearestSubDeadline = await nearestSubDeadlineFor(pid)
          ordersCache.invalidate()
          try { getIo()?.emit("order-patched", { id: pid, type: updatedOrder.type, status: parentStatus, nearestSubDeadline }) } catch {}
        })
        .catch((e) => logger.error({ action: "RECOMPUTE_PARENT_ERROR", parentId: pid, err: e }))
    }

    /*
      NOTIFICATIONS (fire-and-forget — response already sent)
    */

    if (parsedStatus === OrderStatus.COMPLETED) {
      // Fetch notification recipients + completer name after response is sent
      Promise.all([
        prisma.translationOrder.findUnique({
          where: { id: orderId },
          select: {
            createdById: true,
            broadcast: {
              select: {
                game: {
                  select: {
                    assignedUsers: {
                      select: { user: { select: { id: true } } },
                    },
                  },
                },
              },
            },
            marketing: {
              select: {
                assignments: { select: { userId: true } },
              },
            },
          },
        }),
        prisma.user.findUnique({
          where: { id: req.userId },
          select: { firstName: true, lastName: true },
        }),
      ]).then(([notifOrder, completer]) => {
        if (!notifOrder || !completer) return

        let notifyUserIds: string[] = []

        if (existingOrder.type === "BROADCAST" && notifOrder.broadcast?.game) {
          notifyUserIds = notifOrder.broadcast.game.assignedUsers.map((a) => a.user.id)
        } else if (existingOrder.type === "MARKETING") {
          notifyUserIds = notifOrder.marketing?.assignments.map((a) => a.userId) ?? []
        }

        if (notifOrder.createdById) notifyUserIds.push(notifOrder.createdById)

        const uniqueUserIds = [...new Set(notifyUserIds)]
        if (uniqueUserIds.length === 0) return

        // Atomic check-then-create to prevent duplicate notifications
        prisma.$transaction(async (tx) => {
          const already = await tx.notification.count({
            where: { orderId: updatedOrder.id, type: "ORDER_COMPLETED" },
          })
          if (already > 0) return

          const created = await tx.notification.createManyAndReturn({
            data: uniqueUserIds.map((userId) => ({
              title: "Order Completed",
              message: `${existingOrder.title} has been marked as completed by ${completer.firstName} ${completer.lastName}`,
              type: "ORDER_COMPLETED",
              userId,
              orderId: updatedOrder.id,
            })),
            skipDuplicates: true,
            include: {
              order: { select: { id: true, title: true } },
            },
          })

          if (created.length > 0) {
            triggerNotifications(created).catch((e) => logger.error({ action: "TRIGGER_NOTIFICATIONS_ERROR", orderId, err: e }))
          }
        }).catch((e) => logger.error({ action: "ORDER_COMPLETED_NOTIFICATION_ERROR", orderId, err: e }))
      }).catch((e) => logger.error({ action: "ORDER_COMPLETED_NOTIFICATION_ERROR", orderId, err: e }))
    } else if (existingOrder.status === OrderStatus.COMPLETED) {
      // REOPENED: status moved away from COMPLETED → notify the same recipients
      // who were told it was completed, that it has changed back.
      const newLabel = parsedStatus === OrderStatus.IN_PROGRESS ? "In Progress" : "Pending"

      Promise.all([
        prisma.translationOrder.findUnique({
          where: { id: orderId },
          select: {
            createdById: true,
            broadcast: {
              select: {
                game: {
                  select: {
                    assignedUsers: { select: { user: { select: { id: true } } } },
                  },
                },
              },
            },
            marketing: {
              select: { assignments: { select: { userId: true } } },
            },
          },
        }),
        prisma.user.findUnique({
          where: { id: req.userId },
          select: { firstName: true, lastName: true },
        }),
      ]).then(([notifOrder, actor]) => {
        if (!notifOrder || !actor) return

        let notifyUserIds: string[] = []
        if (existingOrder.type === "BROADCAST" && notifOrder.broadcast?.game) {
          notifyUserIds = notifOrder.broadcast.game.assignedUsers.map((a) => a.user.id)
        } else if (existingOrder.type === "MARKETING") {
          notifyUserIds = notifOrder.marketing?.assignments.map((a) => a.userId) ?? []
        }
        if (notifOrder.createdById) notifyUserIds.push(notifOrder.createdById)

        const uniqueUserIds = [...new Set(notifyUserIds)]
        if (uniqueUserIds.length === 0) return

        const title = "Order Reopened"
        const message = `Changed from Completed to ${newLabel} by ${actor.firstName} ${actor.lastName}`

        ;(async () => {
          // Clear the prior "completed" notifications so a later re-completion
          // notifies again (the completed-flow guards on an existing one).
          await prisma.notification.deleteMany({
            where: { orderId: updatedOrder.id, type: "ORDER_COMPLETED" },
          })

          const created = []
          for (const userId of uniqueUserIds) {
            const n = await prisma.notification.upsert({
              where: {
                orderId_userId_type: {
                  orderId: updatedOrder.id,
                  userId,
                  type: "ORDER_REOPENED",
                },
              },
              update: { title, message, isRead: false, createdAt: new Date() },
              create: { title, message, type: "ORDER_REOPENED", userId, orderId: updatedOrder.id },
              include: { order: { select: { id: true, title: true } } },
            })
            created.push(n)
          }
          if (created.length > 0) {
            await triggerNotifications(created)
          }
        })().catch((e) => logger.error({ action: "ORDER_REOPENED_NOTIFICATION_ERROR", orderId, err: e }))
      }).catch((e) => logger.error({ action: "ORDER_REOPENED_NOTIFICATION_ERROR", orderId, err: e }))
    }

  } catch (error) {

    logger.error({ action: "UPDATE_ORDER_STATUS_ERROR", userId: req.userId, userName: req.userName, orderId: req.params.id, err: error })

    return res.status(500).json({
      message:
        "Failed to update status",
    })
  }
}

/*
  Quick-edit a broadcast order's content category (admin-only, from the table).
  Emits an in-place `order-patched` carrying contentCategory so clients patch
  just that row — no full re-fetch (mirrors the status update).
*/
export async function updateOrderContentCategory(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, role: true, position: true },
    })
    if (!user) return res.status(404).json({ message: "User not found" })
    // Admin-only quick edit.
    if (user.role !== UserRole.ADMIN) {
      return res.status(403).json({ message: "Unauthorized" })
    }

    const orderId = String(req.params.id)
    const category = req.body?.contentCategory
    if (!isContentCategory(category)) {
      return res.status(400).json({ message: "Content category is required" })
    }

    const existing = await prisma.translationOrder.findUnique({
      where: { id: orderId },
      select: { id: true, type: true, isParent: true, broadcast: { select: { id: true } } },
    })
    if (!existing || !existing.broadcast) {
      return res.status(404).json({ message: "Broadcast order not found" })
    }

    await prisma.translationOrder.update({
      where: { id: orderId },
      data: { broadcast: { update: { contentCategory: category } } },
    })

    // Big order → cascade the category to every sub-order so they stay in sync.
    if (existing.isParent) {
      await prisma.broadcastDetails.updateMany({
        where: { order: { parentId: orderId } },
        data: { contentCategory: category },
      })
    }

    logger.info({ action: "UPDATE_CONTENT_CATEGORY", userId: req.userId, userName: req.userName, orderId, contentCategory: category, cascaded: existing.isParent })

    ordersCache.invalidate()
    // cascaded flag → clients reload the expanded parent's sub-order rows.
    try { getIo()?.emit("order-patched", { id: orderId, type: existing.type, contentCategory: category, cascaded: existing.isParent }) } catch {}

    return res.json({ id: orderId, type: existing.type, contentCategory: category, cascaded: existing.isParent })
  } catch (error) {
    logger.error({ action: "UPDATE_CONTENT_CATEGORY_ERROR", userId: req.userId, userName: req.userName, orderId: req.params.id, err: error })
    return res.status(500).json({ message: "Failed to update content category" })
  }
}

/**
 * Manually re-notify translators that the source file changed.
 *
 * The automatic notification only fires when the source *link* string changes.
 * But sometimes the file behind the same link is swapped (e.g. a Drive file
 * replaced in place), so the link is identical and translators are never told.
 * This endpoint lets an editor explicitly resend the "Source File Updated" email
 * regardless of whether the link changed, and flags the order so the caution
 * icon appears for translators working off the old copy.
 */
export async function resendSourceNotification(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })

    const orderId = String(req.params.id)
    const existing = await prisma.translationOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        type: true,
        isParent: true,
        broadcast: { select: { sourceFileLink: true } },
        marketing: { select: { sourceFileLink: true } },
      },
    })
    if (!existing) return res.status(404).json({ message: "Order not found" })

    const sourceFileLink =
      existing.type === "BROADCAST"
        ? existing.broadcast?.sourceFileLink
        : existing.marketing?.sourceFileLink

    if (!sourceFileLink || !sourceFileLink.trim()) {
      return res.status(400).json({ message: "This order has no source file to notify about." })
    }

    // Optional audience override from the modal pills; else the stored selection.
    const override = sanitizeNotifyPositions(req.body?.notifyPositions)

    // Persist the override (so it becomes the order's saved selection) and flag
    // the order (caution icon) so translators see it may have changed.
    try {
      await prisma.translationOrder.update({
        where: { id: orderId },
        data: { sourceChangedAt: new Date(), ...(override.length ? { notifyPositions: override } : {}) },
      })
      ordersCache.invalidate()
      try { getIo()?.emit("order-patched", { id: orderId, type: existing.type }) } catch {}
    } catch (e) {
      logger.error({ action: "SET_SOURCE_CHANGED_ERROR", orderId, err: e })
    }

    // Resend as a CHANGE ("Source File Updated"), fire-and-forget.
    notifyTranslatorsSourceReady(orderId, true, override.length ? override : undefined).catch((e) =>
      logger.error({ action: "NOTIFY_TRANSLATORS_ERROR", orderId, err: e })
    )

    logger.info({ action: "RESEND_SOURCE_NOTIFICATION", userId: req.userId, userName: req.userName, orderId, orderLink: orderPageLink(existing.type, orderId) })

    return res.json({ id: orderId, ok: true })
  } catch (error) {
    logger.error({ action: "RESEND_SOURCE_NOTIFICATION_ERROR", userId: req.userId, userName: req.userName, orderId: req.params.id, err: error })
    return res.status(500).json({ message: "Failed to resend source notification" })
  }
}

export async function markNotificationsAsRead(
  req: AuthRequest,
  res: Response
) {
  try {

    if (!req.userId) {
      return res.status(401).json({
        message: "Unauthorized",
      })
    }

    await prisma.notification.updateMany({
      where: {
        userId: req.userId,
        isRead: false,
      },

      data: {
        isRead: true,
      },
    })

    return res.json({
      success: true,
    })

  } catch (error) {

    logger.error({ action: "MARK_NOTIFICATIONS_READ_ERROR", userId: req.userId, userName: req.userName, err: error })

    return res.status(500).json({
      message:
        "Failed to mark notifications as read",
    })
  }
}

export async function assignUsersToMarketingOrder(
  req: AuthRequest,
  res: Response
) {
  try {

    if (!req.userId) {
      return res.status(401).json({
        message: "Unauthorized",
      })
    }

    const orderId = String(
      req.params.id
    )

    const { userIds } = req.body

    if (
      !Array.isArray(userIds) ||
      !userIds.every(
        (id) => typeof id === "string"
      )
    ) {
      return res.status(400).json({
        message:
          "userIds must be an array of strings",
      })
    }

    /*
      REQUESTER
    */

    const requester =
      await prisma.user.findUnique({
        where: { id: req.userId },
        select: {
          id: true,
          role: true,
          department: true,
          position: true,
        },
      })

    if (!requester) {
      return res.status(404).json({
        message: "User not found",
      })
    }

    /*
      PERMISSIONS
    */

    const canAssign =
      requester.role === UserRole.ADMIN ||
      (requester.department ===
        UserDepartment.MARKETING &&
        (requester.position ===
          UserPosition.PRODUCER ||
          requester.position ===
            UserPosition.POST_PRODUCTION_MANAGER))

    if (!canAssign) {
      return res.status(403).json({
        message: "Unauthorized",
      })
    }

    /*
      FIND ORDER
    */

    const order =
      await prisma.translationOrder.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          title: true,
          type: true,
          marketing: {
            select: {
              id: true,
              assignments: {
                select: {
                  userId: true,
                },
              },
            },
          },
        },
      })

    if (!order) {
      return res.status(404).json({
        message: "Order not found",
      })
    }

    if (order.type !== OrderType.MARKETING) {
      return res.status(400).json({
        message:
          "Can only assign users to marketing orders",
      })
    }

    const marketingId = order.marketing!.id

    /*
      UPSERT ASSIGNMENTS + NOTIFY NEW
      Reading the current assignment list inside the transaction ensures we
      compute deltas against committed data, preventing concurrent requests
      from producing duplicate notifications (TOCTOU fix).
      createManyAndReturn({ skipDuplicates }) gives back only the rows that
      were actually inserted, so we only notify users who are genuinely new.
    */

    const createdNotifications = await prisma.$transaction(async (tx) => {
      // Re-read assignments inside the transaction — serialised against concurrent writes
      const currentOrder = await tx.translationOrder.findUnique({
        where: { id: orderId },
        select: {
          marketing: {
            select: {
              assignments: { select: { userId: true } },
            },
          },
        },
      })

      const currentIds = new Set(
        currentOrder?.marketing?.assignments.map((a) => a.userId) ?? []
      )
      const actualNewUserIds = userIds.filter((id) => !currentIds.has(id))
      const actualRemovedUserIds = [...currentIds].filter((id) => !userIds.includes(id))

      if (actualRemovedUserIds.length > 0) {
        await tx.marketingOrderAssignment.deleteMany({
          where: { marketingId, userId: { in: actualRemovedUserIds } },
        })
      }

      if (actualNewUserIds.length === 0) return []

      // createManyAndReturn returns only rows that were actually inserted —
      // skipDuplicates silently drops any that already exist (concurrent request)
      const createdAssignments = await tx.marketingOrderAssignment.createManyAndReturn({
        data: actualNewUserIds.map((userId) => ({ userId, marketingId })),
        skipDuplicates: true,
      })

      const trulyNewIds = createdAssignments.map((a) => a.userId)
      if (trulyNewIds.length === 0) return []

      return tx.notification.createManyAndReturn({
        data: trulyNewIds.map((userId) => ({
          title: "Assigned to Order",
          message: `You have been assigned to the marketing order: ${order.title}`,
          type: "ASSIGNED_TO_ORDER" as const,
          userId,
          orderId,
        })),
        include: {
          order: { select: { id: true, title: true } },
        },
      })
    })

    // Only emit notifications for users who were actually newly assigned
    if (createdNotifications.length > 0) {
      triggerNotifications(createdNotifications).catch((e) => logger.error({ action: "TRIGGER_NOTIFICATIONS_ERROR", orderId, err: e }))
    }

    /*
      RETURN UPDATED ORDER
    */

    const updatedOrder =
      await prisma.translationOrder.findUnique({
        where: { id: orderId },
        select: orderSelect,
      })

    logger.info({ action: "ASSIGN_USERS_TO_ORDER", userId: req.userId, userName: req.userName, orderId, orderTitle: order.title, count: userIds.length, userIds })

    ordersCache.invalidate()
    try { getIo()?.emit("order-patched", { id: orderId, type: order.type }) } catch {}
    return res.json(updatedOrder)

  } catch (error) {

    logger.error({ action: "ASSIGN_USERS_TO_ORDER_ERROR", userId: req.userId, userName: req.userName, orderId: req.params.id, err: error })

    return res.status(500).json({
      message:
        "Failed to assign users",
    })
  }
}

export async function deleteOrder(
  req: AuthRequest,
  res: Response
) {
  try {

    if (!req.userId) {
      return res.status(401).json({
        message: "Unauthorized",
      })
    }

    const orderId =
      String(req.params.id)

    /*
      GET USER ROLE ONLY
    */

    const user =
      await prisma.user.findUnique({
        where: {
          id: req.userId,
        },

        select: {
          role: true,
          position: true,
        },
      })

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      })
    }

    /*
      PERMISSIONS
    */

    if (!canManageOrders(user)) {
      return res.status(403).json({
        message: "Unauthorized",
      })
    }

    /*
      DELETE DIRECTLY
      (single query)
    */

    // Capture the full order data BEFORE deleting so it can be logged.
    const fullOrder = await prisma.translationOrder.findUnique({
      where: { id: orderId },
      select: orderSelectCore,
    })

    const deleted = await prisma.translationOrder.delete({
      where: {
        id: orderId,
      },
      // parentId captured so a deleted sub-order can roll up into its parent.
      // Deleting a parent cascades to its sub-orders (onDelete: Cascade).
      select: { id: true, type: true, parentId: true, title: true },
    })

    logger.info({ action: "DELETE_ORDER", userId: req.userId, userName: req.userName, orderId, deleted: orderSnapshot(fullOrder) })

    ordersCache.invalidate()
    try { getIo()?.emit("order-deleted", { id: deleted.id, type: deleted.type }) } catch {}

    // If the deleted order had a source file, tell translators to stop work on it.
    const deletedSourceLink =
      fullOrder?.type === "BROADCAST"
        ? fullOrder?.broadcast?.sourceFileLink
        : fullOrder?.marketing?.sourceFileLink
    if (deletedSourceLink) {
      notifyTranslatorsOrderDeleted(fullOrder).catch(() => {})
    }

    // If a sub-order was deleted, recompute the parent's rolled-up status and
    // its nearest-sub-order deadline.
    if (deleted.parentId) {
      const parentStatus = await recomputeParentStatus(deleted.parentId)
      const nearestSubDeadline = await nearestSubDeadlineFor(deleted.parentId)
      ordersCache.invalidate()
      try { getIo()?.emit("order-patched", { id: deleted.parentId, type: deleted.type, status: parentStatus, nearestSubDeadline }) } catch {}
    }

    return res.json({
      success: true,
    })

  } catch (error: any) {

    /*
      RECORD NOT FOUND
    */

    if (
      error.code === "P2025"
    ) {
      return res.status(404).json({
        message:
          "Order not found",
      })
    }

    logger.error({ action: "DELETE_ORDER_ERROR", userId: req.userId, userName: req.userName, orderId: req.params.id, err: error })

    return res.status(500).json({
      message:
        "Failed to delete order",
    })
  }
}

/**
 * POST /orders/bulk-delete   body: { ids: string[] }
 *
 * Delete several orders at once. Mirrors deleteOrder for each id — same
 * permission gate, same logging, source-removed notifications, parent status
 * rollup, and socket emits — but resolves the parent recompute ONCE per affected
 * parent at the end, so deleting a run of sub-orders under the same parent
 * doesn't recompute it N times.
 *
 * Deleting a parent cascades to its sub-orders at the database level
 * (onDelete: Cascade), so ids may name a parent without its children.
 */
const MAX_BULK_DELETE = 200

export async function bulkDeleteOrders(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ message: "Unauthorized" })

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true, position: true },
    })
    if (!user) return res.status(404).json({ message: "User not found" })
    if (!canManageOrders(user)) return res.status(403).json({ message: "Unauthorized" })

    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : []
    const validIds = rawIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    const ids: string[] = [...new Set<string>(validIds)]
    if (ids.length === 0) return res.status(400).json({ message: "No orders selected." })
    if (ids.length > MAX_BULK_DELETE) {
      return res.status(413).json({ message: `Too many orders selected (max ${MAX_BULK_DELETE}).` })
    }

    const io = (() => { try { return getIo() } catch { return null } })()
    const deletedIds: string[] = []
    const failed: { id: string; reason: string }[] = []
    // Parents to reconcile after the fact. A parent deleted in this batch is
    // skipped, since it no longer exists.
    const affectedParents = new Set<string>()

    for (const id of ids) {
      try {
        const fullOrder = await prisma.translationOrder.findUnique({
          where: { id },
          select: orderSelectCore,
        })
        if (!fullOrder) {
          failed.push({ id, reason: "not_found" })
          continue
        }

        const deleted = await prisma.translationOrder.delete({
          where: { id },
          select: { id: true, type: true, parentId: true },
        })

        deletedIds.push(deleted.id)
        logger.info({
          action: "DELETE_ORDER",
          userId: req.userId,
          userName: req.userName,
          orderId: id,
          bulk: true,
          deleted: orderSnapshot(fullOrder),
        })

        try { io?.emit("order-deleted", { id: deleted.id, type: deleted.type }) } catch {}

        const sourceLink =
          fullOrder.type === "BROADCAST"
            ? (fullOrder as any).broadcast?.sourceFileLink
            : (fullOrder as any).marketing?.sourceFileLink
        if (sourceLink) notifyTranslatorsOrderDeleted(fullOrder).catch(() => {})

        if (deleted.parentId) affectedParents.add(deleted.parentId)
      } catch (error: any) {
        // P2025 = already gone; treat as success so a double-click is harmless.
        if (error?.code === "P2025") {
          deletedIds.push(id)
          continue
        }
        failed.push({ id, reason: "delete_failed" })
        logger.error({ action: "DELETE_ORDER_ERROR", userId: req.userId, orderId: id, bulk: true, err: error })
      }
    }

    ordersCache.invalidate()

    // Reconcile each surviving parent once, skipping any that were themselves
    // deleted in this batch.
    for (const parentId of affectedParents) {
      if (deletedIds.includes(parentId)) continue
      try {
        const parentStatus = await recomputeParentStatus(parentId)
        const nearestSubDeadline = await nearestSubDeadlineFor(parentId)
        const parent = await prisma.translationOrder.findUnique({ where: { id: parentId }, select: { type: true } })
        io?.emit("order-patched", { id: parentId, type: parent?.type, status: parentStatus, nearestSubDeadline })
      } catch { /* parent gone or already consistent */ }
    }
    if (affectedParents.size > 0) ordersCache.invalidate()

    return res.json({ success: true, deleted: deletedIds.length, deletedIds, failed })
  } catch (error: any) {
    logger.error({ action: "BULK_DELETE_ORDERS_ERROR", userId: req.userId, err: error })
    return res.status(500).json({ message: "Failed to delete the selected orders." })
  }
}

/**
 * GET /orders/counts
 * Returns { PENDING, IN_PROGRESS, COMPLETED, total } for the current filter set
 * (intentionally excludes statusFilter so all statuses are always counted).
 */
export async function getOrderCounts(
  req: AuthRequest,
  res: Response
) {
  try {
    const search = String(req.query.search || "")
    const priority = String(req.query.priority || "")
    const type = String(req.query.type || "")
    const event = String(req.query.event || "")
    const gameIds = parseGameIds(req.query.gameId)
    const contentTitle = String(req.query.contentTitle || "")
    const orderId = String(req.query.orderId || "")
    const assignedOnly = req.query.assignedOnly === "true"

    const formatRaw = req.query.format
    const formatValues = Array.isArray(formatRaw)
      ? formatRaw
      : formatRaw
      ? [String(formatRaw)]
      : []

    const [firstNameSearch = "", lastNameSearch = ""] = search.split(" ")

    const where: Prisma.TranslationOrderWhereInput = {}

    if (orderId) {
      where.id = orderId
    } else {
      // Count individual work units — standalone orders + sub-orders — but not
      // parent grouping shells, whose status is only a rollup of their children.
      // This way a READY sub-order is counted even if its parent is In Progress.
      where.isParent = false
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { notes: { contains: search, mode: "insensitive" } },
        { marketing: { is: { contentTitle: { contains: search, mode: "insensitive" } } } },
        { createdBy: { is: { firstName: { contains: search, mode: "insensitive" } } } },
        { createdBy: { is: { lastName: { contains: search, mode: "insensitive" } } } },
      ]
      if (firstNameSearch && lastNameSearch) {
        where.OR.push({
          createdBy: {
            is: {
              AND: [
                { firstName: { contains: firstNameSearch, mode: "insensitive" } },
                { lastName: { contains: lastNameSearch, mode: "insensitive" } },
              ],
            },
          },
        })
      }
    }

    if (isEventType(event)) where.event = event
    if (isOrderPriority(priority)) where.priority = priority
    if (isOrderType(type)) where.type = type

    const existingAnd: Prisma.TranslationOrderWhereInput[] = []

    const parsedFormats = formatValues.filter(isDeliveryFormat)
    if (parsedFormats.length > 0) {
      existingAnd.push({
        OR: [
          { broadcast: { is: { deliveryFormats: { some: { format: { in: parsedFormats } } } } } },
          { marketing: { is: { deliveryFormats: { some: { format: { in: parsedFormats } } } } } },
        ],
      })
    }

    if (existingAnd.length > 0) where.AND = existingAnd

    if (gameIds.length > 0) {
      where.broadcast = { is: gameIdBroadcastWhere(gameIds, where.broadcast) }
    }

    if (contentTitle) {
      where.marketing = {
        is: { contentTitle: { equals: contentTitle, mode: "insensitive" } },
      }
    }

    if (assignedOnly && req.userId) {
      if (type === "MARKETING") {
        where.marketing = {
          is: {
            ...(where.marketing && typeof where.marketing === "object" && "is" in where.marketing && where.marketing.is
              ? where.marketing.is
              : {}),
            assignments: { some: { userId: req.userId } },
          },
        }
      } else {
        where.broadcast = {
          is: {
            ...(where.broadcast && typeof where.broadcast === "object" && "is" in where.broadcast && where.broadcast.is
              ? where.broadcast.is
              : {}),
            game: { assignedUsers: { some: { userId: req.userId } } },
          },
        }
      }
    }

    // Counts must match what the list shows — apply the same assignment-based
    // visibility (folded in before the cache key so audiences cache separately).
    const countsVisibility = orderVisibilityWhere(req.userRole, req.userPosition)
    if (countsVisibility) {
      const currentAnd = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []
      where.AND = [...currentAnd, countsVisibility]
    }

    const countsCacheKey = `counts:${JSON.stringify(where)}:${assignedOnly ? req.userId : "all"}`
    const cachedCounts = ordersCache.get(countsCacheKey)
    if (cachedCounts) return res.json(cachedCounts)

    const [groups, videoRows] = await Promise.all([
      prisma.translationOrder.groupBy({
        by: ["status"],
        _count: { _all: true },
        where,
      }),
      // Every matching work unit's status + target languages (parents already
      // excluded via where.isParent=false). Videos = sum of target-language
      // counts, both overall (totalVideos) and per status (counts.videos).
      prisma.translationOrder.findMany({
        where,
        select: {
          status: true,
          broadcast: { select: { targetLanguages: true } },
          marketing: { select: { targetLanguages: true } },
        },
      }),
    ])

    const counts = {
      PENDING: 0,
      READY_FOR_TRANSLATION: 0,
      IN_PROGRESS: 0,
      COMPLETED: 0,
      total: 0,
      totalVideos: 0,
      videos: { PENDING: 0, READY_FOR_TRANSLATION: 0, IN_PROGRESS: 0, COMPLETED: 0 },
    }
    for (const g of groups) {
      const key = g.status as keyof typeof counts.videos
      if (key in counts) (counts as any)[key] = g._count._all
      counts.total += g._count._all
    }
    for (const r of videoRows) {
      const langs = r.broadcast?.targetLanguages ?? r.marketing?.targetLanguages ?? []
      counts.totalVideos += langs.length
      const key = r.status as keyof typeof counts.videos
      if (key in counts.videos) counts.videos[key] += langs.length
    }

    ordersCache.set(countsCacheKey, counts, 5_000) // 5s TTL

    return res.json(counts)
  } catch (error) {
    logger.error({ action: "GET_ORDER_COUNTS_ERROR", userId: req.userId, userName: req.userName, err: error })
    return res.status(500).json({ message: "Failed to get order counts" })
  }
}
