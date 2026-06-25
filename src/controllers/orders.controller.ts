// controllers/orders.controller.ts

import type { Response } from "express"

import type {
  AuthRequest,
} from "../middleware/auth.middleware.js"

import { randomUUID } from "node:crypto"
import { prisma } from "../lib/prisma.js"
import { triggerNotifications, getIo } from "../lib/socket.js"
import { notifyTranslatorsSourceReady } from "./notification.controller.js"
import { logger } from "../lib/logger.js"
import { ordersCache } from "../lib/ordersCache.js"
import {
  Prisma,
  DeliveryFormat,
  OrderStatus,
  OrderPriority,
  OrderType,
  EventType,
  UserRole,
  UserPosition,
  UserDepartment,
} from "@prisma/client"

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

  lastEditedAt: true,

  sourceChangedAt: true,

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
      game: {
        select: {
          id: true,
          name: true,
          logo: true,
          tier: true,
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
    deliveries: (d?.deliveries ?? []).map((x: any) => ({ language: x.language, link: x.deliveryLink ?? "" })),
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
    user.position === "TRANSLATOR" ||
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

    const gameId =
      String(
        req.query.gameId || ""
      )

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

if (
  isOrderStatus(status)
) {
  where.status =
    status
}

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

if (gameId) {
  where.broadcast = {
    is: {
      ...(where.broadcast &&
      typeof where.broadcast ===
        "object" &&
      "is" in where.broadcast &&
      where.broadcast.is
        ? where.broadcast.is
        : {}),
      gameId,
    },
  }
}

/*
  TIER FILTER (Broadcast only) — isolate orders whose game is a given tier.
*/
if (tier) {
  const tierNum = Number(tier)
  if (!Number.isNaN(tierNum)) {
    const prevIs =
      where.broadcast &&
      typeof where.broadcast === "object" &&
      "is" in where.broadcast &&
      where.broadcast.is
        ? where.broadcast.is
        : {}
    where.broadcast = { is: { ...prevIs, game: { is: { tier: tierNum } } } }
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
    // its own row even if its parent doesn't match). Structured filters
    // (status / priority / format / game / content title) keep the grouped,
    // collapsible view so parents still show their expand/collapse chevron and
    // sub-orders stay tucked under them.
    const flatten = !!search

    // Only constrain to top-level rows when NOT flattening and not an exact-id lookup.
    if (!orderId && !flatten) {
      where.parentId = null
    }

    const listSelect = flatten ? listOrderSelectFlat : listOrderSelectGrouped
    const mode = flatten ? "flat" : "grouped"

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

    logger.error({ action: "GET_ORDERS_ERROR", userId: req.userId, err: error })

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

    // A TRANSLATOR opening the order clears the "source changed" caution (they've
    // seen the update). Managers viewing it — including the one who just made the
    // change — must NOT clear it, or the flag would vanish before translators see it.
    if ((order as any).sourceChangedAt && req.userId) {
      prisma.user
        .findUnique({ where: { id: req.userId }, select: { position: true } })
        .then((u) => {
          if (u?.position === "TRANSLATOR") {
            return prisma.translationOrder
              .update({ where: { id }, data: { sourceChangedAt: null } })
              .then(() => ordersCache.invalidate())
          }
        })
        .catch(() => {})
    }

    return res.json({ ...order, editHistory })
  } catch (error) {
    logger.error({ action: "GET_ORDER_BY_ID_ERROR", userId: req.userId, orderId: req.params.id, err: error })
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

  const subs = await prisma.translationOrder.findMany({
    where: { parentId },
    select: { status: true },
  })

  if (subs.length === 0) return undefined

  const allCompleted = subs.every((s) => s.status === OrderStatus.COMPLETED)
  const allPending = subs.every((s) => s.status === OrderStatus.PENDING)

  const newStatus = allCompleted
    ? OrderStatus.COMPLETED
    : allPending
    ? OrderStatus.PENDING
    : OrderStatus.IN_PROGRESS

  await prisma.translationOrder.update({
    where: { id: parentId },
    data: {
      status: newStatus,
      ...(newStatus === OrderStatus.COMPLETED
        ? { completedAt: new Date() }
        : { completedAt: null, completedById: null }),
    },
  })

  return newStatus
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
  userId: string
): { data?: any; error?: string } {
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
  } = body

  if (!title?.trim()) {
    return { error: "Title is required" }
  }

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

  const normalizedGame = typeof game === "string" ? game.trim() : ""

  if (orderType === OrderType.BROADCAST && !normalizedGame) {
    return { error: "Game is required" }
  }

  if (event && !isEventType(event)) {
    return { error: "Invalid event" }
  }

  const parsedDeliveries = Array.isArray(deliveries)
    ? deliveries
        .filter((delivery) => typeof delivery?.language === "string")
        .map((delivery: any) => ({
          language: delivery.language,
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

  const data: any = {
    title: title.trim(),

    notes: typeof notes === "string" ? notes.trim() || null : undefined,

    type: orderType,

    event: isEventType(event) ? event : EventType.EWC,

    status: isOrderStatus(status) ? status : OrderStatus.PENDING,

    priority: isOrderPriority(priority) ? priority : OrderPriority.MEDIUM,

    createdById: userId,

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

    logger.info({ action: "CREATE_ORDER", userId: req.userId, orderId: order.id, type: order.type, title: order.title, event: order.event, priority: order.priority })

    ordersCache.invalidate()
    try { getIo()?.emit("order-created", { type: order.type }) } catch {}
    return res.json(order)

  } catch (error) {

    logger.error({ action: "CREATE_ORDER_ERROR", userId: req.userId, err: error })

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
      select: { id: true, isParent: true, type: true, event: true },
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
      }
      const built = buildOrderData(merged, user.id)
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
        priority: d.priority,
        createdById: d.createdById,
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

    logger.info({ action: "CREATE_SUB_ORDERS", userId: req.userId, parentId, count: builts.length })

    ordersCache.invalidate()
    try { getIo()?.emit("order-created", { type: parent.type }) } catch {}

    return res.json(updatedParent)
  } catch (error) {
    logger.error({ action: "CREATE_SUB_ORDERS_ERROR", userId: req.userId, parentId: req.params.id, err: error })
    return res.status(500).json({ message: "Failed to create sub-orders" })
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

    const where: Prisma.TranslationOrderWhereInput = { parentId }

    const cacheKey = `sub-orders:${parentId}:${page}:${limit}`
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
    logger.error({ action: "GET_SUB_ORDERS_ERROR", userId: req.userId, parentId: req.params.id, err: error })
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
      clientLastEditedAt, // ISO string | null | undefined — optimistic concurrency token
    } = req.body

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
      PERMISSIONS
    */

    if (!canManageOrders(user)) {
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
        }
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
                    ? { deadlineDate: new Date(deadline) }
                    : { deadlineDate: null }),
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
    logger.warn({ action: "UPDATE_ORDER_CONFLICT", userId: req.userId, orderId })
    return res.status(409).json({
      message: "This order was recently modified by someone else. Please refresh and try again.",
    })
  }
  if (
    txError instanceof Prisma.PrismaClientKnownRequestError &&
    txError.code === "P2034"
  ) {
    // PostgreSQL serialization failure — two writers hit the exact same row concurrently
    logger.warn({ action: "UPDATE_ORDER_SERIALIZATION_CONFLICT", userId: req.userId, orderId })
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

    if (sourceWasChanged) {

      // Flag the order so the table shows a caution icon for translators who may
      // be working off the old source. Only for real changes, not first-time adds.
      if (sourceIsChange) {
        prisma.translationOrder
          .update({ where: { id: orderId }, data: { sourceChangedAt: new Date() } })
          .then(() => ordersCache.invalidate())
          .catch((e) => logger.error({ action: "SET_SOURCE_CHANGED_ERROR", orderId, err: e }))
      }

      notifyTranslatorsSourceReady(
        orderId,
        sourceIsChange
      ).catch((e) => logger.error({ action: "NOTIFY_TRANSLATORS_ERROR", orderId, err: e }))
    }

    const changes = diffOrders(existingOrder, updatedOrder)
    logger.info({
      action: "UPDATE_ORDER", userId: req.userId, orderId,
      type: updatedOrder?.type, title: updatedOrder?.title,
      changes, sourceChanged: sourceWasChanged,
    })

    ordersCache.invalidate()
    try { getIo()?.emit("order-patched", { id: orderId, type: updatedOrder?.type }) } catch {}
    res.json(updatedOrder)

    // If a sub-order's status changed, roll it up into the parent.
    if (existingOrder.parentId && isOrderStatus(status)) {
      recomputeParentStatus(existingOrder.parentId)
        .then((parentStatus) => {
          ordersCache.invalidate()
          try { getIo()?.emit("order-patched", { id: existingOrder.parentId, type: updatedOrder?.type, status: parentStatus }) } catch {}
        })
        .catch((e) => logger.error({ action: "RECOMPUTE_PARENT_ERROR", parentId: existingOrder.parentId, err: e }))
    }

    return

  } catch (error) {

    logger.error({ action: "UPDATE_ORDER_ERROR", userId: req.userId, orderId: req.params.id, err: error })

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
            isParent: true,
            parentId: true,
            status: true,
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

    logger.info({ action: "UPDATE_ORDER_STATUS", userId: req.userId, orderId, title: existingOrder.title, from: existingOrder.status, to: parsedStatus })

    ordersCache.invalidate()
    try { getIo()?.emit("order-patched", { id: updatedOrder.id, type: updatedOrder.type, status: updatedOrder.status }) } catch {}
    res.json(updatedOrder)

    // If this is a sub-order, roll its status up into the parent.
    if (existingOrder.parentId) {
      recomputeParentStatus(existingOrder.parentId)
        .then((parentStatus) => {
          ordersCache.invalidate()
          try { getIo()?.emit("order-patched", { id: existingOrder.parentId, type: updatedOrder.type, status: parentStatus }) } catch {}
        })
        .catch((e) => logger.error({ action: "RECOMPUTE_PARENT_ERROR", parentId: existingOrder.parentId, err: e }))
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

    logger.error({ action: "UPDATE_ORDER_STATUS_ERROR", userId: req.userId, orderId: req.params.id, err: error })

    return res.status(500).json({
      message:
        "Failed to update status",
    })
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

    logger.error({ action: "MARK_NOTIFICATIONS_READ_ERROR", userId: req.userId, err: error })

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

    logger.info({ action: "ASSIGN_USERS_TO_ORDER", userId: req.userId, orderId, orderTitle: order.title, count: userIds.length, userIds })

    ordersCache.invalidate()
    try { getIo()?.emit("order-patched", { id: orderId, type: order.type }) } catch {}
    return res.json(updatedOrder)

  } catch (error) {

    logger.error({ action: "ASSIGN_USERS_TO_ORDER_ERROR", userId: req.userId, orderId: req.params.id, err: error })

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

    logger.info({ action: "DELETE_ORDER", userId: req.userId, orderId, deleted: orderSnapshot(fullOrder) })

    ordersCache.invalidate()
    try { getIo()?.emit("order-deleted", { id: deleted.id, type: deleted.type }) } catch {}

    // If a sub-order was deleted, recompute the parent's rolled-up status.
    if (deleted.parentId) {
      const parentStatus = await recomputeParentStatus(deleted.parentId)
      ordersCache.invalidate()
      try { getIo()?.emit("order-patched", { id: deleted.parentId, type: deleted.type, status: parentStatus }) } catch {}
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

    logger.error({ action: "DELETE_ORDER_ERROR", userId: req.userId, orderId: req.params.id, err: error })

    return res.status(500).json({
      message:
        "Failed to delete order",
    })
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
    const gameId = String(req.query.gameId || "")
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
      // Count only top-level rows so badge counts match the list.
      where.parentId = null
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

    if (gameId) {
      where.broadcast = {
        is: {
          ...(where.broadcast && typeof where.broadcast === "object" && "is" in where.broadcast && where.broadcast.is
            ? where.broadcast.is
            : {}),
          gameId,
        },
      }
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

    const countsCacheKey = `counts:${JSON.stringify(where)}:${assignedOnly ? req.userId : "all"}`
    const cachedCounts = ordersCache.get(countsCacheKey)
    if (cachedCounts) return res.json(cachedCounts)

    const groups = await prisma.translationOrder.groupBy({
      by: ["status"],
      _count: { _all: true },
      where,
    })

    const counts = { PENDING: 0, IN_PROGRESS: 0, COMPLETED: 0, total: 0 }
    for (const g of groups) {
      const key = g.status as keyof Omit<typeof counts, "total">
      if (key in counts) counts[key] = g._count._all
      counts.total += g._count._all
    }

    ordersCache.set(countsCacheKey, counts, 5_000) // 5s TTL

    return res.json(counts)
  } catch (error) {
    logger.error({ action: "GET_ORDER_COUNTS_ERROR", userId: req.userId, err: error })
    return res.status(500).json({ message: "Failed to get order counts" })
  }
}
