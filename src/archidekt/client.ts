import { randomUUID } from "node:crypto"

import { NonRetryableError } from "solid-objects"

import type { Card } from "../playmat/types.ts"

const BASE_URL = "https://archidekt.com"
const TRUSTED_HOST = "archidekt.com"
const MAXIMUM_SEARCH_PAGES = 4
const MAXIMUM_SEARCH_RESULTS = 120
const MAXIMUM_CARD_QUANTITY = 20
const REQUEST_TIMEOUT_MILLISECONDS = 15_000

export class ArchidektError extends Error {
  override readonly name = "ArchidektError"
}

export class ArchidektRequestError extends NonRetryableError {
  override readonly name = "ArchidektRequestError"
}

export interface DeckColorBand {
  color: string
  weight: number
}

export interface DeckSearchResult {
  id: number
  name: string
  ownerName: string
  size: number
  updatedAt: string
  featuredUrl: string | null
  colorBands: DeckColorBand[]
}

export interface ArchidektDeck {
  name: string
  cards: Card[]
}

export interface ArchidektClient {
  search(query: string): Promise<DeckSearchResult[]>
  deck(deckId: string): Promise<ArchidektDeck>
}

export function createArchidektClient(): ArchidektClient {
  return {
    search: (query) => search(query),
    deck: (deckId) => deck(deckId),
  }
}

async function search(query: string): Promise<DeckSearchResult[]> {
  if (query.trim().length < 2) return []

  const decks = await fetchSearchPages(query)
  return decks.slice(0, MAXIMUM_SEARCH_RESULTS).map((entry) => searchResult(entry))
}

async function deck(deckId: string): Promise<ArchidektDeck> {
  if (!/^\d+$/.test(deckId)) throw new ArchidektRequestError(`invalid deck identifier ${deckId}`)

  const payload = await getJson(`${BASE_URL}/api/decks/${deckId}/`)
  return {
    name: stringValue(payload.name, "Deck"),
    cards: shuffle(deckCards(payload)),
  }
}

async function fetchSearchPages(query: string): Promise<Record<string, unknown>[]> {
  const decks: Record<string, unknown>[] = []
  let nextPageUrl: string | null = `${BASE_URL}/api/decks/v3/?name=${encodeURIComponent(query)}&page=1`

  for (let page = 0; page < MAXIMUM_SEARCH_PAGES; page += 1) {
    if (!nextPageUrl) break

    const payload: Record<string, unknown> = await getJson(nextPageUrl)
    decks.push(...recordArray(payload.results))
    if (decks.length >= MAXIMUM_SEARCH_RESULTS) break

    nextPageUrl = trustedNextPage(payload.next)
  }
  return decks
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  if (!isTrustedUrl(url)) throw new ArchidektRequestError("untrusted Archidekt URL")

  const response = await fetchWithTimeout(url)
  if (!response.ok) throw new ArchidektError(`Archidekt returned ${response.status}`)

  const payload: unknown = await response.json()
  if (!isRecord(payload)) throw new ArchidektError("Archidekt returned an unexpected payload")

  return payload
}

async function fetchWithTimeout(url: string): Promise<Response> {
  try {
    return await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
      headers: { accept: "application/json" },
    })
  } catch (error) {
    throw new ArchidektError(error instanceof Error ? error.message : String(error))
  }
}

function isTrustedUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.host === TRUSTED_HOST
  } catch {
    return false
  }
}

function trustedNextPage(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null
  return isTrustedUrl(value) ? value : null
}

function searchResult(entry: Record<string, unknown>): DeckSearchResult {
  return {
    id: numberValue(entry.id),
    name: stringValue(entry.name, "Untitled Deck"),
    ownerName: stringValue(record(entry.owner)?.username, "Unknown"),
    size: numberValue(entry.size),
    updatedAt: stringValue(entry.updatedAt, "").slice(0, 10),
    featuredUrl: stringValue(entry.featured, "") || null,
    colorBands: colorBands(entry.colors),
  }
}

function colorBands(colors: unknown): DeckColorBand[] {
  const values = record(colors)
  if (!values) return []

  return ["W", "U", "B", "R", "G"].flatMap((color) => {
    const weight = values[color]
    if (typeof weight !== "number" || weight <= 0) return []
    return [{ color, weight: Math.max(Math.round(weight), 1) }]
  })
}

function deckCards(payload: Record<string, unknown>): Card[] {
  const inclusion = categoryInclusion(payload.categories)
  return recordArray(payload.cards).flatMap((card) => {
    if (!includeCard({ card, inclusion })) return []
    return expandCard(card)
  })
}

function categoryInclusion(categories: unknown): Map<string, boolean> {
  const inclusion = new Map<string, boolean>()
  for (const category of recordArray(categories)) {
    const includedInDeck = category.includedInDeck
    inclusion.set(
      stringValue(category.name, ""),
      typeof includedInDeck === "boolean" ? includedInDeck : true,
    )
  }
  return inclusion
}

function includeCard(options: {
  card: Record<string, unknown>
  inclusion: Map<string, boolean>
}): boolean {
  const categories = Array.isArray(options.card.categories) ? options.card.categories : []
  if (categories.includes("Sideboard")) return false

  const primaryCategory = categories[0]
  if (typeof primaryCategory !== "string" || primaryCategory.length === 0) return true

  return options.inclusion.get(primaryCategory) ?? true
}

function expandCard(entry: Record<string, unknown>): Card[] {
  const card = record(entry.card)
  const scryfallId = stringValue(card?.uid, "")
  if (scryfallId.length === 0) return []

  const oracleCard = record(card?.oracleCard)
  const quantity = Math.min(Math.max(Math.trunc(numberValue(entry.quantity)), 0), MAXIMUM_CARD_QUANTITY)
  const displayName = stringValue(card?.displayName, "")
  const name = displayName || stringValue(oracleCard?.name, "Unknown Card")

  return Array.from({ length: quantity }, () => ({
    instanceId: randomUUID(),
    name,
    scryfallId,
    imageUrl: scryfallImageUrl(scryfallId),
    tapped: false,
    isManaSource: isManaSource(oracleCard),
  }))
}

function isManaSource(oracleCard: Record<string, unknown> | null): boolean {
  if (!oracleCard) return false
  if (stringValue(oracleCard.typeLine, "").toLowerCase().includes("land")) return true

  return stringValue(oracleCard.text, "").includes("Add {")
}

function scryfallImageUrl(scryfallId: string): string {
  return `https://cards.scryfall.io/normal/front/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`
}

function shuffle<Item>(items: Item[]): Item[] {
  const shuffled = [...items]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1))
    const held = shuffled[index] as Item
    shuffled[index] = shuffled[target] as Item
    shuffled[target] = held
  }
  return shuffled
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
