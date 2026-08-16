export type RateLimiter = {
  allows(options: { key: string; now?: number }): boolean
  size(): number
}

export function createRateLimiter(options: {
  limit: number
  windowMilliseconds: number
  maximumKeys?: number
}): RateLimiter {
  const maximumKeys = options.maximumKeys ?? 10_000
  const windows = new Map<string, { windowStart: number; count: number }>()

  return {
    allows: ({ key, now = Date.now() }) => {
      const window = windows.get(key)
      if (!window || now - window.windowStart >= options.windowMilliseconds) {
        if (windows.size >= maximumKeys) {
          const oldest = windows.keys().next().value
          if (oldest !== undefined) windows.delete(oldest)
        }
        windows.set(key, { windowStart: now, count: 1 })
        return true
      }

      if (window.count >= options.limit) return false

      window.count += 1
      return true
    },
    size: () => windows.size,
  }
}
