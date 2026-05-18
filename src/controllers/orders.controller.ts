// controllers/orders.controller.ts

import type { Response,Request } from "express"

import type {
  AuthRequest,
} from "../middleware/auth.middleware.js"

import { prisma } from "../lib/prisma.js"
import { notifyTranslatorsSourceReady } from "./notification.controller.js"

export async function getOrders(
  req: AuthRequest,
  res: Response
) {
  try {

    /*
      PAGINATION
    */

    const page =
      Number(req.query.page) || 1

    const limit =
      Number(req.query.limit) || 50

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

    const format =
      String(
        req.query.format || ""
      )

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

    /*
      WHERE
    */

    const where: any = {}

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
          description: {
            contains: search,
            mode: "insensitive",
          },
        },

        {
          marketing: {
            contentTitle: {
              contains: search,
              mode: "insensitive",
            },
          },
        },
      ]
    }

    /*
      STATUS
    */

    if (status) {
      where.status = status
    }

    /*
      PRIORITY
    */

    if (priority) {
      where.priority = priority
    }

    /*
      TYPE
    */

    if (type) {
      where.type = type
    }

    /*
      FORMAT
    */

    if (format) {

      where.AND = [
        ...(where.AND || []),

        {
          OR: [
            {
              broadcast: {
                deliveryFormat:
                  format,
              },
            },

            {
              marketing: {
                deliveryFormat:
                  format,
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
        ...(where.broadcast || {}),

        gameId,
      }
    }

    /*
      CONTENT TITLE
    */

    if (contentTitle) {

      where.marketing = {
        ...(where.marketing || {}),

        contentTitle: {
          equals: contentTitle,
          mode: "insensitive",
        },
      }
    }

    /*
      ORDER BY
    */

    let orderBy: any = {
      dateAdded: "desc",
    }

    /*
      DEADLINE SORT
    */

    if (deadlineSort === "ASC") {

      orderBy = {
        broadcast: {
          deadlineDate: "asc",
        },
      }
    }

    if (deadlineSort === "DESC") {

      orderBy = {
        broadcast: {
          deadlineDate: "desc",
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

  where.broadcast = {
    ...(where.broadcast || {}),

    game: {
      assignedUsers: {
        some: {
          userId: req.userId,
        },
      },
    },
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

        select: {
          id: true,

          type: true,

          title: true,

          description: true,

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

          editHistory: {
            take: 10,

            orderBy: {
              editedAt: "desc",
            },

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
          },

          broadcast: {
            select: {
              id: true,

              gameId: true,

              estimatedMinutes: true,

              sourceLanguage: true,

              targetLanguages: true,

              deliveryFormat: true,

              sourceFileLink: true,

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

              deliveryFormat: true,

              deliveries: {
                select: {
                  id: true,

                  language: true,

                  deliveryLink: true,
                },
              },
            },
          },
        },
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
export async function createOrder(
  req: AuthRequest,
  res: Response
) {
  try {

    const {
      title,
      description,
      type,
      status,
      priority,
      game,
      estimatedMinutes,
      sourceLanguage,
      targetLanguages,
      contentTitle,
      format,
      deliveries,
      sourceFileLink,
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

    if (!Array.isArray(sourceLanguage)) {
      return res.status(400).json({
        message:
          "Source language must be an array",
      })
    }

    if (
      !Array.isArray(targetLanguages)
    ) {
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

    const canCreate =
      user.role === "ADMIN" ||

      user.position ===
        "PRODUCER" ||

      user.position ===
        "POST_PRODUCTION_MANAGER"

    if (!canCreate) {
      return res.status(403).json({
        message: "Unauthorized",
      })
    }

    /*
      ORDER TYPE
    */

    const orderType =
      type === "Marketing"
        ? "MARKETING"
        : "BROADCAST"

    /*
      CLEAN DELIVERIES
    */

    const parsedDeliveries =
      Array.isArray(deliveries)
        ? deliveries.map(
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

          description:
            description?.trim() || null,

          type: orderType,

          status:
            status || "PENDING",

          priority:
            priority || "MEDIUM",

          createdById: user.id,

          ...(orderType ===
          "BROADCAST"
            ? {
                broadcast: {
                  create: {
                    estimatedMinutes:
                      Number(
                        estimatedMinutes
                      ) || 0,

                    sourceLanguage,

                    targetLanguages,

                    deliveryFormat:
                      format,

                    sourceFileLink:
                      sourceFileLink ||
                      "",

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

                    game: game
                      ? {
                          connectOrCreate:
                            {
                              where: {
                                name:
                                  game.trim(),
                              },

                              create: {
                                name:
                                  game.trim(),
                              },
                            },
                        }
                      : undefined,
                  },
                },
              }
            : {
                marketing: {
                  create: {
                    contentTitle:
                      contentTitle?.trim() ||
                      null,

                    sourceLanguage,

                    targetLanguages,

                    sourceFileLink:
                      sourceFileLink ||
                      "",

                    deliveryFormat:
                      format,

                    deliveries: {
                      create:
                        parsedDeliveries,
                    },
                  },
                },
              }),
        },

        select: {
          id: true,

          type: true,

          title: true,

          description: true,

          status: true,

          priority: true,

          dateAdded: true,

          createdBy: {
            select: {
              id: true,

              firstName: true,

              lastName: true,

              role: true,

              position: true,
            },
          },

          broadcast: {
            select: {
              id: true,

              estimatedMinutes: true,

              sourceLanguage: true,

              targetLanguages: true,

              deliveryFormat: true,

              sourceFileLink: true,

              deliveryDate: true,

              deadlineDate: true,

              game: {
                select: {
                  id: true,

                  name: true,

                  logo: true,
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

              deliveryFormat: true,

              deliveries: {
                select: {
                  id: true,

                  language: true,

                  deliveryLink: true,
                },
              },
            },
          },
        },
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
      description,
      status,
      priority,
      type,
      game,
      estimatedMinutes,
      sourceLanguage,
      targetLanguages,
      contentTitle,
      format,
      sourceFileLink,
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

    const canUpdate =
      user.role === "ADMIN" ||

      user.position ===
        "PRODUCER" ||

      user.position ===
        "POST_PRODUCTION_MANAGER"

    if (!canUpdate) {
      return res.status(403).json({
        message: "Unauthorized",
      })
    }

    /*
      EXISTING ORDER
    */

    const existingOrder =
      await prisma.translationOrder.findUnique({
        where: {
          id: orderId,
        },

        select: {
          id: true,

          type: true,

          broadcast: {
            select: {
              id: true,

              sourceFileLink: true,
            },
          },

          marketing: {
            select: {
              id: true,
            },
          },
        },
      })

    if (!existingOrder) {
      return res.status(404).json({
        message:
          "Order not found",
      })
    }

    /*
      ORDER TYPE
    */

    const orderType =
      type === "Marketing"
        ? "MARKETING"
        : "BROADCAST"

    /*
      UPDATE ORDER
    */

    await prisma.translationOrder.update({
      where: {
        id: orderId,
      },

      data: {
        title:
          title?.trim(),

        description:
          description?.trim() ||
          null,

        status,

        priority,

        type: orderType,

        lastEditedById:
          user.id,

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
                  estimatedMinutes:
                    Number(
                      estimatedMinutes
                    ) || 0,

                  sourceLanguage,

                  targetLanguages,

                  deliveryFormat:
                    format,

                  sourceFileLink:
                    sourceFileLink ||
                    "",

                  deliveryDate:
                    deliveryDate
                      ? new Date(
                          deliveryDate
                        )
                      : undefined,

                  deadlineDate:
                    deadline
                      ? new Date(
                          deadline
                        )
                      : undefined,

                  game: game
                    ? {
                        connectOrCreate:
                          {
                            where: {
                              name:
                                game.trim(),
                            },

                            create: {
                              name:
                                game.trim(),
                            },
                          },
                      }
                    : undefined,
                },
              },
            }
          : {
              marketing: {
                update: {
                  contentTitle:
                    contentTitle?.trim() ||
                    null,

                  sourceLanguage,

                  targetLanguages,

                  sourceFileLink:
                    sourceFileLink ||
                    "",

                  deliveryFormat:
                    format,
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

        await Promise.all(
          deliveries.map(
            (delivery: any) => {

              if (delivery.id) {

                return prisma.translationDelivery.update(
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

              return prisma.translationDelivery.create(
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

        await Promise.all(
          deliveries.map(
            (delivery: any) => {

              if (delivery.id) {

                return prisma.marketingDelivery.update(
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

              return prisma.marketingDelivery.create(
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
      SOURCE FILE CHANGED
    */

    const sourceWasChanged =
      existingOrder
        ?.broadcast
        ?.sourceFileLink !==
      sourceFileLink

    if (sourceWasChanged) {

      notifyTranslatorsSourceReady(
        orderId
      ).catch(console.error)
    }

    /*
      RETURN UPDATED ORDER
    */

    const updatedOrder =
      await prisma.translationOrder.findUnique({
        where: {
          id: orderId,
        },

        select: {
          id: true,

          type: true,

          title: true,

          description: true,

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

          editHistory: {
            take: 10,

            orderBy: {
              editedAt: "desc",
            },

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
          },

          broadcast: {
            select: {
              id: true,

              gameId: true,

              estimatedMinutes: true,

              sourceLanguage: true,

              targetLanguages: true,

              deliveryFormat: true,

              sourceFileLink: true,

              deliveryDate: true,

              deadlineDate: true,

              game: {
                select: {
                  id: true,

                  name: true,

                  logo: true,
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

              deliveryFormat: true,

              deliveries: {
                select: {
                  id: true,

                  language: true,

                  deliveryLink: true,
                },
              },
            },
          },
        },
      })

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

    /*
      VALIDATION
    */

    const validStatuses = [
      "PENDING",
      "IN_PROGRESS",
      "COMPLETED",
    ]

    if (
      !validStatuses.includes(
        status
      )
    ) {
      return res.status(400).json({
        message:
          "Invalid status",
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
          firstName: true,
          lastName: true,
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

    const canUpdate =
      user.role === "ADMIN" ||

      user.position ===
        "PRODUCER" ||

      user.position ===
        "POST_PRODUCTION_MANAGER" ||

      user.position ===
        "TRANSLATOR"

    if (!canUpdate) {
      return res.status(403).json({
        message: "Unauthorized",
      })
    }

    /*
      EXISTING ORDER
    */

    const existingOrder =
      await prisma.translationOrder.findUnique({
        where: {
          id: orderId,
        },

        select: {
          id: true,
          title: true,
          type: true,

          broadcast: {
            select: {
              game: {
                select: {
                  assignedUsers: {
                    select: {
                      user: {
                        select: {
                          id: true,
                          role: true,
                          position: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      })

    if (!existingOrder) {
      return res.status(404).json({
        message:
          "Order not found",
      })
    }

    /*
      UPDATE DATA
    */

    const updateData: any = {
      status,
    }

    if (status === "COMPLETED") {

      updateData.completedById =
        user.id

      updateData.completedAt =
        new Date()

    } else {

      updateData.completedById =
        null

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

        select: {
          id: true,

          type: true,

          title: true,

          status: true,

          priority: true,

          completedAt: true,

          createdAt: true,

          createdBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },

          completedBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },

          /*
            BROADCAST
          */

          broadcast: {
            select: {
              id: true,

              sourceLanguage: true,

              targetLanguages: true,

              deliveryFormat: true,

              estimatedMinutes: true,

              sourceFileLink: true,

              deliveryDate: true,

              deadlineDate: true,

              gameId: true,

              game: {
                select: {
                  id: true,

                  name: true,

                  logo: true,

                  assignedUsers: {
                    select: {
                      user: {
                        select: {
                          id: true,
                          firstName: true,
                          lastName: true,
                          role: true,
                          position: true,
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

          /*
            MARKETING
          */

          marketing: {
            select: {
              id: true,

              contentTitle: true,

              sourceFileLink: true,

              deliveryDate: true,

              deadlineDate: true,

              wordCount: true,

              deliveryFormat: true,

              deliveries: {
                select: {
                  id: true,
                  language: true,
                  deliveryLink: true,
                },
              },
            },
          },
        },
      })

    /*
      NOTIFICATIONS
    */

    if (status === "COMPLETED") {

      let notifyUsers: {
        id: string
      }[] = []

      /*
        BROADCAST
      */

      if (
        existingOrder
          .broadcast?.game
      ) {

        const assignedUsers =
          existingOrder.broadcast.game.assignedUsers
            .map(
              (a) => a.user
            )
            .filter(
              (u) =>
                u.position ===
                  "PRODUCER" ||

                u.position ===
                  "POST_PRODUCTION_MANAGER"
            )

        const admins =
          await prisma.user.findMany({
            where: {
              role: "ADMIN",
            },

            select: {
              id: true,
            },
          })

        notifyUsers = [
          ...assignedUsers,
          ...admins,
        ]
      }

      /*
        MARKETING
      */

      if (
        existingOrder.type ===
        "MARKETING"
      ) {

        notifyUsers =
          await prisma.user.findMany({
            where: {
              OR: [
                {
                  role:
                    "ADMIN",
                },

                {
                  position:
                    "PRODUCER",
                },

                {
                  position:
                    "POST_PRODUCTION_MANAGER",
                },
              ],
            },

            select: {
              id: true,
            },
          })
      }

      /*
        REMOVE DUPLICATES
      */

      const uniqueUserIds =
        [
          ...new Set(
            notifyUsers.map(
              (u) => u.id
            )
          ),
        ]

      /*
        CREATE NOTIFICATIONS
      */

      if (
        uniqueUserIds.length > 0
      ) {

        prisma.notification.createMany({
          data:
            uniqueUserIds.map(
              (userId) => ({
                title:
                  "Order Completed",

                message: `${updatedOrder.title} has been marked as completed by ${user.firstName} ${user.lastName}`,

                type:
                  "ORDER_COMPLETED",

                userId,

                orderId:
                  updatedOrder.id,
              })
            ),
        }).catch(console.error)
      }
    }

    return res.json(
      updatedOrder
    )

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

    const canDelete =
      user.role === "ADMIN" ||

      user.position ===
        "PRODUCER" ||

      user.position ===
        "POST_PRODUCTION_MANAGER"

    if (!canDelete) {
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


