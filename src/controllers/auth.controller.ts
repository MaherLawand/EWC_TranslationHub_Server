import bcrypt from "bcryptjs"
import { generateToken } from "../utils/generateToken.js"
import { prisma } from "../lib/prisma.js"
import {
  generateInviteToken,
} from "../utils/generateInviteToken.js"

import {
  sendInviteEmail,
} from "../utils/sendInviteEmail.js"
import {
  sendResetEmail,
} from "../utils/sendResetEmail.js"
import {
  sendLockoutEmail,
} from "../utils/sendLockoutEmail.js"
import type { AuthRequest } from "../middleware/auth.middleware.js"
import type { Request, Response } from "express"
import { Resend } from "resend"
import { logger } from "../lib/logger.js"
import { loginAttempts } from "../lib/loginAttempts.js"

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

    if (!token || typeof token !== "string") {
      return res.status(400).json({
        message: "Invalid token",
      })
    }

    if (!password || typeof password !== "string") {
      return res.status(400).json({ message: "Password is required" })
    }

    const passwordErrors: string[] = []
    if (password.length < 8) passwordErrors.push("at least 8 characters")
    if (!/[A-Z]/.test(password)) passwordErrors.push("one uppercase letter")
    if (!/[a-z]/.test(password)) passwordErrors.push("one lowercase letter")
    if (!/[0-9]/.test(password)) passwordErrors.push("one number")
    if (!/[!@#$%^&*()_+\-=\[\]{}|;':",.<>?/\\`~]/.test(password)) passwordErrors.push("one special character")

    if (passwordErrors.length > 0) {
      return res.status(400).json({
        message: `Password must contain: ${passwordErrors.join(", ")}`,
      })
    }

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
      await bcrypt.hash(password, 12)

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

    logger.info({ action: "SET_PASSWORD", userId: user.id, email: user.email })

    return res.json({
      message:
        "Password set successfully",
    })
  } catch (error) {
    logger.error({ action: "SET_PASSWORD_ERROR", err: error })

    return res.status(500).json({
      message:
        "Failed to set password",
    })
  }
}

export async function validateInvite(
  req: Request,
  res: Response
) {
  try {
    const token = String(req.query.token || "")
    if (!token) return res.status(400).json({ valid: false, reason: "missing" })

    const user = await prisma.user.findFirst({ where: { inviteToken: token } })
    if (!user) return res.json({ valid: false, reason: "invalid" })
    if (user.inviteExpiry && user.inviteExpiry < new Date()) {
      return res.json({ valid: false, reason: "expired" })
    }
    return res.json({ valid: true })
  } catch (error) {
    logger.error({ action: "VALIDATE_INVITE_ERROR", err: error })
    return res.status(500).json({ valid: false, reason: "error" })
  }
}

export async function resendInvite(
  req: Request,
  res: Response
) {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ message: "Email is required" })
    }

    // Always return the same vague 200 so callers can't enumerate accounts
    const vague = { message: "If that email matches a pending account, a new link has been sent." }

    const user = await prisma.user.findUnique({ where: { email } })

    // No user found, or user already activated — do nothing but respond vaguely
    if (!user || user.isActive) {
      return res.json(vague)
    }

    const token = generateInviteToken()
    const inviteExpiry = new Date(Date.now() + 1000 * 60 * 60 * 24 * 3)



    await prisma.user.update({
      where: { id: user.id },
      data: { inviteToken: token, inviteExpiry },
    })

    await sendInviteEmail(user.email, token)

    logger.info({ action: "RESEND_INVITE", targetEmail: user.email, targetUserId: user.id })

    return res.json(vague)
  } catch (error) {
    logger.error({ action: "RESEND_INVITE_ERROR", err: error })
    return res.status(500).json({ message: "Failed to resend invite" })
  }
}

