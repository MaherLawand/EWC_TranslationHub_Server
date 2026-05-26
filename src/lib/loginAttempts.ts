/**
 * In-memory login attempt tracker.
 *
 * Rules:
 * - After 5 failed attempts → account locked for 5 minutes
 * - Lockout clears automatically after 5 min
 * - Lockout also clears on: successful login, password reset, admin clear
 */

interface AttemptRecord {
  failures: number
  lockedUntil: number | null
}

class LoginAttemptsStore {
  private store = new Map<string, AttemptRecord>()

  private key(email: string) {
    return email.toLowerCase().trim()
  }

  private get(email: string): AttemptRecord {
    return this.store.get(this.key(email)) ?? { failures: 0, lockedUntil: null }
  }

  /** Returns true if the account is currently locked out */
  isLocked(email: string): boolean {
    const record = this.get(email)
    if (!record.lockedUntil) return false
    if (Date.now() > record.lockedUntil) {
      this.store.delete(this.key(email))
      return false
    }
    return true
  }

  /** Returns seconds remaining on lockout (0 if not locked) */
  lockoutRemainingSeconds(email: string): number {
    const record = this.get(email)
    if (!record.lockedUntil) return 0
    return Math.max(0, Math.ceil((record.lockedUntil - Date.now()) / 1000))
  }

  /** Call on failed login. Returns updated failure count and whether locked. */
  recordFailure(email: string): { failures: number; locked: boolean } {
    const record = this.get(email)
    record.failures += 1

    if (record.failures >= 5) {
      record.lockedUntil = Date.now() + 5 * 60 * 1000 // 5 min lockout
    }

    this.store.set(this.key(email), record)
    return { failures: record.failures, locked: !!record.lockedUntil }
  }

  /** Call on successful login or password reset — clears all failures */
  clear(email: string): void {
    this.store.delete(this.key(email))
  }

  /** Admin endpoint — clear lockout for a specific email */
  adminClear(email: string): void {
    this.store.delete(this.key(email))
  }

  /** Returns all currently locked accounts with seconds remaining */
  getLockedAccounts(): { email: string; remainingSeconds: number }[] {
    const now = Date.now()
    const results: { email: string; remainingSeconds: number }[] = []
    for (const [email, record] of this.store.entries()) {
      if (record.lockedUntil && record.lockedUntil > now) {
        results.push({
          email,
          remainingSeconds: Math.ceil((record.lockedUntil - now) / 1000),
        })
      }
    }
    return results
  }
}

export const loginAttempts = new LoginAttemptsStore()
