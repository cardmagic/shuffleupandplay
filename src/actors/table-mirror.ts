import { Actor, TRANSMIT_EFFECT, type JsonObject } from "solid-objects"

import { parseAction } from "../game/action.ts"
import { applyPlayerAction } from "../game/player.ts"
import type { Player, PublicPlayer } from "../game/types.ts"

const TABLE_ACTOR_TYPE = "GameRoom"
const MAXIMUM_PENDING_MOVES = 200

export type PendingMove = {
  moveNumber: number
  action: JsonObject
}

export type MirrorSeat = {
  roomCode: string | null
  player: PublicPlayer | null
  pendingCount: number
  moveNumber: number
  appliedMove: number
}

export class TableMirror extends Actor {
  static override readonly actorType = "TableMirror"
  static override readonly stateVersion = 1

  roomCode: string | null = null
  base: PublicPlayer | null = null
  pending: PendingMove[] = []
  moveNumber = 0

  seat(): MirrorSeat {
    return {
      roomCode: this.roomCode,
      player: this.#projected(),
      pendingCount: this.pending.length,
      moveNumber: this.moveNumber,
      appliedMove: this.base?.appliedMove ?? 0,
    }
  }

  seed(options: { roomCode: string; player: PublicPlayer }): MirrorSeat {
    if (this.roomCode !== null && this.roomCode !== options.roomCode) this.#reset()
    this.roomCode = options.roomCode
    this.base = options.player
    this.moveNumber = Math.max(this.moveNumber, options.player.appliedMove)
    this.#dropApplied(options.player.appliedMove)

    return this.seat()
  }

  apply(options: { action: JsonObject }): MirrorSeat {
    const roomCode = this.roomCode
    if (!roomCode || !this.base) {
      this.reject("noSeat", { message: "This table has no seeded seat yet" })
    }
    if (!parseAction(options.action)) {
      this.reject("invalidAction", {
        message: "The action payload is not a supported game action",
      })
    }
    if (this.pending.length >= MAXIMUM_PENDING_MOVES) {
      this.reject("tooManyPendingMoves", { message: "Too many moves are waiting to reach the table" })
    }

    this.moveNumber += 1
    const moveNumber = this.moveNumber
    this.pending = [...this.pending, { moveNumber, action: options.action }]
    this.emit(TRANSMIT_EFFECT, {
      arguments: {
        actorType: TABLE_ACTOR_TYPE,
        actorId: roomCode,
        operation: "applyAction",
        arguments: { action: options.action, moveNumber },
      },
    })

    return this.seat()
  }

  reconcile(options: { player: PublicPlayer }): MirrorSeat {
    this.base = options.player
    this.#dropApplied(options.player.appliedMove)

    return this.seat()
  }

  forget(): MirrorSeat {
    this.#reset()

    return this.seat()
  }

  #dropApplied(appliedMove: number): void {
    this.pending = this.pending.filter((move) => move.moveNumber > appliedMove)
  }

  #reset(): void {
    this.roomCode = null
    this.base = null
    this.pending = []
    this.moveNumber = 0
  }

  #projected(): PublicPlayer | null {
    const base = this.base
    if (!base) return null

    let seat = seatPlayer(base)
    for (const move of this.pending) {
      const action = parseAction(move.action)
      if (!action) continue
      seat = applyPlayerAction({ player: seat, action })
    }

    return publicSeat({ seat, appliedMove: base.appliedMove })
  }
}

function seatPlayer(player: PublicPlayer): Player {
  return {
    id: player.id,
    sessionId: "",
    name: player.name,
    seat: player.seat,
    life: player.life,
    deckName: player.deckName,
    deckStatus: player.deckStatus,
    deckRequestId: null,
    library: player.library,
    hand: player.hand,
    battlefield: player.battlefield,
    graveyard: player.graveyard,
    exile: player.exile,
    isSearchingDeck: player.isSearchingDeck,
    appliedMove: player.appliedMove,
  }
}

function publicSeat(options: { seat: Player; appliedMove: number }): PublicPlayer {
  const { seat } = options

  return {
    id: seat.id,
    name: seat.name,
    seat: seat.seat,
    life: seat.life,
    deckName: seat.deckName,
    deckStatus: seat.deckStatus,
    library: seat.library,
    hand: seat.hand,
    battlefield: seat.battlefield,
    graveyard: seat.graveyard,
    exile: seat.exile,
    isSearchingDeck: seat.isSearchingDeck,
    appliedMove: options.appliedMove,
  }
}
