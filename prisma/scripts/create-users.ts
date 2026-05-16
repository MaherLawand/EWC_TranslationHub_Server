import {
  PrismaClient,
  UserRole,
  UserDepartment,
  UserPosition,
} from "@prisma/client"

import * as crypto from "node:crypto"
import readline from "readline"

const prisma = new PrismaClient()

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve)
  })
}

async function main() {
  const name = await ask("Name: ")

  const email = await ask("Email: ")

  const roleInput = await ask(
    "Role (ADMIN / USER): "
  )

  const departmentInput = await ask(
    "Department (MARKETING / BROADCAST): "
  )

  const positionInput = await ask(
    "Position (PRODUCER / POST_PRODUCTION_MANAGER / ADMIN): "
  )

  const inviteToken =
    crypto.randomBytes(32).toString("hex")

  const inviteExpiry = new Date(
    Date.now() + 1000 * 60 * 60 * 24
  )

  const user = await prisma.user.create({
    data: {
      name,
      email,

      role: roleInput as UserRole,

      department:
        departmentInput as UserDepartment,

      position:
        positionInput as UserPosition,

      inviteToken,
      inviteExpiry,

      isActive: false,
    },
  })

  console.log(
    "\nUser created successfully\n"
  )

  console.log(
    `Setup link:\nhttp://localhost:5173/setup-password?token=${inviteToken}`
  )

  console.log("\nCreated user:")

  console.log(user)

  rl.close()
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect()
  })