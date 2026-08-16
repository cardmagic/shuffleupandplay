export const ZONE_NAMES = ["library", "hand", "battlefield", "graveyard", "exile"] as const

export type ZoneName = (typeof ZONE_NAMES)[number]

export const DECK_POSITIONS = ["top", "bottom", "shuffle"] as const

export type DeckPosition = (typeof DECK_POSITIONS)[number]

export const DECK_STATUSES = ["idle", "loading", "loaded", "failed"] as const

export type DeckStatus = (typeof DECK_STATUSES)[number]

export type Card = {
  instanceId: string
  name: string
  scryfallId: string
  imageUrl: string
  tapped: boolean
  isManaSource: boolean
}

export type CardCounter = {
  id: string
  label: string
  value: number
  x: number
  y: number
}

export type BattlefieldCard = Card & {
  x: number
  y: number
  counters: CardCounter[]
}

export type Player = {
  id: string
  sessionId: string
  name: string
  seat: number
  life: number
  deckName: string | null
  deckStatus: DeckStatus
  deckRequestId: string | null
  library: Card[]
  hand: Card[]
  battlefield: BattlefieldCard[]
  graveyard: Card[]
  exile: Card[]
  isSearchingDeck: boolean
}

export type Room = {
  id: string
  code: string
  name: string
  version: number
  players: Player[]
  createdAt: string
  updatedAt: string
}

export type PublicCard = Card & {
  isHidden?: boolean
}

export type PublicBattlefieldCard = PublicCard & {
  x: number
  y: number
  counters: CardCounter[]
}

export type PublicPlayer = {
  id: string
  name: string
  seat: number
  life: number
  deckName: string | null
  deckStatus: DeckStatus
  library: PublicCard[]
  hand: PublicCard[]
  battlefield: PublicBattlefieldCard[]
  graveyard: PublicCard[]
  exile: PublicCard[]
  isSearchingDeck: boolean
}

export type PublicRoom = {
  id: string
  code: string
  name: string
  version: number
  players: PublicPlayer[]
  createdAt: string
  updatedAt: string
}

export type RoomPayload = {
  space: PublicRoom | null
  currentPlayerId: string | null
}

export type PlayerSummary = {
  seat: number
  name: string
  deckName: string | null
  deckStatus: DeckStatus
  life: number
  libraryCount: number
  handCount: number
  battlefieldCount: number
  graveyardCount: number
  exileCount: number
  isSearchingDeck: boolean
}

export type CardFingerprint = {
  instanceId: string
  tapped: boolean
  x: number
  y: number
  counters: CardCounter[]
}

export type SeatFingerprint = PlayerSummary & {
  battlefield: CardFingerprint[]
}
