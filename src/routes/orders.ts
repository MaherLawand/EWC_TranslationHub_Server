import express from "express"
import { prisma } from "../lib/prisma.js"

import {
  requireAuth,
  type AuthRequest,
} from "../middleware/auth.middleware.js"

import { requireProducer } from "../middleware/producer.middleware.js"
import { requirePPM } from "../middleware/PPM.middleware.js"
import { requireAdmin } from "../middleware/admin.middleware.js"
import { notifyTranslatorsSourceReady } from "../controllers/notification.controller.js"

const router = express.Router()

router.get("/", async (_, res) => {
  try {
    const orders =
      await prisma.translationOrder.findMany({
        orderBy: {
          dateAdded: "desc",
        },

include: {
  createdBy: true,

  completedBy: true,

  lastEditedBy: true,

  editHistory: {
    orderBy: {
      editedAt: "desc",
    },

    include: {
      editedBy: true,
    },
  },

  broadcast: {
    include: {
      game: {
  include: {
    assignedUsers: {
      include: {
        user: true,
      },
    },
  },
},
      deliveries: true,
    },
  },

  marketing: {
    include: {
      deliveries: true,
    },
  },
},
      })

    res.json(orders)
  } catch (error) {
    console.error(error)

    res.status(500).json({
      message: "Failed to fetch orders",
    })
  }
})

