import bcrypt from "bcryptjs"
import { generateToken } from "../utils/generateToken.js"
import { prisma } from "../lib/prisma.js"
import {
  generateInviteToken,
} from "../utils/generateInviteToken.js"

import {
  sendInviteEmail,
} from "../utils/sendInviteEmail.js"
import type { AuthRequest } from "../middleware/auth.middleware.js"
import type { Request, Response } from "express"
import { Resend } from "resend"

const resend = new Resend(
  process.env.RESEND_API_KEY
)
const CLIENT_URL =

  process.env.CLIENT_URL ||

  "http://ewctranslations.org"

export async function setPassword(
  req: Request,
  res: Response
) {
  try {
    const {
      token,
      password,
    } = req.body

    const user =
      await prisma.user.findFirst({
        where: {
          inviteToken: token,
        },
      })

    if (!user) {
      return res.status(400).json({
        message: "Invalid token",
      })
    }

    if (
      user.inviteExpiry &&
      user.inviteExpiry < new Date()
    ) {
      return res.status(400).json({
        message: "Invite expired",
      })
    }

    const hashedPassword =
      await bcrypt.hash(password, 10)

    await prisma.user.update({
      where: {
        id: user.id,
      },

      data: {
        password: hashedPassword,

        inviteToken: null,

        inviteExpiry: null,

        isActive: true,
      },
    })

    return res.json({
      message:
        "Password set successfully",
    })
  } catch (error) {
    console.error(error)

    return res.status(500).json({
      message:
        "Failed to set password",
    })
  }
}

export async function login(
  req: Request,
  res: Response
) {
  try {
    const { email, password } = req.body
    console.log("LOGIN HIT")
    if (!email || !password) {
      return res.status(400).json({
        message: "Missing fields",
      })
    }

    const user = await prisma.user.findUnique({
      where: {
        email,
      },
    })
console.log(email)

console.log(user)
    if (!user || !user.password) {
      return res.status(401).json({
        message: "Invalid credentials",
      })
    }
    if (!user.isActive) {
  return res.status(403).json({
    message:
      "Account not activated yet",
  })
}

    const validPassword = await bcrypt.compare(
      password,
      user.password
    )

    if (!validPassword) {
      return res.status(401).json({
        message: "Invalid credentials",
      })
    }

    const token = generateToken(user.id)

    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",

      maxAge: 1000 * 60 * 60 * 24 * 7,
    })

    return res.json({
      message: "Login successful",

      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
      },
    })
  } catch (error) {
    console.error(error)

    return res.status(500).json({
      message: "Server error",
    })
  }
}

export async function logout(
  req: Request,
  res: Response
) {
  res.clearCookie("token")

  return res.json({
    message: "Logged out",
  })
}

export async function getCurrentUser(
  req: AuthRequest,
  res: Response
) {
  try {
    const user =
      await prisma.user.findUnique({
        where: {
          id: req.userId,
        },

select: {
  id: true,
  name: true,
  email: true,
  role: true,
  department: true,
  position: true,
  isActive: true,

  notifications: {
    orderBy: {
      createdAt: "desc",
    },

    take: 20,

    select: {
      id: true,
      title: true,
      message: true,
      type: true,
      isRead: true,
      createdAt: true,

      order: {
        select: {
          id: true,
          title: true,
        },
      },
    },
  },

  assignedGames: {
    select: {
      gameId: true,

      game: {
        select: {
          id: true,
          name: true,
          logo: true,
        },
      },
    },
  },
}
      })

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      })
    }

    return res.json(user)
  } catch (error) {
    console.error(error)

    return res.status(500).json({
      message:
        "Failed to fetch current user",
    })
  }
}

export async function getAllUsers(

  req: AuthRequest,

  res: Response

) {
const currentUser =
  await prisma.user.findUnique({
    where: {
      id: req.userId,
    },
  })

if (
  currentUser?.role !== "ADMIN"
) {
  return res.status(403).json({
    message: "Unauthorized",
  })
}
  try {

    const users =

      await prisma.user.findMany({

        orderBy: {

          createdAt: "desc",

        },

        select: {

          id: true,

          name: true,

          email: true,

          role: true,

          department: true,
          isActive: true,

          position: true,

          createdAt: true,

          assignedGames: {
            select: {
              gameId: true,
            },
          },  

        },

      })

    return res.json(users)

  } catch (error) {

    console.error(error)

    return res.status(500).json({

      error:

        "Failed to fetch users",

    })

  }
}

