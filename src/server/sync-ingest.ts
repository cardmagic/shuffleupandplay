import {
  receiveTransmitEnvelope,
  type JsonObject,
  type SolidObjectsRuntime,
  type TransmitEnvelope,
} from "solid-objects"

import { GameRoom } from "../actors/game-room.ts"

const SYNC_OPERATION = "applyAction"
const EFFECT_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/

export type SyncRejection = { reason: string }

export type SyncEnvelopeInput = {
  body: Record<string, unknown>
  roomCode: string
  sessionId: string
}

export function readSyncEnvelope(input: SyncEnvelopeInput): TransmitEnvelope | SyncRejection {
  const { body, roomCode, sessionId } = input

  const effectId = body.effectId
  if (typeof effectId !== "string" || !EFFECT_ID_PATTERN.test(effectId)) {
    return { reason: "The envelope needs a usable effect id" }
  }
  if (body.actorType !== undefined && body.actorType !== GameRoom.actorType) {
    return { reason: "This table accepts no other actor type" }
  }
  if (body.actorId !== undefined && body.actorId !== roomCode) {
    return { reason: "This table accepts no other table code" }
  }
  if (body.operation !== SYNC_OPERATION) {
    return { reason: "This table accepts no other operation" }
  }

  const suppliedArguments = body.arguments
  if (!isRecord(suppliedArguments)) {
    return { reason: "The envelope needs an arguments object" }
  }
  const action = suppliedArguments.action
  if (!isRecord(action)) {
    return { reason: "The envelope needs an action object" }
  }

  return {
    effectId: `${sessionId}:${effectId}`,
    actorType: GameRoom.actorType,
    actorId: roomCode,
    operation: SYNC_OPERATION,
    arguments: {
      action: asJsonObject(action),
      sessionId,
      ...moveNumber(suppliedArguments.moveNumber),
    },
  }
}

export async function ingestSyncEnvelope(options: {
  runtime: SolidObjectsRuntime
  envelope: TransmitEnvelope
}): Promise<void> {
  await receiveTransmitEnvelope({ runtime: options.runtime, envelope: options.envelope })
}

export function isSyncRejection(value: TransmitEnvelope | SyncRejection): value is SyncRejection {
  return typeof (value as SyncRejection).reason === "string"
}

function moveNumber(value: unknown): { moveNumber?: number } {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return {}

  return { moveNumber: value }
}

function asJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