router.post(
  "/",
  requireAuth,
  async (
    req: AuthRequest,
    res
  ) => {
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

      const user =
        await prisma.user.findUnique({
          where: {
            id: req.userId,
          },
        })

      if (!user) {
        return res.status(404).json({
          message: "User not found",
        })
      }
      const canCreate =
  user.role === "ADMIN" ||
  user.position ===
    "PRODUCER" ||
  user.position ===
    "POST_PRODUCTION_MANAGER"
if (!canCreate) {
  return res.status(403).json({
    message:
  "Unauthorized",
  })
}

      const orderType =
        type === "Marketing"
          ? "MARKETING"
          : "BROADCAST"

      const order =
        await prisma.translationOrder.create(
          {
            data: {
              title,

              description,

              type: orderType,
                status: status || "PENDING",
                priority: priority || "MEDIUM",

              createdBy: {
                connect: {
                  id: user.id,
                },
              },

              ...(orderType ===
              "BROADCAST"
                ? {
                    broadcast: {
                      create: {
                        estimatedMinutes,

                        sourceLanguage,

                        targetLanguages,

                        deliveries: {
  create:
    deliveries?.map(
      (delivery: any) => ({
        language:
          delivery.language,

        deliveryLink:
          delivery.deliveryLink || "",
      })
    ) || [],
},

                        deliveryFormat:
                          format,

                        sourceFileLink,

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

                        game: game
                          ? {
                              connectOrCreate:
                                {
                                  where:
                                    {
                                      name:
                                        game,
                                    },

                                  create:
                                    {
                                      name:
                                        game,
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
    contentTitle,
    sourceLanguage,

    targetLanguages,

    sourceFileLink,

    deliveryFormat:
      format,

deliveries: {
  create:
    deliveries?.map(
      (delivery: any) => ({
        language:
          delivery.language,

        deliveryLink:
          delivery.deliveryLink || "",
      })
    ) || [],
},
  },
},
                  }),
            },

            include: {
              createdBy: true,

              broadcast: {
                include: {
                  game: {
  include: {
    assignedUsers: {
      include: {
        user: true,
      },
    },
  },
},

                  deliveries: true,
                },
              },

                        marketing: {
  include: {
    deliveries: true,
  },
},
            },
          }
        )
if (sourceFileLink) {

  await notifyTranslatorsSourceReady(
    order.id
  )
}


      res.json(order)
    } catch (error) {
      console.error(error)

      res.status(500).json({
        message:
          "Failed to create order",
      })
    }
  }
)

router.patch(
  "/:id",
  requireAuth,
  async (req: AuthRequest, res) => {
    try {
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


if (!req.userId) {
  return res.status(401).json({
    message: "Unauthorized",
  })
}


      const user =
        await prisma.user.findUnique({
          where: {
            id: req.userId,
          },
        })

      if (!user) {
        return res.status(404).json({
          message: "User not found",
        })
      }
      const canUpdate =
  user.role === "ADMIN" ||
  user.position ===
    "PRODUCER" ||
  user.position ===
    "POST_PRODUCTION_MANAGER"
if (!canUpdate) {
  return res.status(403).json({
    message:
  "Unauthorized",
  })
}


      const orderType =
        type === "Marketing"
          ? "MARKETING"
          : "BROADCAST"

const existingOrder =
  await prisma.translationOrder.findUnique({
    where: {
      id: String(req.params.id),
    },

    include: {
      broadcast: true,
    },
  })

      await prisma.translationOrder.update(
        {
          where: {
            id: String(req.params.id),
          },

          data: {
            title,

            description,

            status,

              priority,

            type: orderType,

            lastEditedById: user.id,

lastEditedAt: new Date(),

editHistory: {
  create: {
    editedById: user.id,
  },
},

            ...(orderType ===
            "BROADCAST"
              ? {
                  broadcast: {
                    update: {
                      estimatedMinutes,

                      sourceLanguage,

                      targetLanguages,

                      deliveryFormat:
                        format,

                      sourceFileLink,

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
                                where:
                                  {
                                    name:
                                      game,
                                  },

                                create:
                                  {
                                    name:
                                      game,
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
    contentTitle,
    sourceLanguage,

    targetLanguages,

    sourceFileLink,

    deliveryFormat:
      format,
  },
},
                }),
          },
        }
      )

    const sourceWasChanged =
  existingOrder?.broadcast?.sourceFileLink !==
  sourceFileLink
if (sourceWasChanged) {
  await notifyTranslatorsSourceReady(
    String(req.params.id)
  )
}

/* UPDATE + CREATE DELIVERY LINKS */
if (
  deliveries &&
  Array.isArray(deliveries)
) {

  if (orderType === "BROADCAST") {

    const broadcast =
      await prisma.broadcastDetails.findFirst(
        {
          where: {
            orderId: String(
              req.params.id
            ),
          },
        }
      )

    if (broadcast) {

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
                      delivery.deliveryLink,
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
                    delivery.deliveryLink,

                  broadcastId:
                    broadcast.id,
                },
              }
            )
          }
        )
      )
    }
  }

  if (orderType === "MARKETING") {

    const marketing =
      await prisma.marketingDetails.findFirst(
        {
          where: {
            orderId: String(
              req.params.id
            ),
          },
        }
      )

    if (marketing) {

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
                      delivery.deliveryLink,
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
                    delivery.deliveryLink,

                  marketingId:
                    marketing.id,
                },
              }
            )
          }
        )
      )
    }
  }
}

      const updatedOrder =
        await prisma.translationOrder.findUnique(
          {
            where: {
              id: String(req.params.id),
            },

include: {
  createdBy: true,

  completedBy: true,

  lastEditedBy: true,

  editHistory: {
    orderBy: {
      editedAt: "desc",
    },

    include: {
      editedBy: true,
    },
  },

  broadcast: {
    include: {
      game: {
  include: {
    assignedUsers: {
      include: {
        user: true,
      },
    },
  },
},

      deliveries: true,
    },
  },

  marketing: {
    include: {
      deliveries: true,
    },
  },
},
          }
        )

      res.json(updatedOrder)
    } catch (error) {
      console.error(error)

      res.status(500).json({
        message:
          "Failed to update order",
      })
    }
  }
)

