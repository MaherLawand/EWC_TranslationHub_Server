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
        firstName: "Rouba",
        lastName: "Admin",
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
        firstName: "Maher",
        lastName: "Admin",
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
        firstName: "Producer",
        lastName: "User",
        email: "producer1@ewc.com",
        password: hashedPassword,
        role: UserRole.USER,
        department:
          UserDepartment.BROADCAST,
        position:
          UserPosition.PRODUCER,
        isActive: true,
      },

      {
        firstName: "Translator",
        lastName: "User",
        email: "translator1@ewc.com",
        password: hashedPassword,
        role: UserRole.USER,
        department:
          UserDepartment.BROADCAST,
        position:
          UserPosition.TRANSLATOR,
        isActive: true,
      },
      {
        firstName: "Translator",
        lastName: "User",
        email: "translator2@ewc.com",
        password: hashedPassword,
        role: UserRole.USER,
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