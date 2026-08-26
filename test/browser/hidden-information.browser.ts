import { expect, test, type Page } from "@playwright/test"

import { clickAction, joinTable, loadDeck, openTable, waitForMirror } from "./support.ts"

const CARD_NAME = "Test Card"

function watchTraffic(page: Page): string[] {
  const bodies: string[] = []

  page.on("websocket", (socket) => {
    socket.on("framereceived", (frame) => bodies.push(String(frame.payload)))
  })
  page.on("response", async (response) => {
    if (!response.url().includes("/api/")) return
    try {
      bodies.push(await response.text())
    } catch {
      return
    }
  })

  return bodies
}

test("never sends one seat's hand to the other seat", async ({ page, browser }) => {
  const seat = await openTable(page, "Alice")
  await loadDeck(page, seat.code)
  await waitForMirror(page)
  await clickAction(page, '"drawCard"')
  await expect(page.locator(".your-seat .hand-strip .hand-card")).toHaveCount(1)

  const opponentContext = await browser.newContext()
  const opponent = await opponentContext.newPage()
  const traffic = watchTraffic(opponent)
  await joinTable(opponent, seat.code, "Bob")
  await waitForMirror(opponent)

  await expect(opponent.locator(".opponent-seat")).toBeVisible()
  await expect(opponent.locator(".opponent-seat .hand-strip")).toHaveCount(0)

  const markup = await opponent.content()
  expect(markup).not.toContain(CARD_NAME)
  expect(traffic.join("\n")).not.toContain(CARD_NAME)

  await opponentContext.close()
})

test("shows the opponent a hidden card for every card they hold", async ({ page, browser }) => {
  const seat = await openTable(page, "Alice")
  await loadDeck(page, seat.code)
  await waitForMirror(page)

  const opponentContext = await browser.newContext()
  const opponent = await opponentContext.newPage()
  await joinTable(opponent, seat.code, "Bob")

  const counts = await opponent.evaluate(async (code) => {
    const response = await fetch(`/api/tables/${code}/state`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
    const body = await response.json()
    const other = body.space.players.find(
      (player: { id: string }) => player.id !== body.currentPlayerId,
    )
    return {
      library: other.library.length,
      hiddenLibrary: other.library.filter((card: { isHidden?: boolean }) => card.isHidden).length,
      names: [...new Set(other.library.map((card: { name: string }) => card.name))],
    }
  }, seat.code)

  expect(counts.library).toBe(12)
  expect(counts.hiddenLibrary).toBe(12)
  expect(counts.names).toEqual(["Hidden card"])

  await opponentContext.close()
})

test("keeps a stranger out of a table they hold no seat at", async ({ page, browser }) => {
  const seat = await openTable(page, "Alice")
  await loadDeck(page, seat.code)

  const strangerContext = await browser.newContext()
  const stranger = await strangerContext.newPage()
  await stranger.goto("/")

  const attempts = await stranger.evaluate(async (code) => {
    const results: Record<string, number> = {}
    for (const path of [
      `/api/tables/${code}/state`,
      `/api/tables/${code}/changes?since=0&timeout=250`,
    ]) {
      results[path] = (await fetch(path, { headers: { accept: "application/json" } })).status
    }
    const sync = await fetch(`/api/tables/${code}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        effectId: "01930000-0000-7000-8000-000000000001",
        operation: "applyAction",
        arguments: { action: { type: "adjustLife", delta: -20 } },
      }),
    })
    results.sync = sync.status
    return results
  }, seat.code)

  expect(Object.values(attempts).every((status) => status === 403 || status === 404)).toBe(true)

  await strangerContext.close()
})

test("redirects a stranger away from the table page", async ({ page, browser }) => {
  const seat = await openTable(page, "Alice")

  const strangerContext = await browser.newContext()
  const stranger = await strangerContext.newPage()
  await stranger.goto(`/tables/${seat.code}`)

  await expect(stranger).toHaveURL(new RegExp(`/\\?join=${seat.code}$`))
  await expect(stranger.locator(".your-seat")).toHaveCount(0)

  await strangerContext.close()
})
