import { createHash, timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"

import { createRateLimiter, type RateLimiter } from "./rate-limit.ts"

const REALM = "Shuffle Up and Play operators"
const MINIMUM_PASSWORD_LENGTH = 16
const ATTEMPT_LIMIT = 10
const ATTEMPT_WINDOW_MILLISECONDS = 5 * 60 * 1_000

export type OperatorVerdict = "granted" | "challenge" | "throttled"

export type OperatorGuard = {
  readonly challengeHeader: string
  verify(request: IncomingMessage): OperatorVerdict
}

export function operatorRealmHeader(): string {
  return `Basic realm="${REALM}", charset="UTF-8"`
}

export function requireOperatorPassword(options: {
  password: string | undefined
  production: boolean
}): string | undefined {
  const { password } = options
  if (password === undefined || password.length === 0) {
    if (!options.production) return undefined

    throw new Error(
      "SHUFFLE_OPERATOR_PASSWORD must be set to open the operator surface in production",
    )
  }
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new Error(
      `SHUFFLE_OPERATOR_PASSWORD must be at least ${MINIMUM_PASSWORD_LENGTH} characters`,
    )
  }

  return password
}

export function createOperatorGuard(options: { password: string | undefined }): OperatorGuard {
  const password = options.password
  const attempts: RateLimiter = createRateLimiter({
    limit: ATTEMPT_LIMIT,
    windowMilliseconds: ATTEMPT_WINDOW_MILLISECONDS,
  })

  return {
    challengeHeader: operatorRealmHeader(),
    verify: (request) => {
      if (password === undefined) {
        return loopbackAddress(request.socket.remoteAddress) ? "granted" : "challenge"
      }

      const key = request.socket.remoteAddress ?? "unknown"
      if (!attempts.allows({ key })) return "throttled"
      if (!matchesPassword({ header: request.headers.authorization, password })) return "challenge"

      return "granted"
    },
  }
}

export function matchesPassword(options: {
  header: string | undefined
  password: string
}): boolean {
  const supplied = basicPassword(options.header)
  if (supplied === null) return false

  return sameSecret(supplied, options.password)
}

function basicPassword(header: string | undefined): string | null {
  if (typeof header !== "string") return null

  const match = /^Basic +([A-Za-z0-9+/=]+)$/.exec(header.trim())
  if (!match) return null

  const decoded = decodeBase64(match[1] as string)
  if (decoded === null) return null

  const separator = decoded.indexOf(":")
  if (separator < 0) return null

  return decoded.slice(separator + 1)
}

function decodeBase64(value: string): string | null {
  try {
    const buffer = Buffer.from(value, "base64")
    if (buffer.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) return null

    return buffer.toString("utf8")
  } catch {
    return null
  }
}

function sameSecret(supplied: string, expected: string): boolean {
  const suppliedDigest = createHash("sha256").update(supplied).digest()
  const expectedDigest = createHash("sha256").update(expected).digest()

  return timingSafeEqual(suppliedDigest, expectedDigest)
}

export function loopbackAddress(address: string | undefined): boolean {
  if (address === "::1" || address === "127.0.0.1") return true

  return address?.startsWith("::ffff:127.") ?? false
}
