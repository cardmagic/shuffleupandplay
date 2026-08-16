import { randomInt } from "node:crypto"

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const LENGTH = 6

export function generateRoomCode(): string {
  let code = ""
  for (let position = 0; position < LENGTH; position += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)]
  }
  return code
}

export function normalizeRoomCode(value: unknown): string {
  return String(value ?? "")
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/g, "")
    .slice(0, LENGTH)
}