export async function login(
  req: Request,
  res: Response
) {
  try {
    const { password } = req.body
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : ""

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" })
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Invalid email address" })
    }

    // Check lockout before hitting the DB
    if (await loginAttempts.isLocked(email)) {
      const remaining = await loginAttempts.lockoutRemainingSeconds(email)
      const minutes = Math.ceil(remaining / 60)
      logger.warn({ action: "LOGIN_BLOCKED", email, reason: "lockout", remainingSeconds: remaining })
      return res.status(429).json({
        message: `Too many failed attempts. Try again in ${minutes} minute${minutes !== 1 ? "s" : ""} or reset your password.`,
        locked: true,
        remainingSeconds: remaining,
      })
    }

    const user = await prisma.user.findUnique({
      where: { email },
    })
    if (!user || !user.password) {
      const { locked } = await loginAttempts.recordFailure(email)
      logger.warn({ action: "LOGIN_FAILED", email, reason: "invalid_credentials" })
      // If a real user exists and just got locked, send the notification email.
      // Pass activated=false so the email tells them to contact admin
      // rather than reset a password they've never set.
      if (locked && user) {
        logger.info({ action: "LOCKOUT_EMAIL_SENDING", email: user.email })
        sendLockoutEmail(user.email, false)
          .then(() => logger.info({ action: "LOCKOUT_EMAIL_SENT", email: user.email }))
          .catch((err) => logger.error({ action: "LOCKOUT_EMAIL_FAILED", email: user.email, err }))
      }
      return res.status(401).json({
        message: "Invalid credentials",
      })
    }
    if (!user.isActive) {
      logger.warn({ action: "LOGIN_FAILED", email, userId: user.id, reason: "account_inactive" })
      return res.status(403).json({
        message: "Account not activated yet",
      })
    }

    const validPassword = await bcrypt.compare(
      password,
      user.password
    )

    if (!validPassword) {
      const { failures, locked } = await loginAttempts.recordFailure(email)
      logger.warn({ action: "LOGIN_FAILED", email, userId: user.id, reason: "wrong_password", failures })
      if (locked) {
        logger.info({ action: "LOCKOUT_EMAIL_SENDING", email: user.email })
        sendLockoutEmail(user.email)
          .then(() => logger.info({ action: "LOCKOUT_EMAIL_SENT", email: user.email }))
          .catch((err) =>
            logger.error({ action: "LOCKOUT_EMAIL_FAILED", email: user.email, err })
          )
        return res.status(429).json({
          message: "Too many failed attempts. Account locked for 5 minutes. Reset your password to unlock immediately.",
          locked: true,
          remainingSeconds: 300,
        })
      }
      return res.status(401).json({
        message: "Invalid credentials",
        attemptsRemaining: 5 - failures,
      })
    }

    const token = generateToken(user.id)

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 365,
    })

    await loginAttempts.clear(email)
    logger.info({ action: "LOGIN", userId: user.id, email: user.email, role: user.role })

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
    logger.error({ action: "LOGIN_ERROR", err: error })

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
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
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
          event: true,
          type: true,
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
    logger.error({ action: "GET_CURRENT_USER_ERROR", err: error })

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
      SEARCH
    */

    const search = req.query.search
      ? String(req.query.search).trim()
      : ""

    if (search.length > 100) {
      return res.status(400).json({ message: "Search query too long" })
    }

    const where = search
      ? {
          OR: [
            { firstName: { contains: search, mode: "insensitive" as const } },
            { lastName: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}

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

    const [users, total] =
      await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          select: isAdmin ? adminSelect : normalSelect,
        }),
        prisma.user.count({ where }),
      ])

    const totalPages = Math.ceil(total / limit) || 1

    /*
      RESPONSE
    */

    return res.json({
      page,
      limit,
      total,
      totalPages,
      users,
    })

  } catch (error) {

    logger.error({ action: "GET_USERS_ERROR", err: error })

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
    const {
      firstName,
      lastName,
      email,
      role,
      department,
      position,
    } = req.body

    // Input validation
    if (!firstName?.trim() || !lastName?.trim()) {
      return res.status(400).json({ message: "First and last name are required" })
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Valid email is required" })
    }
    const VALID_ROLES = ["ADMIN", "USER"]
    const VALID_DEPARTMENTS = ["BROADCAST", "MARKETING"]
    const VALID_POSITIONS = ["PRODUCER", "POST_PRODUCTION_MANAGER", "TRANSLATOR", "VIEWER", "EDITOR"]
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: "Invalid role" })
    }
    if (!VALID_DEPARTMENTS.includes(department)) {
      return res.status(400).json({ message: "Invalid department" })
    }
    if (position && !VALID_POSITIONS.includes(position)) {
      return res.status(400).json({ message: "Invalid position" })
    }

    const existingUser =
      await prisma.user.findUnique({
        where: {
          email,
        },
      })

    if (existingUser) {
      return res.status(400).json({
        message:
          "User with this email already exists",
      })
    }

    const inviteToken =
      generateInviteToken()

    const inviteExpiry =
