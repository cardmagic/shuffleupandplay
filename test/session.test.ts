import { describe, expect, test } from "vitest"

import { readSessionCookie, sessionCookieHeader, signSessionId } from "../src/server/session.ts"

const SECRET = "a-secret-that-is-long-enough-for-hmac"

describe("session cookies", () => {
  test("round trips a signed session identifier", () => {
    const signed = signSessionId({ sessionId: "session-1", secret: SECRET })

    expect(readSessionCookie({ cookieHeader: `shuffleSession=${signed}`, secret: SECRET })).toBe(
      "session-1",
    )
  })

  test("refuses a tampered value", () => {
    const forged = signSessionId({ sessionId: "session-2", secret: SECRET })
    const signature = signSessionId({ sessionId: "session-1", secret: SECRET }).split(".")[1]
    const tampered = `${forged.split(".")[0]}.${signature}`

    expect(readSessionCookie({ cookieHeader: `shuffleSession=${tampered}`, secret: SECRET })).toBeNull()
  })

  test("refuses a value signed with another secret", () => {
    const signed = signSessionId({ sessionId: "session-1", secret: "another-secret-value-here" })

    expect(readSessionCookie({ cookieHeader: `shuffleSession=${signed}`, secret: SECRET })).toBeNull()
  })

  test("returns null without a cookie", () => {
    expect(readSessionCookie({ cookieHeader: undefined, secret: SECRET })).toBeNull()
    expect(readSessionCookie({ cookieHeader: "other=1", secret: SECRET })).toBeNull()
  })

  test("reads one cookie out of several", () => {
    const signed = signSessionId({ sessionId: "session-1", secret: SECRET })

    expect(
      readSessionCookie({ cookieHeader: `theme=dark; shuffleSession=${signed}; other=1`, secret: SECRET }),
    ).toBe("session-1")
  })

  test("writes a long lived host only cookie", () => {
    const header = sessionCookieHeader({ sessionId: "session-1", secret: SECRET, secure: true })

    expect(header).toContain("shuffleSession=")
    expect(header).toContain("HttpOnly")
    expect(header).toContain("SameSite=Lax")
    expect(header).toContain("Secure")
    expect(header).toContain("Path=/")
  })

  test("omits the secure attribute for plain http", () => {
    const header = sessionCookieHeader({ sessionId: "session-1", secret: SECRET, secure: false })

    expect(header).not.toContain("Secure")
  })
})
