/**
 * DB-backed login attempt tracker.
 *
 * Stores failure count and lockout expiry on the User row so state
 * survives server restarts and Railway redeploys.
 *
 * Rules:
 * - After 5 failed attempts → account locked for 5 minutes
 * - Lockout clears automatically on next check after expiry
 * - Lockout also clears on: successful login, password reset, admin clear
 */

import { prisma } from "./prisma.js"

const LOCKOUT_THRESHOLD = 5
const LOCKOUT_DURATION_MS = 5 * 60 * 1000 // 5 minutes

class LoginAttemptsStore {
  private key(email: string) {
    return email.toLowerCase().trim()
  }

  /** Returns true if the account is currently locked out */
  async isLocked(email: string): Promise<boolean> {
    const user = await prisma.user.findUnique({
      where: { email: this.key(email) },
      select: { lockedUntil: true },
    })
    if (!user?.lockedUntil) return false
    if (new Date() > user.lockedUntil) {
      // Expired — clear it in the background
      prisma.user
        .update({
          where: { email: this.key(email) },
          data: { lockedUntil: null, loginFailures: 0 },
        })
        .catch(() => {})
      return false
    }
    return true
  }

  /** Returns seconds remaining on lockout (0 if not locked) */
  async lockoutRemainingSeconds(email: string): Promise<number> {
    const user = await prisma.user.findUnique({
      where: { email: this.key(email) },
      select: { lockedUntil: true },
    })
    if (!user?.lockedUntil) return 0
    return Math.max(0, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000))
  }

  /** Call on failed login. Returns updated failure count and whether locked. */
  async recordFailure(email: string): Promise<{ failures: number; locked: boolean }> {
    const user = await prisma.user.findUnique({
      where: { email: this.key(email) },
      select: { id: true, loginFailures: true },
    })

    // No user with this email — don't create phantom records
    if (!user) return { failures: 0, locked: false }

    const newFailures = user.loginFailures + 1
    const shouldLock = newFailures >= LOCKOUT_THRESHOLD

    await prisma.user.update({
      where: { id: user.id },
      data: {
        loginFailures: newFailures,
        ...(shouldLock && { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) }),
      },
    })

    return { failures: newFailures, locked: shouldLock }
  }

  /** Call on successful login or password reset — clears all failures */
  async clear(email: string): Promise<void> {
    await prisma.user.updateMany({
      where: { email: this.key(email) },
      data: { loginFailures: 0, lockedUntil: null },
    })
  }

  /** Admin endpoint — clear lockout for a specific email */
  async adminClear(email: string): Promise<void> {
    await prisma.user.updateMany({
      where: { email: this.key(email) },
      data: { loginFailures: 0, lockedUntil: null },
    })
  }

  /** Returns all currently locked accounts with seconds remaining */
  async getLockedAccounts(): Promise<{ email: string; remainingSeconds: number }[]> {
    const now = new Date()
    const users = await prisma.user.findMany({
      where: { lockedUntil: { gt: now } },
      select: { email: true, lockedUntil: true },
    })
    return users.map((u) => ({
      email: u.email,
      remainingSeconds: Math.ceil((u.lockedUntil!.getTime() - now.getTime()) / 1000),
    }))
  }
}

export const loginAttempts = new LoginAttemptsStore()
