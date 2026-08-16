const NUMERIC_IDENTIFIER = /^\d+$/
const DECK_PATH = /\/decks\/(\d+)/i

export function extractDeckId(value: unknown): string | null {
  const normalized = String(value ?? "").trim()
  if (NUMERIC_IDENTIFIER.test(normalized)) return normalized

  return DECK_PATH.exec(normalized)?.[1] ?? null
}
