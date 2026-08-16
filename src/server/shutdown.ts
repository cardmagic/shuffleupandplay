export function createShutdown(close: () => Promise<void>): () => Promise<void> {
  let stopping: Promise<void> | undefined

  return () => {
    stopping ??= close()
    return stopping
  }
}
