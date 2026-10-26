/**
 * The fake business behind the tools: a seeded order book and an in-process
 * ticket store. Both are deliberately small and in memory, like SessionStore;
 * the interfaces are what a real order system or ticket desk would implement.
 */

import fs from 'node:fs'

export type OrderStatus = 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'returned'

/** What the bot may know about an order. The shipping address is not here.
 *  A type alias, not an interface, so it counts as JSON for tool results. */
export type OrderView = {
  orderId: string
  status: OrderStatus
  placedOn: string
  items: { name: string; quantity: number }[]
  totalCents: number
  currency: string
  carrier: string | null
  trackingNumber: string | null
  /** Written by the customer when ordering: untrusted text, not instructions. */
  customerNote: { writtenBy: 'customer'; text: string } | null
}

export interface OrderBackend {
  /** The order only when the id exists and the email is the one on it. An
   *  unknown id and a wrong email are the same answer, so a caller cannot
   *  probe which order ids exist. */
  lookup(orderId: string, email: string): OrderView | null
}

interface SeedOrder {
  orderId: string
  email: string
  status: OrderStatus
  items: { name: string; quantity: number }[]
  totalCents: number
  currency: string
  carrier: string | null
  trackingNumber: string | null
  placedOn: string
  customerNote: string | null
  shipTo: { name: string; line1: string; city: string; region: string; postalCode: string }
}

export function loadSeedOrders(): SeedOrder[] {
  const file = new URL('./data/orders.json', import.meta.url)
  // The one place the committed seed file is trusted; tests pin its invariants.
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SeedOrder[]
}

const normalizeEmail = (email: string) => email.trim().toLowerCase()

export class SeededOrderBackend implements OrderBackend {
  private readonly byId = new Map<string, SeedOrder>()

  constructor(orders: SeedOrder[] = loadSeedOrders()) {
    for (const order of orders) this.byId.set(order.orderId.toUpperCase(), order)
  }

  lookup(orderId: string, email: string): OrderView | null {
    const order = this.byId.get(orderId.trim().toUpperCase())
    if (!order || normalizeEmail(order.email) !== normalizeEmail(email)) return null
    // Built field by field, in a fixed order, so serialized output is stable
    // and nothing new in the seed (the address) can leak by accident.
    return {
      orderId: order.orderId,
      status: order.status,
      placedOn: order.placedOn,
      items: order.items.map((item) => ({ name: item.name, quantity: item.quantity })),
      totalCents: order.totalCents,
      currency: order.currency,
      carrier: order.carrier,
      trackingNumber: order.trackingNumber,
      customerNote: order.customerNote ? { writtenBy: 'customer', text: order.customerNote } : null,
    }
  }
}

export const MAX_TICKETS_PER_SESSION = 3

export interface Ticket {
  readonly id: string
  readonly sessionId: string
  readonly subject: string
  readonly description: string
  /** ISO 8601. */
  readonly createdAt: string
}

/** Thrown by TicketStore.create when a session already has the maximum. */
export class TicketLimitError extends Error {
  constructor() {
    super(`a session may open at most ${MAX_TICKETS_PER_SESSION} tickets`)
  }
}

export class TicketStore {
  private readonly bySession = new Map<string, Ticket[]>()
  private nextNumber = 1001
  private total = 0

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Ids run T-1001, T-1002, ... in creation order, so evals are deterministic.
   *  @throws TicketLimitError at the per-session cap. */
  create(sessionId: string, subject: string, description: string): Ticket {
    const mine = this.bySession.get(sessionId) ?? []
    if (mine.length >= MAX_TICKETS_PER_SESSION) throw new TicketLimitError()
    const ticket: Ticket = {
      id: `T-${this.nextNumber++}`,
      sessionId,
      subject,
      description,
      createdAt: this.now().toISOString(),
    }
    this.bySession.set(sessionId, [...mine, ticket])
    this.total++
    return ticket
  }

  listForSession(sessionId: string): Ticket[] {
    return [...(this.bySession.get(sessionId) ?? [])]
  }

  /** Tickets across all sessions. */
  count(): number {
    return this.total
  }
}
