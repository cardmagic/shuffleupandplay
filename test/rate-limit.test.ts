import { describe, expect, test } from "vitest"

import { createRateLimiter } from "../src/server/rate-limit.ts"

describe("createRateLimiter", () => {
  test("allows requests up to the limit and refuses the next one", () => {
    const limiter = createRateLimiter({ limit: 3, windowMilliseconds: 1_000 })

    expect(limiter.allows({ key: "alice", now: 0 })).toBe(true)
    expect(limiter.allows({ key: "alice", now: 10 })).toBe(true)
    expect(limiter.allows({ key: "alice", now: 20 })).toBe(true)
    expect(limiter.allows({ key: "alice", now: 30 })).toBe(false)
  })

  test("counts each key separately", () => {
    const limiter = createRateLimiter({ limit: 1, windowMilliseconds: 1_000 })

    expect(limiter.allows({ key: "alice", now: 0 })).toBe(true)
    expect(limiter.allows({ key: "bob", now: 0 })).toBe(true)
    expect(limiter.allows({ key: "alice", now: 0 })).toBe(false)
  })

  test("opens a fresh window once the old one passes", () => {
    const limiter = createRateLimiter({ limit: 1, windowMilliseconds: 1_000 })

    expect(limiter.allows({ key: "alice", now: 0 })).toBe(true)
    expect(limiter.allows({ key: "alice", now: 500 })).toBe(false)
    expect(limiter.allows({ key: "alice", now: 1_500 })).toBe(true)
  })

  test("forgets the oldest keys instead of growing without bound", () => {
    const limiter = createRateLimiter({ limit: 1, windowMilliseconds: 1_000, maximumKeys: 2 })

    limiter.allows({ key: "one", now: 0 })
    limiter.allows({ key: "two", now: 0 })
    limiter.allows({ key: "three", now: 0 })

    expect(limiter.size()).toBeLessThanOrEqual(2)
  })
})
