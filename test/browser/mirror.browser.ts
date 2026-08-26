import { expect, test } from "@playwright/test"

import {
  clickAction,
  loadDeck,
  openTable,
  originStorageNames,
  ownLife,
  seatState,
  waitForMirror,
} from "./support.ts"

test("keeps its durable database in origin storage", async ({ page }) => {
  await openTable(page)
  await waitForMirror(page)

  expect(await originStorageNames(page)).toContain(".opfs-sahpool")
})

test("draws the move before the table has answered", async ({ page }) => {
  const seat = await openTable(page)
  await waitForMirror(page)

  await page.route("**/api/tables/*/sync", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    await route.abort()
  })
  await clickAction(page, '"delta":-1')

  await expect(ownLife(page)).toHaveText("19", { timeout: 1_000 })
  expect((await seatState(page, seat.code)).life).toBe(20)
})

test("carries the move to the table", async ({ page }) => {
  const seat = await openTable(page)
  await waitForMirror(page)

  await clickAction(page, '"delta":-1')

  await expect.poll(async () => (await seatState(page, seat.code)).life).toBe(19)
  await expect.poll(async () => (await seatState(page, seat.code)).appliedMove).toBe(1)
})

test("keeps a move made with no network and lands it once when the network returns", async ({
  page,
  context,
}) => {
  const seat = await openTable(page)
  await waitForMirror(page)
  await clickAction(page, '"delta":-1')
  await expect.poll(async () => (await seatState(page, seat.code)).life).toBe(19)

  await context.setOffline(true)
  for (let move = 0; move < 3; move += 1) await clickAction(page, '"delta":-1')

  await expect(ownLife(page)).toHaveText("16")
  await expect(page.locator("[data-queued-moves]")).toHaveText("3 moves waiting")

  await context.setOffline(false)

  await expect.poll(async () => (await seatState(page, seat.code)).life, { timeout: 30_000 }).toBe(16)
  await expect(page.locator("[data-queued-moves]")).toBeHidden()
  await expect(ownLife(page)).toHaveText("16")
})

test("never applies a replayed move twice", async ({ page }) => {
  const seat = await openTable(page)
  await waitForMirror(page)

  let deliveries = 0
  await page.route("**/api/tables/*/sync", async (route) => {
    deliveries += 1
    await route.continue()
    if (deliveries === 1) await route.request().response()
  })

  await clickAction(page, '"delta":-1')
  await expect.poll(async () => (await seatState(page, seat.code)).appliedMove).toBe(1)

  const settled = await seatState(page, seat.code)
  expect(settled.life).toBe(19)
})

test("keeps the queue across a reload", async ({ page, context }) => {
  const seat = await openTable(page)
  await waitForMirror(page)
  await expect.poll(async () => (await seatState(page, seat.code)).life).toBe(20)

  await context.setOffline(true)
  await clickAction(page, '"delta":-1')
  await expect(page.locator("[data-queued-moves]")).toHaveText("1 move waiting")

  await context.setOffline(false)
  await page.reload()
  await waitForMirror(page)

  await expect.poll(async () => (await seatState(page, seat.code)).life, { timeout: 30_000 }).toBe(19)
})

test("keeps retrying a move well past the default attempt budget", async ({ page }) => {
  test.setTimeout(120_000)
  const seat = await openTable(page)
  await waitForMirror(page)

  let attempts = 0
  await page.route("**/api/tables/*/sync", async (route) => {
    attempts += 1
    if (attempts <= 6) return route.abort()

    return route.continue()
  })

  await clickAction(page, '"delta":-1')

  await expect
    .poll(async () => (await seatState(page, seat.code)).life, { timeout: 90_000 })
    .toBe(19)
  expect(attempts).toBeGreaterThan(6)
})

test("runs the same rule the table runs", async ({ page }) => {
  const seat = await openTable(page)
  await loadDeck(page, seat.code)
  await waitForMirror(page)

  await clickAction(page, '"drawCard"')

  await expect.poll(async () => (await seatState(page, seat.code)).hand.length).toBe(1)
  const settled = await seatState(page, seat.code)
  expect(settled.library.length).toBe(11)
  await expect(page.locator(".your-seat .hand-strip .hand-card")).toHaveCount(1)
})
