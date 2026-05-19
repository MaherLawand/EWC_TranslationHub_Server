import Pusher from "pusher"

export const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID!,
  key: process.env.PUSHER_KEY!,
  secret: process.env.PUSHER_SECRET!,
  cluster: process.env.PUSHER_CLUSTER!,
  useTLS: true,
})

export async function triggerNotifications(
  notifications: {
    id: string
    userId: string
    title: string
    message: string
    type: string
    isRead: boolean
    createdAt: Date
    order: { id: string; title: string } | null
  }[]
) {
  await Promise.all(
    notifications.map((n) =>
      pusher
        .trigger(`private-user-${n.userId}`, "new-notification", {
          id: n.id,
          title: n.title,
          message: n.message,
          type: n.type,
          isRead: n.isRead,
          createdAt: n.createdAt,
          order: n.order,
        })
        .catch((err) => console.error("Pusher trigger error:", err))
    )
  )
}
