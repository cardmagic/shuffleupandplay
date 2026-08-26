import { afterEach, describe, expect, test } from "vitest"

import { matchesPassword, requireOperatorPassword } from "../src/server/operator-access.ts"
import { startTestServer, type TestServer } from "./support/server.ts"

const PASSWORD = "a-long-operator-password-value"
const DASHBOARD = "/solid-objects/dashboard"
const TABLES = "/api/operator/tables"

let server: TestServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

function basic(password: string, user = "operator"): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
}

async function guarded(): Promise<TestServer> {
  server = await startTestServer({
    operatorDashboard: { access: "authorized-read-only", password: PASSWORD },
  })
  return server
}

describe("an operator surface with a password", () => {
  test("asks for credentials when none arrive", async () => {
    const started = await guarded()

    const response = await started.client().fetch(TABLES)

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic realm=/)
  })

  test("asks for credentials on the dashboard as well", async () => {
    const started = await guarded()

    const response = await started.client().fetch(DASHBOARD, { headers: { accept: "text/html" } })

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic realm=/)
  })

  test("refuses the wrong password", async () => {
    const started = await guarded()

    const response = await started
      .client()
      .fetch(TABLES, { headers: { authorization: basic("not-the-password") } })

    expect(response.status).toBe(401)
  })

  test("refuses a malformed authorization header", async () => {
    const started = await guarded()

    for (const authorization of ["Basic", "Basic !!!", "Bearer token", PASSWORD]) {
      const response = await started.client().fetch(TABLES, { headers: { authorization } })

      expect(response.status, authorization).toBe(401)
    }
  })

  test("accepts the right password whatever the user name", async () => {
    const started = await guarded()

    const response = await started
      .client()
      .fetch(TABLES, { headers: { authorization: basic(PASSWORD, "anyone") } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tables: [] })
  })

  test("renders the dashboard once the password is right", async () => {
    const started = await guarded()

    const response = await started.client().fetch(DASHBOARD, {
      headers: { accept: "text/html", authorization: basic(PASSWORD) },
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("<html")
    expect(body).not.toContain("not authorized")
  })

  test("requires the password even from the loopback address", async () => {
    const started = await guarded()

    const response = await started.client().fetch(TABLES)

    expect(response.status).toBe(401)
  })

  test("never answers a player route with a challenge", async () => {
    const started = await guarded()

    const response = await started.client().fetch("/", { headers: { accept: "text/html" } })

    expect(response.status).toBe(200)
    expect(response.headers.get("www-authenticate")).toBeNull()
  })

  test("never spends the guessing budget on a request that succeeds", async () => {
    const started = await guarded()
    const client = started.client()

    const statuses: number[] = []
    for (let request = 0; request < 40; request += 1) {
      const response = await client.fetch(TABLES, {
        headers: { authorization: basic(PASSWORD) },
      })
      statuses.push(response.status)
    }

    expect(new Set(statuses)).toEqual(new Set([200]))
  })

  test("lets an operator through after a wrong attempt or two", async () => {
    const started = await guarded()
    const client = started.client()

    await client.fetch(TABLES, { headers: { authorization: basic("fat-fingered") } })
    await client.fetch(TABLES, { headers: { authorization: basic("fat-fingered-again") } })
    const response = await client.fetch(TABLES, { headers: { authorization: basic(PASSWORD) } })

    expect(response.status).toBe(200)
  })

  test("loads every part of the dashboard in one visit", async () => {
    const started = await guarded()
    const client = started.client()
    const authorization = basic(PASSWORD)

    const page = await client.fetch(DASHBOARD, { headers: { accept: "text/html", authorization } })
    const markup = await page.text()
    const references = [...markup.matchAll(/(?:src|href)="(\/solid-objects\/[^"]+)"/g)].map(
      (match) => match[1] as string,
    )

    expect(references.length).toBeGreaterThan(1)
    for (const reference of references) {
      const response = await client.fetch(reference, { headers: { authorization } })

      expect(response.status, reference).toBe(200)
    }
  })

  test("loads nothing the page's own policy would block", async () => {
    const started = await guarded()
    const client = started.client()
    const authorization = basic(PASSWORD)

    const page = await client.fetch(DASHBOARD, { headers: { accept: "text/html", authorization } })
    const markup = await page.text()
    const policy = page.headers.get("content-security-policy") ?? ""

    expect(policy).toContain("script-src 'self'")
    expect([...markup.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1])).not.toContain(
      expect.stringMatching(/^https?:\/\//),
    )
    expect(markup).not.toContain("cdn.jsdelivr.net")
  })

  test("stops guessing after a burst of wrong passwords", async () => {
    const started = await guarded()
    const client = started.client()

    const statuses: number[] = []
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await client.fetch(TABLES, {
        headers: { authorization: basic(`guess-${attempt}`) },
      })
      statuses.push(response.status)
    }

    expect(statuses).toContain(429)
  })

  test("keeps refusing a guesser that later finds the password", async () => {
    const started = await guarded()
    const client = started.client()

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await client.fetch(TABLES, { headers: { authorization: basic(`guess-${attempt}`) } })
    }
    const response = await client.fetch(TABLES, {
      headers: { authorization: basic(PASSWORD) },
    })

    expect(response.status).toBe(429)
  })
})

