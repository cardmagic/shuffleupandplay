import { describe, expect, test } from "vitest"

import { createShutdown } from "../src/server/shutdown.ts"

describe("createShutdown", () => {
  test("runs the close routine once however often it is called", async () => {
    let closes = 0
    const stop = createShutdown(async () => {
      closes += 1
    })

    await Promise.all([stop(), stop(), stop()])

    expect(closes).toBe(1)
  })

  test("makes every caller wait for the close already in progress", async () => {
    let released = () => {}
    let finished = false
    const stop = createShutdown(async () => {
      await new Promise<void>((resolve) => {
        released = resolve
      })
      finished = true
    })

    const first = stop()
    const second = stop()
    expect(finished).toBe(false)

    released()
    await Promise.all([first, second])

    expect(finished).toBe(true)
  })

  test("reports a close failure to every caller", async () => {
    const stop = createShutdown(async () => {
      throw new Error("the database refused to close")
    })

    await expect(stop()).rejects.toThrow("the database refused to close")
    await expect(stop()).rejects.toThrow("the database refused to close")
  })
})
