import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"

export const SESSION_COOKIE_NAME = "mtgSession"

const COOKIE_MAXIMUM_AGE_SECONDS = 400 * 24 * 60 * 60

export function generateSessionId(): string {
  return randomUUID()
}

export function signSessionId(options: { sessionId: string; secret: string }): string {
  const value = Buffer.from(options.sessionId, "utf8").toString("base64url")
  return `${value}.${signature({ value, secret: options.secret })}`
}

export function readSessionCookie(options: {
  cookieHeader: string | undefined
  secret: string
}): string | null {
  const cookie = parseCookies(options.cookieHeader)[SESSION_COOKIE_NAME]
  if (!cookie) return null

  const separator = cookie.lastIndexOf(".")
  if (separator < 1) return null

  const value = cookie.slice(0, separator)
  const supplied = cookie.slice(separator + 1)
  if (!matchesSignature({ value, supplied, secret: options.secret })) return null

  return Buffer.from(value, "base64url").toString("utf8")
}

export function sessionCookieHeader(options: {
  sessionId: string
  secret: string
  secure: boolean
}): string {
  const signed = signSessionId({ sessionId: options.sessionId, secret: options.secret })
  const attributes = [
    `${SESSION_COOKIE_NAME}=${signed}`,
    "Path=/",
    `Max-Age=${COOKIE_MAXIMUM_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
  ]
  if (options.secure) attributes.push("Secure")

  return attributes.join("; ")
}

function signature(options: { value: string; secret: string }): string {
  return createHmac("sha256", options.secret).update(options.value).digest("base64url")
}

function matchesSignature(options: {
  value: string
  supplied: string
  secret: string
}): boolean {
  const expected = Buffer.from(signature({ value: options.value, secret: options.secret }))
  const supplied = Buffer.from(options.supplied)
  if (expected.length !== supplied.length) return false

  return timingSafeEqual(expected, supplied)
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const entry of (cookieHeader ?? "").split(";")) {
    const separator = entry.indexOf("=")
    if (separator < 1) continue

    cookies[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim()
  }
  return cookies
}