export async function createUser(
  req: AuthRequest,
  res: Response
) {
  try {
    console.log(
      "========== CREATE USER =========="
    )

    const currentUser =
      await prisma.user.findUnique({
        where: {
          id: req.userId,
        },
      })

    console.log(
      "Current user:",
      currentUser?.email
    )

    if (
      currentUser?.role !==
      "ADMIN"
    ) {
      console.log(
        "Unauthorized attempt"
      )

      return res.status(403).json({
        message: "Unauthorized",
      })
    }

    const {
      name,
      email,
      role,
      department,
      position,
    } = req.body

    console.log(
      "Incoming user:",
      {
        name,
        email,
        role,
        department,
        position,
      }
    )

    const existingUser =
      await prisma.user.findUnique({
        where: {
          email,
        },
      })

    if (existingUser) {
      console.log(
        "Duplicate email detected"
      )

      return res.status(400).json({
        message:
          "User with this email already exists",
      })
    }

    const inviteToken =
      generateInviteToken()

    console.log(
      "Invite token generated:",
      inviteToken
    )

    const inviteExpiry =
      new Date(
        Date.now() +
          1000 * 60 * 60 * 24
      )

   const inviteLink =
  `${CLIENT_URL}/setup-password?token=${inviteToken}`

    console.log(
      "Invite link:",
      inviteLink
    )

    /*
      SEND EMAIL FIRST
    */

    console.log(
      "Sending email..."
    )

   const emailResponse =
  await resend.emails.send({
    from:
      "EWC Translations <onboarding@resend.dev>",

    to: email,

    subject:
      "Set up your EWC account",

   html: `
  <div
    style="
      font-family: Arial, sans-serif;
      padding: 40px;
      background: #111;
      color: white;
    "
  >
    <h1>
      Welcome to EWC
    </h1>

    <p>
      Your account has been created.
    </p>

    <p>
      Click below to set your password:
    </p>

    <a
      href="${inviteLink}"
      target="_blank"
      style="
        display: inline-block;
        margin-top: 16px;
        padding: 14px 24px;
        background: white;
        color: black;
        text-decoration: none;
        border-radius: 12px;
        font-weight: bold;
      "
    >
      Set Up Password
    </a>

    <p
      style="
        margin-top: 24px;
        color: #999;
        font-size: 14px;
      "
    >
      This invite expires in 24 hours.
    </p>
  </div>
`
  })

console.log(emailResponse)

/*
  STOP IF EMAIL FAILED
*/

if (emailResponse.error) {
  console.error(
    "Email sending failed:"
  )

  console.error(
    emailResponse.error
  )

  return res.status(500).json({
    message:
      emailResponse.error.message,
  })
}

/*
  ONLY CREATE USER IF EMAIL SUCCEEDED
*/

const user =
  await prisma.user.create({
    data: {
      name,
      email,
      role,
      department,
      position,
      inviteToken,
      inviteExpiry,
      isActive: false,
    },

    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      department: true,
      position: true,
      isActive: true,
      createdAt: true,
    },
  })

    console.log(
      "User created successfully:"
    )

    console.log(user)

    console.log(
      "========== SUCCESS =========="
    )

    return res.json(user)

  } catch (error) {
    console.error(
      "========== CREATE USER ERROR =========="
    )

    console.error(error)

    return res.status(500).json({
      message:
        "Failed to create user",
    })
  }
}

