/**
 * Google Sheets access via a service account.
 *
 * Extracted from prisma/scripts/daily-report-google-sheets.ts so the long-running
 * server can share it with the one-shot report script. Two things differ from the
 * script's original copy, both because a server lives longer than a CLI run:
 *
 *   - Access tokens are cached per scope and reused until shortly before they
 *     expire, instead of minting a fresh one on every call.
 *   - The OAuth scope is a parameter, so readers can ask for read-only access
 *     rather than inheriting the report writer's read-write scope.
 *
 * Credentials come from GOOGLE_SERVICE_ACCOUNT_JSON, or from the
 * GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY pair.
 */
import { createSign } from "node:crypto"

export type ServiceAccount = { client_email: string; private_key: string }

/** Full read-write access, used by the daily report writer. */
export const SCOPE_SPREADSHEETS = "https://www.googleapis.com/auth/spreadsheets"
/** Read-only access. Preferred for anything that only needs to read a sheet. */
export const SCOPE_SPREADSHEETS_READONLY = "https://www.googleapis.com/auth/spreadsheets.readonly"

export function getServiceAccount(): ServiceAccount {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (json) {
    try {
      const parsed = JSON.parse(json)
      if (parsed.client_email && parsed.private_key) {
        return { client_email: parsed.client_email, private_key: parsed.private_key.replace(/\\n/g, "\n") }
      }
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.")
    }
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  if (email && privateKey) return { client_email: email, private_key: privateKey.replace(/\\n/g, "\n") }

  throw new Error(
    "Missing Google service-account credentials. Set GOOGLE_SERVICE_ACCOUNT_JSON, or both GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY."
  )
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url")
}

/** Cached token per scope, plus the in-flight promise so concurrent callers share one fetch. */
type CacheEntry = { token: string; expiresAt: number; inFlight?: Promise<string> }
const tokenCache = new Map<string, CacheEntry>()

/** Refresh this many ms before actual expiry, so a token can't die mid-request. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

async function mintAccessToken(account: ServiceAccount, scope: string): Promise<{ token: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claim = base64Url(JSON.stringify({
    iss: account.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }))
  const unsigned = `${header}.${claim}`
  const signer = createSign("RSA-SHA256")
  signer.update(unsigned)
  signer.end()
  const assertion = `${unsigned}.${base64Url(signer.sign(account.private_key))}`

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    })
    const body = (await response.json()) as {
      access_token?: string
      expires_in?: number
      error?: string
      error_description?: string
    }
    if (!response.ok || !body.access_token) {
      throw new Error(body.error_description || body.error || response.statusText)
    }
    return { token: body.access_token, expiresIn: body.expires_in ?? 3600 }
  } catch (error: any) {
    throw new Error(`Could not authenticate the Google service account: ${error?.message}`)
  }
}

/**
 * Get an access token for `scope`, reusing a cached one when it's still valid.
 * Concurrent callers share a single in-flight request rather than stampeding.
 */
export async function getGoogleAccessToken(
  account: ServiceAccount,
  scope: string = SCOPE_SPREADSHEETS
): Promise<string> {
  const cached = tokenCache.get(scope)
  if (cached) {
    if (Date.now() < cached.expiresAt) return cached.token
    if (cached.inFlight) return cached.inFlight
  }

  const inFlight = mintAccessToken(account, scope).then(
    ({ token, expiresIn }) => {
      tokenCache.set(scope, { token, expiresAt: Date.now() + expiresIn * 1000 - REFRESH_MARGIN_MS })
      return token
    },
    (error) => {
      tokenCache.delete(scope) // don't cache a failure
      throw error
    }
  )

  tokenCache.set(scope, { token: cached?.token ?? "", expiresAt: 0, inFlight })
  return inFlight
}

export async function googleRequest<T>(
  method: "GET" | "POST",
  path: string,
  token: string,
  data?: unknown
): Promise<T> {
  try {
    const response = await fetch(`https://sheets.googleapis.com/v4/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const body = (await response.json()) as T & { error?: { message?: string } }
    if (!response.ok) throw new Error(body.error?.message || response.statusText)
    return body
  } catch (error: any) {
    throw new Error(`Google Sheets API request failed: ${error?.message}`)
  }
}
