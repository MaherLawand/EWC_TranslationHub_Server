// controllers/orders.controller.ts

import type { Response } from "express"

import type {
  AuthRequest,
} from "../middleware/auth.middleware.js"

import { prisma } from "../lib/prisma.js"
import { triggerNotifications } from "../lib/socket.js"
import { notifyTranslatorsSourceReady } from "./notification.controller.js"
import type { Prisma } from "@prisma/client"
import {
  DeliveryFormat,
  OrderStatus,
  OrderPriority,
  OrderType,
  EventType,
  UserRole,
  UserPosition,
  UserDepartment,
} from "@prisma/client"

const listOrderSelect = {
  id: true,
  type: true,
  title: true,
  status: true,
  priority: true,
  dateAdded: true,
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
    user.position ===
      "TRANSLATOR"
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

    const contentTitle =
      String(
        req.query.contentTitle || ""
      )

    const deadlineSort =
      String(
        req.query.deadlineSort || ""
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

    let orderBy:
  Prisma.TranslationOrderOrderByWithRelationInput =
{
  dateAdded: "desc",
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

        select: listOrderSelect,
      }),

      prisma.translationOrder.count({
        where,
      }),
    ])

    /*
      RESPONSE
    */

    return res.json({
      orders,

      total,

      page,

      limit,

      totalPages:
        Math.ceil(
          total / limit
        ),
    })

  } catch (error) {

    console.error(
      "GET ORDERS ERROR:",
      error
    )

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

    return res.json({ ...order, editHistory })
  } catch (error) {
    console.error("GET ORDER BY ID ERROR:", error)
    return res.status(500).json({ message: "Failed to fetch order" })
  }
}

