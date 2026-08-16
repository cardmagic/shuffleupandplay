import { randomUUID } from "node:crypto"

export interface Randomness {
  identifier(): string
  shuffle<Item>(items: readonly Item[]): Item[]
}

export const defaultRandomness: Randomness = {
  identifier: () => randomUUID(),
  shuffle: (items) => {
    const shuffled = [...items]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const target = Math.floor(Math.random() * (index + 1))
      const held = shuffled[index] as (typeof shuffled)[number]
      shuffled[index] = shuffled[target] as (typeof shuffled)[number]
      shuffled[target] = held
    }
    return shuffled
  },
}
