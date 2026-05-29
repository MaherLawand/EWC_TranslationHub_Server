import { Server } from "socket.io"

// Exported so triggerNotifications can use it.
// Set by index.ts after the HTTP server is created.
export let io: Server

export function setIo(instance: Server) {
  io = instance
}

export function getIo(): Server | undefined {
  return io
}

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
  if (!io) return
  for (const n of notifications) {
    io.to(n.userId).emit("new-notification", {
      id: n.id,
      title: n.title,
      message: n.message,
      type: n.type,
      isRead: n.isRead,
      createdAt: n.createdAt,
      order: n.order,
    })
  }
}
