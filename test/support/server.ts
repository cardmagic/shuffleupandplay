import { startTestRuntime, type TestRuntime, type TestRuntimeOptions } from "./runtime.ts"
import {
  createPlaymatServer,
  type PlaymatOperatorDashboardOptions,
} from "../../src/server/app.ts"

const SECRET = "test-secret-that-is-long-enough-for-hmac"

export type TestServer = {
  harness: TestRuntime
  origin: string
  secret: string
  client(): TestClient
  close(): Promise<void>
}

export type TestClient = {
  cookie: string | null
  fetch(path: string, init?: RequestInit): Promise<Response>
  json<Result>(path: string, init?: RequestInit): Promise<Result>
}

export type TestServerOptions = TestRuntimeOptions & {
  operatorDashboard?: PlaymatOperatorDashboardOptions
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const { operatorDashboard, ...runtimeOptions } = options
  const harness = await startTestRuntime(runtimeOptions)
  const server = createPlaymatServer({
    application: harness.application,
    secret: SECRET,
    ...(operatorDashboard ? { operatorDashboard } : {}),
  })
  const port = await server.listen(0)
  const origin = `http://127.0.0.1:${port}`

  return {
    harness,
    origin,
    secret: SECRET,
    client: () => createClient(origin),
    close: async () => {
      await server.close()
      await harness.close()
    },
  }
}

function createClient(origin: string): TestClient {
  const client: TestClient = {
    cookie: null,
    fetch: async (path, init = {}) => {
      const headers = new Headers(init.headers)
      if (client.cookie) headers.set("cookie", client.cookie)
      if (!headers.has("accept")) headers.set("accept", "application/json")

      const response = await fetch(new URL(path, origin), {
        ...init,
        headers,
        redirect: "manual",
      })
      const setCookie = response.headers.getSetCookie()[0]
      if (setCookie) client.cookie = setCookie.split(";")[0] ?? null

      return response
    },
    json: async <Result,>(path: string, init?: RequestInit): Promise<Result> => {
      const response = await client.fetch(path, init)
      return (await response.json()) as Result
    },
  }
  return client
}

export function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

export function formRequest(body: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
    body: new URLSearchParams(body).toString(),
  }
}
