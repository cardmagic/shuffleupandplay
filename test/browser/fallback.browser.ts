import { expect, test } from "@playwright/test"

import { clickAction, joinTable, openTable, ownLife, seatState } from "./support.ts"

test("keeps the table updating when the socket never opens", async ({ page, browser }) => {
  await page.routeWebSocket(/\/live/, (socket) => socket.close())
  const seat = await openTable(page, "Alice")

  const opponentContext = await browser.newContext()
  const opponent = await opponentContext.newPage()
  await joinTable(opponent, seat.code, "Bob")
  await clickAction(opponent, '"delta":-1')
  await expect
    .poll(async () => (await seatState(opponent, seat.code)).life, { timeout: 30_000 })
    .toBe(19)

  await expect(page.locator(".opponent-seat .life-value")).toHaveText("19", { timeout: 40_000 })

  await opponentContext.close()
})

test("answers a long poll with the envelope the socket would have sent", async ({ page }) => {
  const seat = await openTable(page)

  const envelope = await page.evaluate(async (code) => {
    const response = await fetch(`/api/tables/${code}/changes?since=0&timeout=500`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
    return response.json()
  }, seat.code)

  expect(envelope.kind).toBe("invalidation")
  expect(envelope.actorType).toBe("GameRoom")
  expect(envelope.actorId).toBe(seat.code)
  expect(Object.keys(envelope.observables).sort()).toEqual(["lifeTotals", "version"])
  expect(envelope.invalidations.sort()).toEqual(["seatOne", "seatTwo"])
})

test("waits on a quiet table and answers nothing", async ({ page }) => {
  const seat = await openTable(page)

  const statuses = await page.evaluate(async (code) => {
    const first = await fetch(`/api/tables/${code}/changes?since=0&timeout=400`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
    const envelope = await first.json()
    const second = await fetch(
      `/api/tables/${code}/changes?since=${envelope.revision}&timeout=400`,
      { credentials: "same-origin", headers: { accept: "application/json" } },
    )
    return { first: first.status, second: second.status }
  }, seat.code)

  expect(statuses).toEqual({ first: 200, second: 204 })
})

test("still queues a move locally when the socket never opens", async ({ page }) => {
  await page.routeWebSocket(/\/live/, (socket) => socket.close())
  const seat = await openTable(page)

  await clickAction(page, '"delta":-1')

  await expect(ownLife(page)).toHaveText("19")
  await expect.poll(async () => (await seatState(page, seat.code)).life, { timeout: 30_000 }).toBe(19)
})
