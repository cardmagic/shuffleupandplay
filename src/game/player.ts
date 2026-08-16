import type { GameAction } from "./action.ts"
import { defaultRandomness, type Randomness } from "./randomness.ts"
import type { BattlefieldCard, Card, CardCounter, Player, ZoneName } from "./types.ts"

const STARTING_LIFE = 20
const LIFE_RANGE = { minimum: 0, maximum: 999 }
const COUNTER_VALUE_RANGE = { minimum: -999, maximum: 999 }
const TABLE_RANGE = { x: { minimum: 0, maximum: 1200 }, y: { minimum: 0, maximum: 700 } }
const COUNTER_RANGE = { x: { minimum: 0, maximum: 96 }, y: { minimum: 0, maximum: 136 } }
const DRAW_RANGE = { minimum: 1, maximum: 12 }
const MAXIMUM_COUNTER_LABEL_LENGTH = 9
const PLAY_POSITION = { x: 240, y: 140 }
const PLAY_STAGGER = 26
const PLAY_COLUMNS = 6
const PLAY_ROWS = 4
const DROP_POSITION = { x: 40, y: 40 }

export interface BuildPlayerOptions {
  name: string
  sessionId: string
  seat: number
  identifier: string
}

export function buildPlayer(options: BuildPlayerOptions): Player {
  return {
    id: options.identifier,
    sessionId: options.sessionId,
    name: options.name,
    seat: options.seat,
    life: STARTING_LIFE,
    deckName: null,
    deckStatus: "idle",
    deckRequestId: null,
    library: [],
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    isSearchingDeck: false,
  }
}

export interface ApplyPlayerActionOptions {
  player: Player
  action: GameAction
  randomness?: Randomness
}

export function applyPlayerAction(options: ApplyPlayerActionOptions): Player {
  const { action } = options
  const player = structuredClone(options.player)
  const randomness = options.randomness ?? defaultRandomness

  switch (action.type) {
    case "drawCard":
      return drawCards({ player, count: action.count ?? 1 })
    case "shuffleLibrary":
      return { ...player, library: randomness.shuffle(player.library) }
    case "untapAll":
      return untapAll(player)
    case "openDeckSearch":
      return { ...player, isSearchingDeck: true }
    case "closeDeckSearch":
      return { ...player, isSearchingDeck: false }
    case "moveLibraryCardToHand":
      return moveLibraryCardToHand({ player, instanceId: action.instanceId })
    case "playFromHand":
      return playFromHand({ player, instanceId: action.instanceId })
    case "toggleTap":
      return toggleTap({ player, instanceId: action.instanceId })
    case "moveBattlefieldCard":
      return moveBattlefieldCard({ player, instanceId: action.instanceId, x: action.x, y: action.y })
    case "moveCardZone":
      return moveCardBetweenZones({ player, action })
    case "moveToDeck":
      return moveToDeck({ player, action, randomness })
    case "adjustLife":
      return { ...player, life: clamp(player.life + action.delta, LIFE_RANGE) }
    case "resetLife":
      return { ...player, life: STARTING_LIFE }
    case "setLife":
      return { ...player, life: clamp(action.value, LIFE_RANGE) }
    case "addCounter":
      return addCounter({ player, action, randomness })
    case "moveCounter":
      return moveCounter({ player, action })
    case "updateCounterValue":
      return updateCounterValue({ player, action })
  }
}

function drawCards(options: { player: Player; count: number }): Player {
  const { player } = options
  if (player.library.length === 0) return player

  const count = clamp(Math.trunc(options.count), DRAW_RANGE)
  return {
    ...player,
    library: player.library.slice(count),
    hand: [...player.hand, ...player.library.slice(0, count)],
  }
}

function moveLibraryCardToHand(options: { player: Player; instanceId: string }): Player {
  const { player, instanceId } = options
  const card = player.library.find((candidate) => candidate.instanceId === instanceId)
  if (!card) return player

  return {
    ...player,
    library: withoutCard({ cards: player.library, instanceId }),
    hand: [...player.hand, card],
  }
}

function playFromHand(options: { player: Player; instanceId: string }): Player {
  const { player, instanceId } = options
  const card = player.hand.find((candidate) => candidate.instanceId === instanceId)
  if (!card) return player

  return {
    ...player,
    hand: withoutCard({ cards: player.hand, instanceId }),
    battlefield: [
      ...player.battlefield,
      battlefieldCard({ card, ...freePlayPosition(player.battlefield) }),
    ],
  }
}

function freePlayPosition(battlefield: BattlefieldCard[]): { x: number; y: number } {
  for (let slot = 0; slot < PLAY_COLUMNS * PLAY_ROWS; slot += 1) {
    const x = PLAY_POSITION.x + (slot % PLAY_COLUMNS) * PLAY_STAGGER
    const y = PLAY_POSITION.y + Math.floor(slot / PLAY_COLUMNS) * PLAY_STAGGER
    if (!battlefield.some((card) => card.x === x && card.y === y)) return { x, y }
  }
  return PLAY_POSITION
}

function toggleTap(options: { player: Player; instanceId: string }): Player {
  const { player, instanceId } = options
  return {
    ...player,
    battlefield: player.battlefield.map((card) =>
      card.instanceId === instanceId ? { ...card, tapped: !card.tapped } : card,
    ),
  }
}

