import {
  PrismaClient,
  UserRole,
  UserDepartment,
  UserPosition,
} from "@prisma/client"

import bcrypt from "bcryptjs"

const prisma = new PrismaClient()

async function main() {

  const hashedPassword =
    await bcrypt.hash(
      "admin123",
      10
    )

  await prisma.user.createMany({
    data: [
      // ADMINS (Mostly PPMs)

      {
        name: "Maher Admin",
        email: "admin1@ewc.com",
        password: hashedPassword,
        role: UserRole.ADMIN,
        department:
          UserDepartment.BROADCAST,
        position:
          UserPosition.POST_PRODUCTION_MANAGER,
        isActive: true,
      },

      {
        name: "Sarah Admin",
        email: "admin2@ewc.com",
        password: hashedPassword,
        role: UserRole.ADMIN,
        department:
          UserDepartment.MARKETING,
        position:
          UserPosition.POST_PRODUCTION_MANAGER,
        isActive: true,
      },

      // EDITORS (Mostly Producers)

      {
        name: "Omar Producer",
        email: "producer1@ewc.com",
        password: hashedPassword,
        role: UserRole.EDITOR,
        department:
          UserDepartment.BROADCAST,
        position:
          UserPosition.PRODUCER,
        isActive: true,
      },

      {
        name: "Layla Producer",
        email: "producer2@ewc.com",
        password: hashedPassword,
        role: UserRole.EDITOR,
        department:
          UserDepartment.MARKETING,
        position:
          UserPosition.PRODUCER,
        isActive: true,
      },

      {
        name: "Elias Producer",
        email: "producer3@ewc.com",
        password: hashedPassword,
        role: UserRole.EDITOR,
        department:
          UserDepartment.BROADCAST,
        position:
          UserPosition.PRODUCER,
        isActive: true,
      },

      {
        name: "Maya Producer",
        email: "producer4@ewc.com",
        password: hashedPassword,
        role: UserRole.EDITOR,
        department:
          UserDepartment.MARKETING,
        position:
          UserPosition.PRODUCER,
        isActive: true,
      },

      // VIEWERS (Mostly Translators)

      {
        name: "Ali Translator",
        email: "translator1@ewc.com",
        password: hashedPassword,
        role: UserRole.VIEWER,
        department:
          UserDepartment.BROADCAST,
        position:
          UserPosition.TRANSLATOR,
        isActive: true,
      },

      {
        name: "Rita Translator",
        email: "translator2@ewc.com",
        password: hashedPassword,
        role: UserRole.VIEWER,
        department:
          UserDepartment.MARKETING,
        position:
          UserPosition.TRANSLATOR,
        isActive: true,
      },

      {
        name: "Karim Translator",
        email: "translator3@ewc.com",
        password: hashedPassword,
        role: UserRole.VIEWER,
        department:
          UserDepartment.BROADCAST,
        position:
          UserPosition.TRANSLATOR,
        isActive: true,
      },

      {
        name: "Nadine Translator",
        email: "translator4@ewc.com",
        password: hashedPassword,
        role: UserRole.VIEWER,
        department:
          UserDepartment.MARKETING,
        position:
          UserPosition.TRANSLATOR,
        isActive: true,
      },
    ],
  })

  console.log(
    "Seeded 10 test users successfully"
  )
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect()
  })