describe("counting attempts per client behind a proxy", () => {
  test("never lets one guesser lock everybody else out", async () => {
    const started = await guarded()
    const client = started.client()

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await client.fetch(TABLES, {
        headers: { authorization: basic(`guess-${attempt}`), "x-forwarded-for": "203.0.113.7" },
      })
    }

    const guesser = await client.fetch(TABLES, {
      headers: { authorization: basic(PASSWORD), "x-forwarded-for": "203.0.113.7" },
    })
    const other = await client.fetch(TABLES, {
      headers: { authorization: basic(PASSWORD), "x-forwarded-for": "198.51.100.4" },
    })

    expect(guesser.status).toBe(429)
    expect(other.status).toBe(200)
  })

  test("reads the client from the first entry the proxy forwarded", async () => {
    const started = await guarded()
    const client = started.client()

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await client.fetch(TABLES, {
        headers: {
          authorization: basic(`guess-${attempt}`),
          "x-forwarded-for": "203.0.113.9, 10.0.0.1",
        },
      })
    }

    const same = await client.fetch(TABLES, {
      headers: { authorization: basic(PASSWORD), "x-forwarded-for": "203.0.113.9, 10.0.0.2" },
    })

    expect(same.status).toBe(429)
  })
})

describe("an operator surface with no password", () => {
  test("still trusts the loopback address, for the command line", async () => {
    server = await startTestServer({ operatorDashboard: { access: "authorized" } })

    const response = await server.client().fetch(TABLES)

    expect(response.status).toBe(200)
  })
})

describe("no operator surface", () => {
  test("hides the dashboard and the table view", async () => {
    server = await startTestServer()

    expect((await server.client().fetch(TABLES)).status).toBe(404)
  })
})

describe("the boot guard", () => {
  test("refuses to open the surface in production with no password", () => {
    expect(() => requireOperatorPassword({ password: undefined, production: true })).toThrow(
      /SHUFFLE_OPERATOR_PASSWORD must be set/,
    )
    expect(() => requireOperatorPassword({ password: "", production: true })).toThrow(
      /SHUFFLE_OPERATOR_PASSWORD must be set/,
    )
  })

  test("refuses a password short enough to guess", () => {
    expect(() => requireOperatorPassword({ password: "short", production: true })).toThrow(
      /at least 16 characters/,
    )
    expect(() => requireOperatorPassword({ password: "short", production: false })).toThrow(
      /at least 16 characters/,
    )
  })

  test("accepts a long password", () => {
    expect(requireOperatorPassword({ password: PASSWORD, production: true })).toBe(PASSWORD)
  })

  test("leaves the surface open to the command line outside production", () => {
    expect(requireOperatorPassword({ password: undefined, production: false })).toBeUndefined()
  })
})

describe("password checking", () => {
  test("accepts only the exact password", () => {
    const header = (value: string) => `Basic ${Buffer.from(`operator:${value}`).toString("base64")}`

    expect(matchesPassword({ header: header(PASSWORD), password: PASSWORD })).toBe(true)
    expect(matchesPassword({ header: header(`${PASSWORD}x`), password: PASSWORD })).toBe(false)
    expect(matchesPassword({ header: header(PASSWORD.slice(1)), password: PASSWORD })).toBe(false)
    expect(matchesPassword({ header: undefined, password: PASSWORD })).toBe(false)
  })

  test("reads a password that holds a colon", () => {
    const password = "one:two:three-and-more"
    const header = `Basic ${Buffer.from(`operator:${password}`).toString("base64")}`

    expect(matchesPassword({ header, password })).toBe(true)
  })
})
