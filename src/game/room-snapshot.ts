import type {
  Card,
  Player,
  PlayerSummary,
  PublicCard,
  PublicPlayer,
  Room,
  RoomPayload,
  SeatFingerprint,
} from "./types.ts"

export interface RoomPayloadOptions {
  room: Room
  sessionId: string | null
}

export function roomPayload(options: RoomPayloadOptions): RoomPayload {
  const { room, sessionId } = options
  const currentPlayer = playerForSession({ room, sessionId })

  return {
    space: {
      id: room.id,
      code: room.code,
      name: room.name,
      version: room.version,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      players: room.players.map((player) => publicPlayer({ player, sessionId })),
    },
    currentPlayerId: currentPlayer?.id ?? null,
  }
}

export type SeatedRoom<PlayerType extends { sessionId: string }> = {
  readonly players: readonly PlayerType[]
}

export function playerForSession<PlayerType extends { sessionId: string }>(options: {
  room: SeatedRoom<PlayerType>
  sessionId: string | null
}): PlayerType | undefined {
  if (!options.sessionId) return undefined
  return options.room.players.find((player) => player.sessionId === options.sessionId)
}

export function isPlayerInRoom<PlayerType extends { sessionId: string }>(options: {
  room: SeatedRoom<PlayerType>
  sessionId: string | null
}): boolean {
  return playerForSession(options) !== undefined
}

export function playerSummaries(room: Room): PlayerSummary[] {
  return room.players.map((player) => ({
    seat: player.seat,
    name: player.name,
    deckName: player.deckName,
    deckStatus: player.deckStatus,
    life: player.life,
    libraryCount: player.library.length,
    handCount: player.hand.length,
    battlefieldCount: player.battlefield.length,
    graveyardCount: player.graveyard.length,
    exileCount: player.exile.length,
    isSearchingDeck: player.isSearchingDeck,
  }))
}

export function seatFingerprints(room: Room): SeatFingerprint[] {
  return playerSummaries(room).map((summary) => {
    const player = room.players.find((candidate) => candidate.seat === summary.seat)
    return {
      ...summary,
      battlefield: (player?.battlefield ?? []).map((card) => ({
        instanceId: card.instanceId,
        tapped: card.tapped,
        x: card.x,
        y: card.y,
        counters: card.counters.map((counter) => ({
          id: counter.id,
          label: counter.label,
          value: counter.value,
          x: counter.x,
          y: counter.y,
        })),
      })),
    }
  })
}

function publicPlayer(options: { player: Player; sessionId: string | null }): PublicPlayer {
  const { player, sessionId } = options
  const visible = player.sessionId === sessionId && sessionId !== null

  return {
    id: player.id,
    name: player.name,
    seat: player.seat,
    life: player.life,
    deckName: player.deckName,
    deckStatus: player.deckStatus,
    battlefield: player.battlefield,
    graveyard: player.graveyard,
    exile: player.exile,
    isSearchingDeck: player.isSearchingDeck,
    hand: visible ? player.hand : hiddenCards({ player, zone: "hand" }),
    library: visible ? player.library : hiddenCards({ player, zone: "library" }),
  }
}

function hiddenCards(options: { player: Player; zone: "hand" | "library" }): PublicCard[] {
  const { player, zone } = options
  return player[zone].map((_card, index) => hiddenCard({ player, zone, index }))
}

function hiddenCard(options: {
  player: Player
  zone: "hand" | "library"
  index: number
}): PublicCard {
  return {
    instanceId: `hidden-${options.player.id}-${options.zone}-${options.index}`,
    name: "Hidden card",
    scryfallId: "hidden",
    imageUrl: "",
    tapped: false,
    isManaSource: false,
    isHidden: true,
  }
}

export function deckCards(cards: readonly Card[]): Card[] {
  return cards.map((card) => ({ ...card }))
}