new Date(Date.now() + 1000 * 60 * 60 * 24 * 3)



    const inviteLink =
      `${CLIENT_URL}/setup-password?token=${inviteToken}`

    /*
      SEND EMAIL FIRST
    */

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

This invitation link expires in 72 hours.

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

              <img
                src="https://ewctranslations.org/EWCLOGOEMAIL.png"
                alt="EWC Translation Hub"
                width="260"
                style="display:block; margin:0 auto; width:260px; height:auto;"
              />

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
                For security reasons, this invitation link will expire in 72 hours.
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

/*
  STOP IF EMAIL FAILED
*/

if (emailResponse.error) {
  logger.error({ action: "CREATE_USER_EMAIL_FAILED", err: emailResponse.error })

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

    logger.info({ action: "CREATE_USER", byUserId: req.userId, newUserId: user.id, email: user.email, role: user.role, department: user.department })

    return res.json({
  ...user,

  name: `${user.firstName} ${user.lastName}`,
})

  } catch (error) {
    logger.error({ action: "CREATE_USER_ERROR", byUserId: req.userId, err: error })

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

    /*
      FIELD VALIDATION
    */

    const VALID_ROLES_U = ["ADMIN", "USER"]
    const VALID_DEPARTMENTS_U = ["BROADCAST", "MARKETING"]
    const VALID_POSITIONS_U = ["PRODUCER", "POST_PRODUCTION_MANAGER", "TRANSLATOR", "VIEWER", "EDITOR"]

    if (role && !VALID_ROLES_U.includes(role)) {
      return res.status(400).json({ message: "Invalid role" })
    }
    if (department && !VALID_DEPARTMENTS_U.includes(department)) {
      return res.status(400).json({ message: "Invalid department" })
    }
    if (position && !VALID_POSITIONS_U.includes(position)) {
      return res.status(400).json({ message: "Invalid position" })
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Valid email is required" })
    }

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
            1000 * 60 * 60 * 24 * 3
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

This invitation link expires in 72 hours.

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

              <img
                src="https://ewctranslations.org/EWCLOGOEMAIL.png"
                alt="EWC Translation Hub"
                width="260"
                style="display:block; margin:0 auto; width:260px; height:auto;"
              />

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
                For security reasons, this invitation link will expire in 72 hours.
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
        logger.error({ action: "UPDATE_USER_EMAIL_FAILED", byUserId: req.userId, targetUserId: id, err: emailResponse.error })

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

    logger.info({ action: "UPDATE_USER", byUserId: req.userId, targetUserId: updatedUser.id, email: updatedUser.email, role: updatedUser.role })

    return res.json({
  ...updatedUser,

  name: `${updatedUser.firstName} ${updatedUser.lastName}`,
})

  } catch (error: any) {
    // Unique constraint on email — return a clear 400 instead of a generic 500
    if (error?.code === "P2002") {
      return res.status(400).json({ message: "Email already in use" })
    }

    logger.error({ action: "UPDATE_USER_ERROR", byUserId: req.userId, err: error })

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
    const rawId = req.params.id

    const id = Array.isArray(rawId)
      ? rawId[0]
      : rawId

    if (!id) {
      return res.status(400).json({
        message: "Invalid user id",
      })
    }

    if (id === req.userId) {
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

    logger.info({ action: "DELETE_USER", byUserId: req.userId, targetUserId: id })

    return res.json({
      message:
        "User deleted successfully",
    })

  } catch (error) {
    logger.error({ action: "DELETE_USER_ERROR", byUserId: req.userId, targetUserId: req.params.id, err: error })

    return res.status(500).json({
      message:
        "Failed to delete user",
    })
  }
}

