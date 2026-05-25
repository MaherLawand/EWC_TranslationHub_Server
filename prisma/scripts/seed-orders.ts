import { PrismaClient, OrderStatus, OrderPriority, EventType } from "@prisma/client"

const prisma = new PrismaClient()

const LANGUAGES = [
  "English", "Arabic", "French", "Spanish", "German",
  "Portuguese", "Italian", "Dutch", "Russian", "Turkish",
  "Korean", "Japanese", "Chinese", "Polish", "Swedish",
]

const FORMATS = ["TEXT", "SRT", "BURNED_IN"] as const

const BROADCAST_TITLES = [
  "Opening Ceremony", "Group Stage Day", "Quarterfinals Match",
  "Semifinals Broadcast", "Grand Finals", "Player Interviews",
  "Highlight Reel", "Post-Match Analysis", "Pre-Show Coverage",
  "Award Ceremony", "Team Introduction", "Studio Discussion",
  "Live Commentary", "Draft Phase Coverage", "Closing Ceremony",
  "Day One Recap", "Playoffs Preview", "Elimination Round",
  "Champions Showcase", "Fan Zone Special",
]

const MARKETING_CONTENT_TITLES = [
  "Event Announcement", "Player Spotlight", "Sponsor Feature",
  "Social Media Campaign", "Press Release", "Team Profile",
  "Tournament Preview", "Championship Recap", "Brand Story",
  "Community Highlight", "Merchandise Launch", "Partnership Reveal",
  "Venue Tour", "Behind the Scenes", "Fan Q&A",
  "Coach Interview", "Season Kickoff", "Hall of Fame",
  "Rising Stars", "Road to Finals",
]

const STATUSES: OrderStatus[] = ["PENDING", "PENDING", "IN_PROGRESS", "IN_PROGRESS", "COMPLETED"]
const PRIORITIES: OrderPriority[] = ["LOW", "MEDIUM", "MEDIUM", "HIGH"]
const EVENTS: EventType[] = ["EWC", "EWC", "EWC", "ENC"]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function pickN<T>(arr: readonly T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, n)
}

function futureDate(minDays: number, maxDays: number): Date {
  const ms = Date.now() + (minDays + Math.random() * (maxDays - minDays)) * 86400000
  return new Date(ms)
}

async function main() {
  // Grab an admin user to be createdBy
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } })
  if (!admin) throw new Error("No admin user found — run seed-admin.ts first")

  // Grab all games
  const games = await prisma.game.findMany()
  if (games.length === 0) throw new Error("No games found — run seed-games.ts first")

  console.log(`Using admin: ${admin.firstName} ${admin.lastName}`)
  console.log(`Found ${games.length} games`)

  // ── BROADCAST ORDERS ────────────────────────────────────────────────────────
  console.log("\nCreating 100 broadcast orders...")
  for (let i = 1; i <= 100; i++) {
    const game = pick(games)
    const status = pick(STATUSES)
    const priority = pick(PRIORITIES)
    const event = pick(EVENTS)
    const sourceLanguage = [pick(LANGUAGES)]
    const targetLanguages = pickN(LANGUAGES.filter(l => !sourceLanguage.includes(l)), Math.floor(Math.random() * 4) + 1)
    const formats = pickN(FORMATS, Math.floor(Math.random() * 2) + 1)
    const deliveryDate = futureDate(3, 20)
    const deadlineDate = new Date(deliveryDate.getTime() - 2 * 86400000)
    const titleBase = pick(BROADCAST_TITLES)
    const srcLink = `https://google.com`

    await prisma.translationOrder.create({
      data: {
        type: "BROADCAST",
        event,
        title: `${titleBase} ${i}`,
        status,
        priority,
        createdById: admin.id,
        ...(status === "COMPLETED" ? { completedById: admin.id, completedAt: new Date() } : {}),
        broadcast: {
          create: {
            gameId: game.id,
            estimatedMinutes: Math.floor(Math.random() * 90) + 5,
            sourceLanguage,
            targetLanguages,
            deliveryDate,
            deadlineDate,
            deliveryFormats: {
              create: formats.map(format => ({ format })),
            },
            sourceFileLink:srcLink,
          },
        },
      },
    })

    if (i % 20 === 0) console.log(`  ${i}/100 broadcast orders created`)
  }

  // ── MARKETING ORDERS ────────────────────────────────────────────────────────
  console.log("\nCreating 100 marketing orders...")
  for (let i = 1; i <= 100; i++) {
    const status = pick(STATUSES)
    const priority = pick(PRIORITIES)
    const event = pick(EVENTS)
    const sourceLanguage = [pick(LANGUAGES)]
    const targetLanguages = pickN(LANGUAGES.filter(l => !sourceLanguage.includes(l)), Math.floor(Math.random() * 4) + 1)
    const formats = pickN(FORMATS, Math.floor(Math.random() * 2) + 1)
    const deadlineDate = futureDate(2, 30)
    const contentTitleBase = pick(MARKETING_CONTENT_TITLES)
    const srcLink = `https://google.com`


    await prisma.translationOrder.create({
      data: {
        type: "MARKETING",
        event,
        title: `Marketing Order ${i}`,
        status,
        priority,
        createdById: admin.id,
        ...(status === "COMPLETED" ? { completedById: admin.id, completedAt: new Date() } : {}),
        marketing: {
          create: {
            contentTitle: `${contentTitleBase} ${i}`,
            sourceLanguage,
            targetLanguages,
            deadlineDate,
            deliveryFormats: {
              create: formats.map(format => ({ format })),
            },
            sourceFileLink:srcLink,
          },
        },
      },
    })

    if (i % 20 === 0) console.log(`  ${i}/100 marketing orders created`)
  }

  console.log("\n✓ Done — 100 broadcast + 100 marketing orders created")
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
