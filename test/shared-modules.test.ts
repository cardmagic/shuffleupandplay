import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { applyPlayerAction, buildPlayer } from "../src/game/player.ts"
import { startTestServer, type TestServer } from "./support/server.ts"
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
    expect(source).toContain('from "/vendor/live/browser/host.js"')
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
    expect(source).toContain('from "/vendor/sqlite/index.mjs"')
    expect(source).not.toContain('from "@sqlite.org/sqlite-wasm"')
  })

  test("serves the SQLite build the runtime imports", async () => {
    const response = await server.client().fetch("/vendor/sqlite/index.mjs")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
  })

  test("serves the WebAssembly binary so the browser can compile it", async () => {
    const response = await server.client().fetch("/vendor/sqlite/sqlite3.wasm")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/wasm")
  })

  test("never creates a session", async () => {
    const response = await server.client().fetch("/vendor/sqlite/index.mjs")

    expect(response.headers.getSetCookie()).toEqual([])
  })
})