export async function searchUsers(
  req: AuthRequest,
  res: Response
) {
  try {
    const q = String(req.query.q || "").trim()

    if (q.length > 100) {
      return res.status(400).json({ message: "Search query too long" })
    }

    const [firstName, lastName] = q.split(" ")

    const where = q
      ? {
          OR: [
            {
              firstName: {
                contains: q,
                mode: "insensitive" as const,
              },
            },
            {
              lastName: {
                contains: q,
                mode: "insensitive" as const,
              },
            },
            ...(firstName && lastName
              ? [
                  {
                    AND: [
                      {
                        firstName: {
                          contains: firstName,
                          mode: "insensitive" as const,
                        },
                      },
                      {
                        lastName: {
                          contains: lastName,
                          mode: "insensitive" as const,
                        },
                      },
                    ],
                  },
                ]
              : []),
          ],
        }
      : {}

    const users = await prisma.user.findMany({
      where,
      take: 25,
      orderBy: [
        { firstName: "asc" },
        { lastName: "asc" },
      ],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        position: true,
        department: true,
      },
    })

    return res.json(users)
  } catch (error) {
    logger.error({ action: "SEARCH_USERS_ERROR", err: error })
    return res.status(500).json({ message: "Failed to search users" })
  }
}

export async function assignGamesToUser(
  req: AuthRequest,
  res: Response
) {
  try {
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

    if (gameIds !== undefined && (!Array.isArray(gameIds) || gameIds.length > 50)) {
      return res.status(400).json({ message: "gameIds must be an array of up to 50 IDs" })
    }

    await prisma.$transaction([
      prisma.gameAssignment.deleteMany({ where: { userId } }),
      ...(gameIds && gameIds.length > 0
        ? [prisma.gameAssignment.createMany({
            data: gameIds.map((gameId: string) => ({ userId, gameId })),
          })]
        : []
      ),
    ])

    logger.info({ action: "ASSIGN_GAMES_TO_USER", byUserId: req.userId, targetUserId: userId, gameIds: gameIds ?? [] })

    return res.json({
      message:
        "Games assigned successfully",
    })
  } catch (error) {
    logger.error({ action: "ASSIGN_GAMES_TO_USER_ERROR", byUserId: req.userId, targetUserId: req.params.id, err: error })

    return res.status(500).json({
      message:
        "Failed to assign games",
    })
  }
}

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────

export async function forgotPassword(
  req: Request,
  res: Response
) {
  // Always return the same response regardless of whether the email exists —
  // prevents account enumeration.
  const SAFE_RESPONSE = {
    message: "If that email is registered, a reset link has been sent.",
  }

  try {
    const { email } = req.body

    if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      // Return safe response even for invalid email format
      return res.json(SAFE_RESPONSE)
    }

    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true, email: true, isActive: true },
    })

    // Send email only if user exists and is active
    if (user && user.isActive) {
      const token = generateInviteToken()
      const expiry = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

      await prisma.user.update({
        where: { id: user.id },
        data: { resetToken: token, resetExpiry: expiry },
      })

      await sendResetEmail(user.email, token)

      logger.info({ action: "FORGOT_PASSWORD", userId: user.id, email: user.email })
    }

    return res.json(SAFE_RESPONSE)
  } catch (error) {
    logger.error({ action: "FORGOT_PASSWORD_ERROR", err: error })
    // Still return safe response — don't leak server errors
    return res.json(SAFE_RESPONSE)
  }
}

