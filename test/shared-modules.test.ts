import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { applyPlayerAction, buildPlayer } from "../src/game/player.ts"
import { jsonRequest, startTestServer, type TestClient, type TestServer } from "./support/server.ts"
import type { Card, Player } from "../src/game/types.ts"

let server: TestServer

beforeEach(async () => {
  server = await startTestServer()
})

afterEach(async () => {
  await server.close()
})

const CARDS: Card[] = [
  {
    instanceId: "forest-1",
    name: "Forest",
    scryfallId: "forest",
    imageUrl: "https://example.com/forest.jpg",
    tapped: false,
    isManaSource: true,
  },
  {
    instanceId: "bear-1",
    name: "Grizzly Bears",
    scryfallId: "bear",
    imageUrl: "https://example.com/bear.jpg",
    tapped: false,
    isManaSource: false,
  },
]

function seatedPlayer(): Player {
  const player = buildPlayer({
    name: "Alice",
    sessionId: "session-1",
    seat: 1,
    identifier: "player-1",
  })
  return { ...player, library: CARDS }
}

describe("shared module route", () => {
  test("serves the game rule as JavaScript with the type annotations removed", async () => {
    const response = await server.client().fetch("/shared/game/player.ts")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8")

    const source = await response.text()
    expect(source).toContain("export function applyPlayerAction")
    expect(source).not.toContain(": Player")
    expect(source).not.toContain("export interface")
  })

  test("serves every module the game rule imports", async () => {
    const response = await server.client().fetch("/shared/game/randomness.ts")

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("export const defaultRandomness")
  })

  test("keeps the browser rule and the server rule identical", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shuffle-shared-"))
    try {
      for (const name of ["player", "randomness"]) {
        const source = await (await server.client().fetch(`/shared/game/${name}.ts`)).text()
        writeFileSync(join(directory, `${name}.mjs`), source.replaceAll(".ts\"", ".mjs\""))
      }

      const browserRule = (await import(
        pathToFileURL(join(directory, "player.mjs")).href
      )) as typeof import("../src/game/player.ts")

      const player = seatedPlayer()
      const action = { type: "drawCard", count: 2 } as const

      expect(browserRule.applyPlayerAction({ player, action })).toEqual(
        applyPlayerAction({ player, action }),
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("serves the seat renderer so the browser can redraw its own seat", async () => {
    const response = await server.client().fetch("/shared/server/render/components.ts")

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("export function renderComponent")
  })

  test("refuses a module that is not shared", async () => {
    const response = await server.client().fetch("/shared/runtime.ts")

    expect(response.status).toBe(404)
  })

  test("refuses to escape the source directory", async () => {
    const response = await server.client().fetch("/shared/../../package.json")

    expect(response.status).toBe(404)
  })

  test("never creates a session", async () => {
    const response = await server.client().fetch("/shared/game/player.ts")

    expect(response.headers.getSetCookie()).toEqual([])
  })

  test("points the mirror at the browser runtime instead of the bare package", async () => {
    const response = await server.client().fetch("/shared/actors/table-mirror.ts")

    expect(response.status).toBe(200)
    const source = await response.text()
    expect(source).toMatch(/from "\/vendor\/[a-f0-9]{12}\/live\/browser\/host\.js"/)
    expect(source).not.toContain('from "solid-objects"')
  })
})

describe("vendored browser runtime", () => {
  test("serves the browser runtime entry", async () => {
    const response = await server.client().fetch("/vendor/live/browser/host.js")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
  })

  test("resolves the bare package a module worker cannot resolve on its own", async () => {
    const response = await server.client().fetch("/vendor/live/database/sqlite-wasm.js")

    expect(response.status).toBe(200)
    const source = await response.text()
    expect(source).toMatch(/from "\/vendor\/[a-f0-9]{12}\/sqlite\/index\.mjs"/)
    expect(source).not.toContain('from "@sqlite.org/sqlite-wasm"')
  })

  test("serves the SQLite build the runtime imports", async () => {
    const response = await server.client().fetch("/vendor/sqlite/index.mjs")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
  })

  test("serves the WebAssembly binary so the browser can compile it", async () => {
    const response = await server.client().fetch("/vendor/sqlite/sqlite3.wasm", { method: "HEAD" })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/wasm")
  })

  test("never creates a session", async () => {
    const response = await server.client().fetch("/vendor/sqlite/index.mjs")

    expect(response.headers.getSetCookie()).toEqual([])
  })
})

describe("stamped browser modules", () => {
  async function entryModule(client: TestClient, pattern: RegExp): Promise<string> {
    const html = await (await client.fetch("/", { headers: { accept: "text/html" } })).text()
    const asset = pattern.exec(html)?.[0] ?? ""
    if (!asset) throw new Error("the lobby names no matching module")

    return (await client.fetch(asset)).text()
  }

  async function workerModule(client: TestClient): Promise<string> {
    const created = await client.json<{ space: { code: string } }>(
      "/api/tables",
      jsonRequest({ playerName: "Alice", tableName: "Kitchen Table" }),
    )
    const page = await (
      await client.fetch(`/tables/${created.space.code}`, { headers: { accept: "text/html" } })
    ).text()
    const url = /\/assets\/table-worker\.[a-f0-9]{12}\.js/.exec(page)?.[0] ?? ""
    if (!url) throw new Error("the table page names no worker module")

    return (await client.fetch(url)).text()
  }

  test("points the page at a stamped shared module", async () => {
    const source = await entryModule(server.client(), /\/assets\/shuffle\.[a-f0-9]{12}\.js/)

    expect(source).toMatch(/from "\/shared\/[a-f0-9]{12}\/server\/render\/components\.ts"/)
    expect(source).not.toContain('from "/shared/server/render/components.ts"')
  })

  test("points the worker at a stamped runtime and mirror", async () => {
    const source = await workerModule(server.client())

    expect(source).toMatch(/from "\/vendor\/[a-f0-9]{12}\/live\/browser\/host\.js"/)
    expect(source).toMatch(/from "\/shared\/[a-f0-9]{12}\/actors\/table-mirror\.ts"/)
  })

  test("serves a stamped shared module immutably", async () => {
    const client = server.client()
    const source = await entryModule(client, /\/assets\/shuffle\.[a-f0-9]{12}\.js/)
    const url = /\/shared\/[a-f0-9]{12}\/server\/render\/components\.ts/.exec(source)?.[0] ?? ""

    const response = await client.fetch(url)

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(await response.text()).toContain("export function renderComponent")
  })

  test("serves a stamped vendor module immutably", async () => {
    const client = server.client()
    const source = await workerModule(client)
    const url = /\/vendor\/[a-f0-9]{12}\/live\/browser\/host\.js/.exec(source)?.[0] ?? ""

    const response = await client.fetch(url)

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  })

  test("keeps a shared module's own imports relative, so they inherit the stamp", async () => {
    const client = server.client()
    const source = await workerModule(client)
    const url = /\/shared\/[a-f0-9]{12}\/actors\/table-mirror\.ts/.exec(source)?.[0] ?? ""

    const mirror = await (await client.fetch(url)).text()

    expect(mirror).toContain('from "../game/player.ts"')
    expect(mirror).toMatch(/from "\/vendor\/[a-f0-9]{12}\/live\/browser\/host\.js"/)
  })

  test("keeps a vendor module's bare specifier inside the same stamp", async () => {
    const client = server.client()
    const source = await workerModule(client)
    const stamp = /\/vendor\/([a-f0-9]{12})\//.exec(source)?.[1] ?? ""

    const adapter = await (
      await client.fetch(`/vendor/${stamp}/live/database/sqlite-wasm.js`)
    ).text()

    expect(adapter).toContain(`from "/vendor/${stamp}/sqlite/index.mjs"`)
  })
})