router.patch(
  "/:id/status",
  requireAuth,
  async (
    req: AuthRequest,
    res
  ) => {
    try {
      const { status } =
        req.body

      const user =
        await prisma.user.findUnique({
          where: {
            id: req.userId,
          },
        })

      if (!user) {
        return res.status(404).json({
          message: "User not found",
        })
      }

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

      const existingOrder =
        await prisma.translationOrder.findUnique(
          {
            where: {
              id: String(
                req.params.id
              ),
            },

          include: {
  createdBy: true,

  completedBy: true,

  lastEditedBy: true,

  editHistory: {
    orderBy: {
      editedAt: "desc",
    },

    include: {
      editedBy: true,
    },
  },

  broadcast: {
    include: {
      game: {
        include: {
          assignedUsers: {
            include: {
              user: true,
            },
          },
        },
      },

      deliveries: true,
    },
  },

  marketing: {
    include: {
      deliveries: true,
    },
  },
},
          }
        )

      if (!existingOrder) {
        return res.status(404).json({
          message:
            "Order not found",
        })
      }

      const updateData: any = {
        status,
      }

      // MARK COMPLETED
      if (status === "COMPLETED") {
        updateData.completedById =
          user.id

        updateData.completedAt =
          new Date()
      }

      // RESET IF NOT COMPLETED
      if (status !== "COMPLETED") {
        updateData.completedById =
          null

        updateData.completedAt =
          null
      }

      const updatedOrder =
        await prisma.translationOrder.update(
          {
            where: {
              id: String(
                req.params.id
              ),
            },

            data: updateData,

            include: {
              createdBy: true,

              completedBy: true,

              broadcast: {
                include: {
                  game: {
                    include: {
                      assignedUsers: {
                        include: {
                          user: true,
                        },
                      },
                    },
                  },

                  deliveries: true,
                },
              },

              marketing: {
                include: {
                  deliveries: true,
                },
              },
            },
          }
        )

      // CREATE NOTIFICATIONS
      if (status === "COMPLETED") {

        let notifyUsers: any[] =
          []

        // BROADCAST
        // BROADCAST
if (
  updatedOrder.broadcast?.game
) {

  const assignedUsers =
    updatedOrder.broadcast.game.assignedUsers.map(
      (a: any) => a.user
    )

  const admins =
    await prisma.user.findMany({
      where: {
        role: "ADMIN",
      },
    })

  notifyUsers = [
    ...assignedUsers.filter(
      (u: any) =>
        u.position ===
          "PRODUCER" ||
        u.position ===
          "POST_PRODUCTION_MANAGER"
    ),

    ...admins,
  ]
}

        // MARKETING
        if (
          updatedOrder.type ===
          "MARKETING"
        ) {

          const admins =
            await prisma.user.findMany(
              {
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
              }
            )

          notifyUsers = admins
        }

        // REMOVE DUPLICATES
        const uniqueUsers =
          notifyUsers.filter(
            (
              notifyUser,
              index,
              self
            ) =>
              index ===
              self.findIndex(
                (u) =>
                  u.id ===
                  notifyUser.id
              )
          )

        if (
          uniqueUsers.length > 0
        ) {

          await prisma.notification.createMany(
            {
              data: uniqueUsers.map(
                (
                  notifyUser: any
                ) => ({
                  title:
                    "Order Completed",

                  message: `${
                    updatedOrder.title
                  } has been marked as completed by ${
                    user.firstName
                  } ${
                    user.lastName
                  }`,

                  type:
                    "ORDER_COMPLETED",

                  userId:
                    notifyUser.id,

                  orderId:
                    updatedOrder.id,
                })
              ),
            }
          )
        }
      }

      res.json(updatedOrder)

    } catch (error) {
      console.error(error)

      res.status(500).json({
        message:
          "Failed to update status",
      })
    }
  }
)

router.patch(
  "/notifications/read",
  requireAuth,
  async (
    req: AuthRequest,
    res
  ) => {
    try {
      await prisma.notification.updateMany(
        {
          where: {
            userId:
              req.userId,

            isRead: false,
          },

          data: {
            isRead: true,
          },
        }
      )

      return res.json({
        success: true,
      })

    } catch (error) {
      console.error(error)

      return res.status(500).json({
        message:
          "Failed to mark notifications as read",
      })
    }
  }
)

router.delete(
  "/:id",

  requireAuth,

  async (
    req: AuthRequest,
    res
  ) => {
    try {
      const user =
        await prisma.user.findUnique({
          where: {
            id: req.userId,
          },
        })

      if (!user) {
        return res.status(404).json({
          message: "User not found",
        })
      }
      const canDelete =
  user.role === "ADMIN" ||
  user.position ===
    "PRODUCER" ||
  user.position ===
    "POST_PRODUCTION_MANAGER"
if (!canDelete) {
  return res.status(403).json({
    message:
  "Unauthorized",
  })
}


      const orderId = String(
  req.params.id
)

      const existingOrder =
        await prisma.translationOrder.findUnique(
          {
            where: {
              id: orderId,
            },
          }
        )

      if (!existingOrder) {
        return res.status(404).json({
          message:
            "Order not found",
        })
      }

      await prisma.translationOrder.delete(
        {
          where: {
            id: orderId,
          },
        }
      )

      res.json({
        success: true,
      })

    } catch (error) {
      console.error(error)

      res.status(500).json({
        message:
          "Failed to delete order",
      })
    }
  }
)

export default router