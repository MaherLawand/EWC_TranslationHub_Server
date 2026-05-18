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

  firstName: user.firstName,

  lastName: user.lastName,

  name: `${user.firstName} ${user.lastName}`,

  email: user.email,

  role: user.role,

  department: user.department,

  position: user.position,
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
  res.clearCookie("token", {
    httpOnly: true,
    secure: true,
    sameSite: "none",
  })

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
  firstName: true,
lastName: true,
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

    return res.json({
  ...user,

  name: `${user.firstName} ${user.lastName}`,
})
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
  try {
    /*
      AUTH CHECK
    */

    if (!req.userId) {
      return res.status(401).json({
        message: "Unauthorized",
      })
    }

    /*
      FETCH CURRENT USER ROLE ONLY
      (lighter + faster)
    */

    const currentUser =
      await prisma.user.findUnique({
        where: {
          id: req.userId,
        },

        select: {
          role: true,
        },
      })

    if (!currentUser) {
      return res.status(401).json({
        message: "Unauthorized",
      })
    }

    const isAdmin =
      currentUser.role === "ADMIN"

    /*
      PAGINATION
    */

    const page = Number(
      req.query.page || 1
    )

    const limit = 50

    const skip =
      (page - 1) * limit

    /*
      SELECTS
    */

    const adminSelect = {
      id: true,

      firstName: true,

      lastName: true,

      email: true,

      role: true,

      department: true,

      position: true,

      isActive: true,

      createdAt: true,

      assignedGames: {
        select: {
          gameId: true,
        },
      },
    }

    const normalSelect = {
      id: true,

      firstName: true,

      lastName: true,

      email: true,

      position: true,

      assignedGames: {
        select: {
          gameId: true,
        },
      },
    }

    /*
      FETCH USERS
    */

    const users =
      await prisma.user.findMany({
        skip,

        take: limit,

        orderBy: {
          createdAt: "desc",
        },

        select: isAdmin
          ? adminSelect
          : normalSelect,
      })

    /*
      RESPONSE
    */

    return res.json({
      page,

      limit,

      total: users.length,

      users: users
    })

  } catch (error) {

    console.error(
      "GET USERS ERROR:",
      error
    )

    return res.status(500).json({
      message:
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
  firstName,
  lastName,
  email,
  role,
  department,
  position,
} = req.body

    console.log(
      "Incoming user:",
      {
        firstName,
        lastName,
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
  "EWC Translations <translations@ewctranslations.org>",

    to: email,

    replyTo:
  "translations@ewctranslations.org",

    subject:
      "Complete Your EWC Account Setup",

      text: `
Welcome to EWC Translations

Your account has been created successfully.

To activate your account and create your password, open the link below:

${inviteLink}

This invitation link expires in 24 hours.

If you did not expect this email, you can safely ignore it.

© 2026 EWC Translations
`,



    html: `
<div
  style="
    margin:0;
    padding:0;
    background:#0a0a0a;
    font-family:Arial,sans-serif;
  "
>
  <table
    width="100%"
    cellpadding="0"
    cellspacing="0"
    style="
      background:#0a0a0a;
      padding:40px 20px;
    "
  >
    <tr>
      <td align="center">

        <table
          width="100%"
          cellpadding="0"
          cellspacing="0"
          style="
            max-width:600px;
            background:#111111;
            border:1px solid #242424;
            border-radius:24px;
            overflow:hidden;
          "
        >

          <!-- HEADER -->
          <tr>
            <td
              style="
                padding:40px 40px 24px;
                text-align:center;
                border-bottom:1px solid #1f1f1f;
              "
            >

              <p
                style="
                  margin:0;
                  color:#D6B36A;
                  font-size:12px;
                  letter-spacing:4px;
                  font-weight:700;
                  text-transform:uppercase;
                "
              >
                EWC TRANSLATIONS
              </p>

              <h1
                style="
                  margin:18px 0 0;
                  color:white;
                  font-size:32px;
                  line-height:1.1;
                "
              >
                Welcome to EWC Translation Hub
              </h1>

            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td
              style="
                padding:40px;
                color:#d4d4d4;
                font-size:15px;
                line-height:1.7;
              "
            >

              <p style="margin-top:0;">
                Your EWC Translations account has been successfully created.
              </p>

              <p>
                To activate your account and create your password,
                please click the button below.
              </p>

              <div
                style="
                  text-align:center;
                  margin:40px 0;
                "
              >

                <a
                  href="${inviteLink}"
                  target="_blank"
                  style="
                    display:inline-block;
                    background:#D6B36A;
                    color:#000000;
                    text-decoration:none;
                    padding:16px 28px;
                    border-radius:14px;
                    font-size:15px;
                    font-weight:700;
                  "
                >
                  Set Up Account
                </a>

              </div>

              <p>
                For security reasons, this invitation link will expire in 24 hours.
              </p>

              <p style="margin-bottom:0;">
                If you did not expect this invitation,
                you can safely ignore this email.
              </p>

            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td
              style="
                padding:24px 40px;
                border-top:1px solid #1f1f1f;
                color:#777777;
                font-size:13px;
                text-align:center;
              "
            >
              © 2026 EWC Translations. All rights reserved.
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</div>
`,
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
      firstName,
lastName,
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
      firstName: true,
lastName: true,
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

    return res.json({
  ...user,

  name: `${user.firstName} ${user.lastName}`,
})

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
      firstName,
      lastName,
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
  "EWC Translations <translations@ewctranslations.org>",

    to: email,

        replyTo:

      "translations@ewctranslations.org",

    subject:

      "Complete Your EWC Account Setup",

    text: `

Welcome to EWC Translations

Your account has been successfully created.

To activate your account and create your password, open the link below:

${inviteLink}

This invitation link expires in 24 hours.

If you did not expect this invitation, you can safely ignore this email.

© 2026 EWC Translations

`,

    html: `
<div
  style="
    margin:0;
    padding:0;
    background:#0a0a0a;
    font-family:Arial,sans-serif;
  "
>
  <table
    width="100%"
    cellpadding="0"
    cellspacing="0"
    style="
      background:#0a0a0a;
      padding:40px 20px;
    "
  >
    <tr>
      <td align="center">

        <table
          width="100%"
          cellpadding="0"
          cellspacing="0"
          style="
            max-width:600px;
            background:#111111;
            border:1px solid #242424;
            border-radius:24px;
            overflow:hidden;
          "
        >

          <!-- HEADER -->
          <tr>
            <td
              style="
                padding:40px 40px 24px;
                text-align:center;
                border-bottom:1px solid #1f1f1f;
              "
            >

              <p
                style="
                  margin:0;
                  color:#D6B36A;
                  font-size:12px;
                  letter-spacing:4px;
                  font-weight:700;
                  text-transform:uppercase;
                "
              >
                EWC TRANSLATIONS
              </p>

              <h1
                style="
                  margin:18px 0 0;
                  color:white;
                  font-size:32px;
                  line-height:1.1;
                "
              >
                Welcome to the Platform
              </h1>

            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td
              style="
                padding:40px;
                color:#d4d4d4;
                font-size:15px;
                line-height:1.7;
              "
            >

              <p style="margin-top:0;">
                Your EWC Translations account has been successfully created.
              </p>

              <p>
                To activate your account and create your password,
                please click the button below.
              </p>

              <div
                style="
                  text-align:center;
                  margin:40px 0;
                "
              >

                <a
                  href="${inviteLink}"
                  target="_blank"
                  style="
                    display:inline-block;
                    background:#D6B36A;
                    color:#000000;
                    text-decoration:none;
                    padding:16px 28px;
                    border-radius:14px;
                    font-size:15px;
                    font-weight:700;
                  "
                >
                  Set Up Account
                </a>

              </div>

              <p>
                For security reasons, this invitation link will expire in 24 hours.
              </p>

              <p style="margin-bottom:0;">
                If you did not expect this invitation,
                you can safely ignore this email.
              </p>

            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td
              style="
                padding:24px 40px;
                border-top:1px solid #1f1f1f;
                color:#777777;
                font-size:13px;
                text-align:center;
              "
            >
              © 2026 EWC Translations. All rights reserved.
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
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
          firstName,
          lastName,
          email,
          role,
          department,
          position,
          inviteToken,
          inviteExpiry,
        },

        select: {
          id: true,
          firstName: true,
lastName: true,
          email: true,
          role: true,
          department: true,
          position: true,
          isActive: true,
          createdAt: true,
        },
      })

    return res.json({
  ...updatedUser,

  name: `${updatedUser.firstName} ${updatedUser.lastName}`,
})

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