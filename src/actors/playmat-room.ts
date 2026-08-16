import { randomUUID } from "node:crypto"

import {
  Actor,
  broadcastInvalidation,
  broadcastValue,
  type JsonObject,
  type PayloadBroadcasts,
} from "solid-objects"

import { MatchLog } from "./match-log.ts"
import { parseAction } from "../playmat/action.ts"
import { applyPlayerAction, buildPlayer } from "../playmat/player.ts"
import {
  isPlayerInRoom,
  playerForSession,
  playerSummaries,
  roomPayload,
} from "../playmat/room-snapshot.ts"
import type { Card, Player, PlayerSummary, Room, RoomPayload } from "../playmat/types.ts"

const MAXIMUM_PLAYERS = 2
const MAXIMUM_ROOM_NAME_LENGTH = 40
const MAXIMUM_PLAYER_NAME_LENGTH = 28
const DEFAULT_ROOM_NAME = "Gaming Table"
const IDLE_SWEEP_DELAY_MILLISECONDS = 5 * 60 * 1_000
const STARTING_LIFE = 20

export type PlaymatViewer = {
  sessionId: string
  roomCode: string
}

export type DeckResult = {
  deckName: string
  cards: Card[]
}

type DeckEffectArguments = {
  deckId: string
  sessionId: string
}

export class PlaymatRoom extends Actor {
  static override readonly actorType = "PlaymatRoom"
  static override readonly stateVersion = 3
  static override readonly migrations = [
    {
      from: 1,
      to: 2,
      migrate: (state: JsonObject): JsonObject => ({
        ...state,
        seatRevisions: { "1": 1, "2": 1 },
      }),
    },
    {
      from: 2,
      to: 3,
      migrate: (state: JsonObject): JsonObject =>
        Object.fromEntries(Object.entries(state).filter(([name]) => name !== "seatRevisions")),
    },
  ]

  static override readonly payloads = {
    playmat: (actor: PlaymatRoom, viewer: PlaymatViewer): RoomPayload => {
      const room = actor.room
      if (!room) return { space: null, currentPlayerId: null }
      if (!isPlayerInRoom({ room, sessionId: viewer.sessionId })) {
        return { space: null, currentPlayerId: null }
      }
      return roomPayload({ room, sessionId: viewer.sessionId })
    },
  } satisfies PayloadBroadcasts<PlaymatRoom, PlaymatViewer>

  room: Room | null = null

  get roomName(): string | null {
    return this.room?.name ?? null
  }

  get playerCount(): number {
    return this.room?.players.length ?? 0
  }

  override observables(): Record<string, unknown> {
    const summaries = this.room ? playerSummaries(this.room) : []

    return {
      version: broadcastValue(this.room?.version ?? 0),
      lifeTotals: broadcastValue(
        Object.fromEntries(summaries.map((summary) => [String(summary.seat), summary.life])),
      ),
      seatOne: broadcastInvalidation(
        summaries.find((summary) => summary.seat === 1) ?? null,
      ),
      seatTwo: broadcastInvalidation(
        summaries.find((summary) => summary.seat === 2) ?? null,
      ),
    }
  }