function untapAll(player: Player): Player {
  return {
    ...player,
    battlefield: player.battlefield.map((card) => ({ ...card, tapped: false })),
  }
}

function moveBattlefieldCard(options: {
  player: Player
  instanceId: string
  x: number
  y: number
}): Player {
  const { player, instanceId } = options
  return {
    ...player,
    battlefield: player.battlefield.map((card) =>
      card.instanceId === instanceId
        ? { ...card, x: clamp(options.x, TABLE_RANGE.x), y: clamp(options.y, TABLE_RANGE.y) }
        : card,
    ),
  }
}

function moveCardBetweenZones(options: {
  player: Player
  action: Extract<GameAction, { type: "moveCardZone" }>
}): Player {
  const { player, action } = options
  if (action.from === action.to) return player

  const removal = removeCard({ player, zone: action.from, instanceId: action.instanceId })
  if (!removal) return player

  const { card, remainder } = removal
  if (action.to !== "battlefield") {
    return { ...remainder, [action.to]: [...remainder[action.to], deckCard(card)] }
  }

  return {
    ...remainder,
    battlefield: [
      ...remainder.battlefield,
      battlefieldCard({
        card: deckCard(card),
        x: clamp(action.x ?? DROP_POSITION.x, TABLE_RANGE.x),
        y: clamp(action.y ?? DROP_POSITION.y, TABLE_RANGE.y),
      }),
    ],
  }
}

function moveToDeck(options: {
  player: Player
  action: Extract<GameAction, { type: "moveToDeck" }>
  randomness: Randomness
}): Player {
  const { player, action, randomness } = options
  const removal = removeCard({ player, zone: action.from, instanceId: action.instanceId })
  if (!removal) return player

  const { remainder } = removal
  const card = deckCard(removal.card)
  if (action.position === "top") return { ...remainder, library: [card, ...remainder.library] }
  if (action.position === "bottom") return { ...remainder, library: [...remainder.library, card] }

  return { ...remainder, library: randomness.shuffle([...remainder.library, card]) }
}

function addCounter(options: {
  player: Player
  action: Extract<GameAction, { type: "addCounter" }>
  randomness: Randomness
}): Player {
  const { player, action, randomness } = options
  const counter: CardCounter = {
    id: randomness.identifier(),
    label: (action.label ?? "+1/+1").slice(0, MAXIMUM_COUNTER_LABEL_LENGTH),
    value: 0,
    x: clamp(action.x, COUNTER_RANGE.x),
    y: clamp(action.y, COUNTER_RANGE.y),
  }

  return {
    ...player,
    battlefield: player.battlefield.map((card) =>
      card.instanceId === action.instanceId
        ? { ...card, counters: [...card.counters, counter] }
        : card,
    ),
  }
}

function moveCounter(options: {
  player: Player
  action: Extract<GameAction, { type: "moveCounter" }>
}): Player {
  const { player, action } = options
  return mapCounters({
    player,
    instanceId: action.instanceId,
    map: (counter) =>
      counter.id === action.counterId
        ? { ...counter, x: clamp(action.x, COUNTER_RANGE.x), y: clamp(action.y, COUNTER_RANGE.y) }
        : counter,
  })
}

function updateCounterValue(options: {
  player: Player
  action: Extract<GameAction, { type: "updateCounterValue" }>
}): Player {
  const { player, action } = options
  return mapCounters({
    player,
    instanceId: action.instanceId,
    map: (counter) => {
      if (counter.id !== action.counterId) return counter

      const value = clamp(counter.value + action.delta, COUNTER_VALUE_RANGE)
      return value === 0 ? null : { ...counter, value }
    },
  })
}

function mapCounters(options: {
  player: Player
  instanceId: string
  map: (counter: CardCounter) => CardCounter | null
}): Player {
  const { player, instanceId, map } = options
  return {
    ...player,
    battlefield: player.battlefield.map((card) => {
      if (card.instanceId !== instanceId) return card

      const counters = card.counters
        .map(map)
        .filter((counter): counter is CardCounter => counter !== null)
      return { ...card, counters }
    }),
  }
}

function removeCard(options: {
  player: Player
  zone: ZoneName
  instanceId: string
}): { card: Card; remainder: Player } | null {
  const { player, zone, instanceId } = options
  const card = player[zone].find((candidate) => candidate.instanceId === instanceId)
  if (!card) return null

  return {
    card,
    remainder: { ...player, [zone]: withoutCard({ cards: player[zone], instanceId }) },
  }
}

function withoutCard(options: { cards: readonly Card[]; instanceId: string }): Card[] {
  return options.cards.filter((card) => card.instanceId !== options.instanceId)
}

function battlefieldCard(options: { card: Card; x: number; y: number }): BattlefieldCard {
  return { ...deckCard(options.card), x: options.x, y: options.y, counters: [] }
}

function deckCard(card: Card): Card {
  return {
    instanceId: card.instanceId,
    name: card.name,
    scryfallId: card.scryfallId,
    imageUrl: card.imageUrl,
    tapped: card.tapped,
    isManaSource: card.isManaSource,
  }
}

function clamp(value: number, range: { minimum: number; maximum: number }): number {
  return Math.min(Math.max(value, range.minimum), range.maximum)
}
