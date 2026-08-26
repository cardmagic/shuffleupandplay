import { createHash, timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"

const REALM = "Shuffle Up and Play operators"
const MINIMUM_PASSWORD_LENGTH = 16
const FAILURE_LIMIT = 10
const FAILURE_WINDOW_MILLISECONDS = 5 * 60 * 1_000
const MAXIMUM_TRACKED_CLIENTS = 10_000

type FailureWindow = { windowStart: number; count: number }

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
  const failures = new Map<string, FailureWindow>()

  return {
    challengeHeader: operatorRealmHeader(),
    verify: (request) => {
      if (password === undefined) {
        return loopbackAddress(request.socket.remoteAddress) ? "granted" : "challenge"
      }

      const key = clientKey(request)
      const now = Date.now()
      if (failureCount({ failures, key, now }) >= FAILURE_LIMIT) return "throttled"

      if (matchesPassword({ header: request.headers.authorization, password })) {
        failures.delete(key)
        return "granted"
      }

      recordFailure({ failures, key, now })
      return "challenge"
    },
  }
}

export function clientKey(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"]
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim()
  if (first) return first

  return request.socket.remoteAddress ?? "unknown"
}

function failureCount(options: {
  failures: Map<string, FailureWindow>
  key: string
  now: number
}): number {
  const window = options.failures.get(options.key)
  if (!window) return 0
  if (options.now - window.windowStart >= FAILURE_WINDOW_MILLISECONDS) {
    options.failures.delete(options.key)
    return 0
  }

  return window.count
}

function recordFailure(options: {
  failures: Map<string, FailureWindow>
  key: string
  now: number
}): void {
  const { failures, key, now } = options
  const window = failures.get(key)
  if (window) {
    window.count += 1
    return
  }

  if (failures.size >= MAXIMUM_TRACKED_CLIENTS) {
    const oldest = failures.keys().next().value
    if (oldest !== undefined) failures.delete(oldest)
  }
  failures.set(key, { windowStart: now, count: 1 })
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