  createRoom(options: {
    code: string
    roomName: string
    playerName: string
    sessionId: string
  }): "created" {
    if (this.room) {
      this.reject("roomExists", { message: "This room code is already in use" })
    }

    const timestamp = new Date().toISOString()
    const creator = buildPlayer({
      name: normalizedName({
        value: options.playerName,
        fallback: "Player 1",
        maximumLength: MAXIMUM_PLAYER_NAME_LENGTH,
      }),
      sessionId: options.sessionId,
      seat: 1,
      identifier: randomUUID(),
    })

    this.room = {
      id: randomUUID(),
      code: options.code,
      name: normalizedName({
        value: options.roomName,
        fallback: DEFAULT_ROOM_NAME,
        maximumLength: MAXIMUM_ROOM_NAME_LENGTH,
      }),
      version: 1,
      players: [creator],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.#log({ event: "roomCreated", detail: creator.name })
    return "created"
  }

  join(options: { playerName: string; sessionId: string }): "joined" | "alreadyJoined" {
    const room = this.#requireRoom()
    if (playerForSession({ room, sessionId: options.sessionId })) return "alreadyJoined"

    if (room.players.length >= MAXIMUM_PLAYERS) {
      this.reject("roomFull", { message: "This space already has two players" })
    }

    const seat = room.players.length + 1
    const player = buildPlayer({
      name: normalizedName({
        value: options.playerName,
        fallback: `Player ${seat}`,
        maximumLength: MAXIMUM_PLAYER_NAME_LENGTH,
      }),
      sessionId: options.sessionId,
      seat,
      identifier: randomUUID(),
    })

    this.#commit({ room: { ...room, players: [...room.players, player] } })
    this.#log({ event: "playerJoined", detail: player.name })
    return "joined"
  }

  requestDeck(options: { deckId: string; sessionId: string }): "requested" {
    const room = this.#requireRoom()
    const player = this.#requirePlayer({ room, sessionId: options.sessionId })

    this.#replacePlayer({ room, player: { ...player, deckStatus: "loading" } })
    this.emit("fetchArchidektDeck", {
      arguments: { deckId: options.deckId, sessionId: options.sessionId },
      onSuccess: "deckLoaded",
      onFailure: "deckFailed",
    })
    this.#log({ event: "deckRequested", detail: options.deckId })
    return "requested"
  }

  deckLoaded(options: {
    effectId: string
    arguments: DeckEffectArguments
    result: DeckResult | null
  }): void {
    const room = this.room
    const result = options.result
    if (!room || !result) return

    const player = playerForSession({ room, sessionId: options.arguments.sessionId })
    if (!player) return

    this.#replacePlayer({
      room,
      player: {
        ...player,
        life: STARTING_LIFE,
        deckName: result.deckName,
        deckStatus: "loaded",
        library: result.cards,
        hand: [],
        battlefield: [],
        graveyard: [],
        exile: [],
        isSearchingDeck: false,
      },
    })
    this.#log({ event: "deckLoaded", detail: result.deckName })
  }

  deckFailed(options: {
    effectId: string
    arguments: DeckEffectArguments
    error: JsonObject
  }): void {
    const room = this.room
    if (!room) return

    const player = playerForSession({ room, sessionId: options.arguments.sessionId })
    if (!player || player.deckStatus !== "loading") return

    this.#replacePlayer({ room, player: { ...player, deckStatus: "failed" } })
    this.#log({ event: "deckFailed", detail: String(options.error.message ?? "unknown") })
  }

  applyAction(options: { action: JsonObject; sessionId: string }): "applied" {
    const room = this.#requireRoom()
    const player = this.#requirePlayer({ room, sessionId: options.sessionId })
    const action = parseAction(options.action)
    if (!action) {
      this.reject("invalidAction", {
        message: "The action payload is not a supported playmat action",
      })
    }

    const updated = applyPlayerAction({ player, action })
    this.#replacePlayer({ room, player: updated })
    this.#armIdleSweep()
    this.commitAction("recordActionMetric", {
      roomCode: room.code,
      actionType: action.type,
      seat: player.seat,
    })
    return "applied"
  }

  sweepIdleState(): "swept" | "unchanged" {
    const room = this.room
    if (!room) return "unchanged"

    if (!room.players.some((player) => player.isSearchingDeck)) return "unchanged"

    this.#commit({
      room: {
        ...room,
        players: room.players.map((player) => ({ ...player, isSearchingDeck: false })),
      },
    })
    return "swept"
  }

  reconcile(): "reconciled" {
    this.#armIdleSweep()
    return "reconciled"
  }

  #armIdleSweep(): void {
    const room = this.room
    if (!room?.players.some((player) => player.isSearchingDeck)) return

    this.schedule({ at: new Date(Date.now() + IDLE_SWEEP_DELAY_MILLISECONDS) }).sweepIdleState?.()
  }

  #requireRoom(): Room {
    if (!this.room) {
      this.reject("roomNotFound", { message: "This space does not exist" })
    }
    return this.room
  }

  #requirePlayer(options: { room: Room; sessionId: string }): Player {
    const player = playerForSession(options)
    if (!player) {
      this.reject("notAPlayer", { message: "You are not a player in this space" })
    }
    return player
  }

  #replacePlayer(options: { room: Room; player: Player }): void {
    const { room, player } = options
    this.#commit({
      room: {
        ...room,
        players: room.players.map((candidate) =>
          candidate.id === player.id ? player : candidate,
        ),
      },
    })
  }

  #commit(options: { room: Room }): void {
    this.room = {
      ...options.room,
      version: options.room.version + 1,
      updatedAt: new Date().toISOString(),
    }
  }

  #log(options: { event: string; detail: string }): void {
    this.sendTo(MatchLog.ref(this.actorId)).record(options)
  }
}

export type { PlayerSummary }

function normalizedName(options: {
  value: unknown
  fallback: string
  maximumLength: number
}): string {
  if (typeof options.value !== "string") return options.fallback

  const trimmed = options.value.trim()
  return trimmed.length === 0 ? options.fallback : trimmed.slice(0, options.maximumLength)
}