export async function createOrder(
  req: AuthRequest,
  res: Response
) {
  try {

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
      deliveryFormats,
      deliveries,
      sourceFileLink,
      srtAvailableLink,
      deliveryDate,
      deadline,
    } = req.body

    /*
      BASIC VALIDATION
    */

    if (!title?.trim()) {
      return res.status(400).json({
        message: "Title is required",
      })
    }

    if (!isStringArray(sourceLanguage)) {
      return res.status(400).json({
        message:
          "Source language must be an array",
      })
    }
    if (
  deliveryFormats &&
  !Array.isArray(
    deliveryFormats
  )
) {
  return res.status(400).json({
    message:
      "Delivery formats must be an array",
  })
}

const parsedEstimatedMinutes =
  Number(estimatedMinutes)
if (
  Number.isNaN(parsedEstimatedMinutes)
) {
  return res.status(400).json({
    message:
      "Estimated minutes must be a number",
  })
}

    if (!isStringArray(targetLanguages)){
      return res.status(400).json({
        message:
          "Target languages must be an array",
      })
    }



    /*
      USER
    */

    const user =
      await prisma.user.findUnique({
        where: {
          id: req.userId,
        },

        select: {
          id: true,

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
      ORDER TYPE
    */

const orderType: OrderType =
  type === OrderType.MARKETING
    ? OrderType.MARKETING
    : OrderType.BROADCAST


const normalizedGame =
  typeof game === "string"
    ? game.trim()
    : ""

if (
  orderType === OrderType.BROADCAST &&
  !normalizedGame
) {
  return res.status(400).json({
    message: "Game is required",
  })
}

if (event && !isEventType(event)){
  return res.status(400).json({
    message: "Invalid event",
  })
}

    /*
      CLEAN DELIVERIES
    */

    const parsedDeliveries =
  Array.isArray(deliveries)
    ? deliveries
        .filter(
          (delivery) =>
            typeof delivery?.language ===
            "string"
        )
        .map(
            (delivery: any) => ({
              language:
                delivery.language,

              deliveryLink:
                delivery.deliveryLink ||
                "",
            })
          )
        : []

    /*
      CREATE ORDER
    */

    const order =
      await prisma.translationOrder.create({
        data: {
          title: title.trim(),

          notes:
  typeof notes === "string"
    ? notes.trim() || null
    : undefined,

          type: orderType,

          event:
  isEventType(event)
    ? event
    : EventType.EWC,

          status:
isOrderStatus(status)
    ? status
    : OrderStatus.PENDING,

          priority:
isOrderPriority(priority)
    ? priority
    : OrderPriority.MEDIUM,

          createdById: user.id,

          ...(orderType ===
          "BROADCAST"
            ? {
                broadcast: {
                  create: {
                    estimatedMinutes:parsedEstimatedMinutes,

                    sourceLanguage,

                    targetLanguages,

                    deliveryFormats: {
  create:
    Array.isArray(
      deliveryFormats
    )
      ? deliveryFormats.map(
          (item: any) => ({
            format: isDeliveryFormat(
  item.format
)
  ? item.format
  : DeliveryFormat.SRT,

            deliveryLink:
              item.deliveryLink ||
              "",
          })
        )
      : [],
},

                    sourceFileLink:
                      sourceFileLink ||
                      "",

                    srtAvailableLink:
                      typeof srtAvailableLink === "string"
                        ? srtAvailableLink.trim() || null
                        : null,

                    deliveryDate:
                      deliveryDate
                        ? new Date(
                            deliveryDate
                          )
                        : new Date(),

                    deadlineDate:
                      deadline
                        ? new Date(
                            deadline
                          )
                        : new Date(),

                    deliveries: {
                      create:
                        parsedDeliveries,
                    },

                    game: {
                      connect: {
                        id: normalizedGame,
                      },
                    }
                  },
                },
              }
            : {
                marketing: {
                  create: {
                    contentTitle:
  typeof contentTitle ===
  "string"
    ? contentTitle.trim() ||
      null
    : undefined,

                    sourceLanguage,

                    targetLanguages,

                    sourceFileLink:typeof sourceFileLink === "string"
  ? sourceFileLink
  : undefined,

                    srtAvailableLink:
                      typeof srtAvailableLink === "string"
                        ? srtAvailableLink.trim() || null
                        : null,

                    deadlineDate:
                      deadline
                        ? new Date(deadline)
                        : null,

                   deliveryFormats: {
  create:
    Array.isArray(
      deliveryFormats
    )
      ? deliveryFormats.map(
          (item: any) => ({
            format: isDeliveryFormat(
  item.format
)
  ? item.format
  : DeliveryFormat.SRT,

            deliveryLink:
              item.deliveryLink ||
              "",
          })
        )
      : [],
},

                    deliveries: {
                      create:
                        parsedDeliveries,
                    },
                  },
                },
              }),
        },

        select:orderSelect,
      })

    /*
      NOTIFICATIONS
    */

    if (sourceFileLink) {

      notifyTranslatorsSourceReady(
        order.id
      ).catch(console.error)
    }

    return res.json(order)

  } catch (error) {

    console.error(
      "CREATE ORDER ERROR:",
      error
    )

    return res.status(500).json({
      message:
        "Failed to create order",
    })
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
      deliveryFormats,
      sourceFileLink,
      srtAvailableLink,
      deliveryDate,
      deadline,
      deliveries,
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
        select: {
          id: true,
          type: true,
          event: true,
          broadcast: { select: { id: true, sourceFileLink: true } },
          marketing: { select: { id: true } },
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

    /*
      UPDATE ORDER
    */
const updatedOrder = await prisma.$transaction(async (tx) => {

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

        ...(isOrderStatus(status)
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
})


    /*
      SOURCE FILE CHANGED
    */

const sourceWasChanged =
  orderType === "BROADCAST" &&
  existingOrder.broadcast
    ?.sourceFileLink !==
  sourceFileLink

    if (sourceWasChanged) {

      notifyTranslatorsSourceReady(
        orderId
      ).catch(console.error)
    }

    return res.json(updatedOrder)

  } catch (error) {

    console.error(
      "UPDATE ORDER ERROR:",
      error
    )

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
            firstName: true,
            lastName: true,
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
            createdById: true,

            broadcast: {
              select: {
                game: {
                  select: {
                    assignedUsers: {
                      select: {
                        user: {
                          select: {
                            id: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },

            marketing: {
              select: {
                assignments: {
                  select: {
                    userId: true,
                  },
                },
              },
            },
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

    /*
      UPDATE DATA
    */

    const parsedStatus =
 isOrderStatus(status)
    ? status
    : OrderStatus.PENDING

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

        select: orderSelect,
      })

    /*
      RESPOND IMMEDIATELY — notifications fire in the background
    */

    res.json(updatedOrder)

    /*
      NOTIFICATIONS (fire-and-forget — response already sent)
    */

    if (parsedStatus === OrderStatus.COMPLETED) {

      let notifyUserIds: string[] = []

      /*
        BROADCAST — game-assigned users + order creator
      */

      if (existingOrder.broadcast?.game) {
        const gameUserIds =
          existingOrder.broadcast.game.assignedUsers
            .map((a) => a.user.id)

        notifyUserIds = [...gameUserIds]
      }

      /*
        MARKETING — order-assigned users + order creator
      */

      if (existingOrder.type === "MARKETING") {
        const assignedUserIds =
          existingOrder.marketing?.assignments
            .map((a) => a.userId) ?? []

        notifyUserIds = [...assignedUserIds]
      }

      // Always include the order creator
      if (existingOrder.createdById) {
        notifyUserIds.push(existingOrder.createdById)
      }

      /*
        REMOVE DUPLICATES
      */

      const uniqueUserIds = [...new Set(notifyUserIds)]

      /*
        CREATE NOTIFICATIONS
      */

      if (uniqueUserIds.length > 0) {
        // Atomic check-then-create: only create notifications if none
        // already exist for this completion event, preventing duplicates
        // from concurrent status-update requests on the same order.
        prisma.$transaction(async (tx) => {
          const already = await tx.notification.count({
            where: { orderId: updatedOrder.id, type: "ORDER_COMPLETED" },
          })
          if (already > 0) return

          const created = await tx.notification.createManyAndReturn({
            data: uniqueUserIds.map((userId) => ({
              title: "Order Completed",
              message: `${updatedOrder.title} has been marked as completed by ${user.firstName} ${user.lastName}`,
              type: "ORDER_COMPLETED",
              userId,
              orderId: updatedOrder.id,
            })),
            include: {
              order: { select: { id: true, title: true } },
            },
          })

          if (created.length > 0) {
            triggerNotifications(created).catch(console.error)
          }
        }).catch(console.error)
      }
    }

  } catch (error) {

    console.error(
      "UPDATE STATUS ERROR:",
      error
    )

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

    console.error(
      "MARK NOTIFICATIONS READ ERROR:",
      error
    )

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
      triggerNotifications(createdNotifications).catch(console.error)
    }

    /*
      RETURN UPDATED ORDER
    */

    const updatedOrder =
      await prisma.translationOrder.findUnique({
        where: { id: orderId },
        select: orderSelect,
      })

    return res.json(updatedOrder)

  } catch (error) {

    console.error(
      "ASSIGN USERS ERROR:",
      error
    )

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

    await prisma.translationOrder.delete({
      where: {
        id: orderId,
      },
    })

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

    console.error(
      "DELETE ORDER ERROR:",
      error
    )

    return res.status(500).json({
      message:
        "Failed to delete order",
    })
  }
}