export async function updateUser(
  req: AuthRequest,
  res: Response
) {
  try {
    const currentUser =
      await prisma.user.findUnique({
        where: {
          id: req.userId,
        },
      })

    if (
      currentUser?.role !==
      "ADMIN"
    ) {
      return res.status(403).json({
        message: "Unauthorized",
      })
    }

    const rawId = req.params.id

    const id = Array.isArray(rawId)
      ? rawId[0]
      : rawId

    if (!id) {
      return res.status(400).json({
        message: "Invalid user id",
      })
    }

    const {
      name,
      email,
      role,
      department,
      position,
    } = req.body

    const existingUser =
      await prisma.user.findUnique({
        where: {
          id,
        },
      })

    if (!existingUser) {
      return res.status(404).json({
        message: "User not found",
      })
    }

    /*
      EMAIL CHANGE CHECK
    */

    const emailChanged =
      existingUser.email !==
      email

    if (
      existingUser.isActive &&
      emailChanged
    ) {
      return res.status(400).json({
        message:
          "Cannot change email after activation",
      })
    }

    /*
      IF EMAIL CHANGED FOR
      NON-ACTIVE USER:
      SEND NEW INVITE
    */

    let inviteToken =
      existingUser.inviteToken

    let inviteExpiry =
      existingUser.inviteExpiry

    if (
      !existingUser.isActive &&
      emailChanged
    ) {
      inviteToken =
        generateInviteToken()

      inviteExpiry =
        new Date(
          Date.now() +
            1000 *
              60 *
              60 *
              24
        )

      const inviteLink =
  `${CLIENT_URL}/setup-password?token=${inviteToken}`

      const emailResponse =
        await resend.emails.send({
          from:
            "EWC Translations <onboarding@resend.dev>",

          to: email,

          subject:
            "Set up your EWC account",

          html: `
            <div style="font-family:sans-serif">
              <h2>Welcome to EWC</h2>

              <p>
                Click below to set your password:
              </p>

              <a
                href="${inviteLink}"
                style="
                  display:inline-block;
                  padding:12px 20px;
                  background:black;
                  color:white;
                  text-decoration:none;
                  border-radius:10px;
                "
              >
                Set Up Password
              </a>

              <p style="margin-top:20px">
                This invite expires in 24 hours.
              </p>
            </div>
          `,
        })

      if (
        emailResponse.error
      ) {
        console.error(
          emailResponse.error
        )

        return res.status(500).json({
          message:
            "Failed to send invite email",
        })
      }
    }

    /*
      UPDATE USER
    */

    const updatedUser =
      await prisma.user.update({
        where: {
          id,
        },

        data: {
          name,
          email,
          role,
          department,
          position,
          inviteToken,
          inviteExpiry,
        },

        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          department: true,
          position: true,
          isActive: true,
          createdAt: true,
        },
      })

    return res.json(
      updatedUser
    )

  } catch (error) {
    console.error(error)

    return res.status(500).json({
      message:
        "Failed to update user",
    })
  }
}
export async function deleteUser(
  req: AuthRequest,
  res: Response
) {
  try {
    const currentUser =
      await prisma.user.findUnique({
        where: {
          id: req.userId,
        },
      })

    if (
      currentUser?.role !==
      "ADMIN"
    ) {
      return res.status(403).json({
        message: "Unauthorized",
      })
    }

    const rawId = req.params.id

    const id = Array.isArray(rawId)
      ? rawId[0]
      : rawId

    if (!id) {
      return res.status(400).json({
        message: "Invalid user id",
      })
    }

    if (id === currentUser.id) {
      return res.status(400).json({
        message:
          "You cannot delete yourself",
      })
    }

    await prisma.user.delete({
      where: {
        id,
      },
    })

    return res.json({
      message:
        "User deleted successfully",
    })

  } catch (error) {
    console.error(error)

    return res.status(500).json({
      message:
        "Failed to delete user",
    })
  }
}

export async function assignGamesToUser(
  req: AuthRequest,
  res: Response
) {
  try {
    const currentUser =
      await prisma.user.findUnique({
        where: {
          id: req.userId,
        },
      })

    if (
      currentUser?.role !==
      "ADMIN"
    ) {
      return res.status(403).json({
        message: "Unauthorized",
      })
    }

    const rawId = req.params.id

    const userId = Array.isArray(rawId)
      ? rawId[0]
      : rawId

    if (!userId) {
      return res.status(400).json({
        message: "Invalid user id",
      })
    }

    const { gameIds } = req.body

    await prisma.gameAssignment.deleteMany({
      where: {
        userId,
      },
    })

    if (
      gameIds &&
      gameIds.length > 0
    ) {
      await prisma.gameAssignment.createMany({
        data: gameIds.map(
          (gameId: string) => ({
            userId,
            gameId,
          })
        ),
      })
    }

    return res.json({
      message:
        "Games assigned successfully",
    })
  } catch (error) {
    console.error(error)

    return res.status(500).json({
      message:
        "Failed to assign games",
    })
  }
}