// ─── VALIDATE RESET TOKEN ─────────────────────────────────────────────────────

export async function validateResetToken(
  req: Request,
  res: Response
) {
  try {
    const token = String(req.query.token || "")
    if (!token) return res.status(400).json({ valid: false, reason: "missing" })

    const user = await prisma.user.findFirst({
      where: { resetToken: token },
      select: { id: true, resetExpiry: true },
    })

    if (!user) return res.json({ valid: false, reason: "invalid" })

    if (user.resetExpiry && user.resetExpiry < new Date()) {
      return res.json({ valid: false, reason: "expired" })
    }

    return res.json({ valid: true })
  } catch (error) {
    logger.error({ action: "VALIDATE_RESET_TOKEN_ERROR", err: error })
    return res.status(500).json({ valid: false, reason: "error" })
  }
}

// ─── RESET PASSWORD ───────────────────────────────────────────────────────────

export async function resetPassword(
  req: Request,
  res: Response
) {
  try {
    const { token, password } = req.body

    if (!token || typeof token !== "string") {
      return res.status(400).json({ message: "Invalid token" })
    }

    if (!password || typeof password !== "string") {
      return res.status(400).json({ message: "Password is required" })
    }

    // Same complexity rules as setPassword
    const passwordErrors: string[] = []
    if (password.length < 8) passwordErrors.push("at least 8 characters")
    if (!/[A-Z]/.test(password)) passwordErrors.push("one uppercase letter")
    if (!/[a-z]/.test(password)) passwordErrors.push("one lowercase letter")
    if (!/[0-9]/.test(password)) passwordErrors.push("one number")
    if (!/[!@#$%^&*()_+\-=\[\]{}|;':",.<>?/\\`~]/.test(password)) passwordErrors.push("one special character")

    if (passwordErrors.length > 0) {
      return res.status(400).json({
        message: `Password must contain: ${passwordErrors.join(", ")}`,
      })
    }

    const user = await prisma.user.findFirst({
      where: { resetToken: token },
    })

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired reset link" })
    }

    if (user.resetExpiry && user.resetExpiry < new Date()) {
      return res.status(400).json({ message: "Reset link expired" })
    }

    const hashedPassword = await bcrypt.hash(password, 12)

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetExpiry: null,
      },
    })

    await loginAttempts.clear(user.email)
    logger.info({ action: "RESET_PASSWORD", userId: user.id, email: user.email })

    return res.json({ message: "Password reset successfully" })
  } catch (error) {
    logger.error({ action: "RESET_PASSWORD_ERROR", err: error })
    return res.status(500).json({ message: "Failed to reset password" })
  }
}

/** Admin — get all currently locked accounts */
export async function getLockedUsers(
  req: AuthRequest,
  res: Response
) {
  try {
    const locked = await loginAttempts.getLockedAccounts()
    return res.json(locked)
  } catch (error) {
    logger.error({ action: "GET_LOCKED_USERS_ERROR", err: error })
    return res.status(500).json({ message: "Failed to get locked users" })
  }
}

/** Admin — clear login lockout for a specific user by email */
export async function clearLoginLockout(
  req: AuthRequest,
  res: Response
) {
  try {
    const { email } = req.body
    if (!email || typeof email !== "string") {
      return res.status(400).json({ message: "Email is required" })
    }
    await loginAttempts.adminClear(email.toLowerCase().trim())
    logger.info({ action: "CLEAR_LOGIN_LOCKOUT", adminId: req.userId, targetEmail: email })
    return res.json({ message: "Lockout cleared" })
  } catch (error) {
    logger.error({ action: "CLEAR_LOGIN_LOCKOUT_ERROR", err: error })
    return res.status(500).json({ message: "Failed to clear lockout" })
  }
}

