/**
 * The wire contract between the server and the widget: SSE events, action
 * cards, and error bodies. Types and one shared limit, with no imports, so the
 * widget can import from here without pulling in any server code.
 *
 * Wire fields are camelCase, matching the shipped embed contract
 * (`sessionId`, `inputTokens`). New events are additive: a widget that does
 * not know an event name ignores it.
 */

/** Longest chat message (and handoff follow-up), in characters. The server
 *  enforces it; a client's maxLength is only a hint. */
export const MAX_MESSAGE_CHARS = 4000

export type ToolName = 'lookup_order' | 'create_ticket' | 'handoff_to_human'

/** Tools that only read: the chat loop may run these directly. */
export type ReadToolName = 'lookup_order'

/** Tools that change something: these only ever run from a confirm request. */
export type WriteToolName = Exclude<ToolName, ReadToolName>

export interface Source {
  source: string
  heading: string
}

/** One server-sent frame: the SSE `event:` name and its JSON `data:`. */
export type ChatEvent =
  | { event: 'sources'; data: { sources: Source[] } }
  | { event: 'token'; data: { token: string } }
  /** A read tool ran; `label` is the chip text, e.g. "Looked up order HD-1042". */
  | { event: 'tool'; data: { name: ReadToolName; label: string } }
  | { event: 'action'; data: { action: ActionView } }
  | { event: 'handoff'; data: { reference: string; status: 'waiting'; followUpRecorded: boolean } }
  | { event: 'done'; data: { model: string; inputTokens: number; outputTokens: number } }
  | { event: 'error'; data: { error: string } }

/** A write the customer is asked to confirm. Everything shown is rendered by
 *  the server from validated arguments, never from model prose. */
export interface ActionView {
  id: string
  tool: WriteToolName
  title: string
  details: { label: string; value: string }[]
  confirmLabel: string
  /** ISO 8601 time after which confirm answers `action_expired`. */
  expiresAt: string
}

export type ActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired'

export type ActionResult =
  | { tool: 'create_ticket'; ticketId: string }
  | { tool: 'handoff_to_human'; reference: string }

/** 200 body of POST /api/actions/:id/confirm. */
export interface ConfirmResponse {
  action: { id: string; tool: WriteToolName; status: 'done'; result: ActionResult }
  /** What the bot says in the chat, e.g. "Created ticket T-1001: ...". */
  message: string
}

/** 200 body of POST /api/actions/:id/cancel. */
export interface CancelResponse {
  action: { id: string; tool: WriteToolName; status: 'cancelled' }
}

export type ApiErrorCode =
  | 'invalid_session_id'
  | 'invalid_message'
  | 'action_not_found'
  | 'action_not_pending'
  | 'action_expired'
  | 'limit_reached'
  | 'action_failed'
  | 'rate_limited'
  | 'unauthorized'
  | 'handoff_not_found'
  | 'handoff_queue_full'
  | 'invalid_body'
  | 'payload_too_large'
  | 'not_found'
  | 'internal_error'

/** Body of every JSON error from the new and migrated endpoints. Clients
 *  branch on `code`; `message` is for people. */
export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string }
}

/** One handoff as the operator API shows it. It never includes the chat
 *  session id: that id authorizes actions for the customer, so it stays
 *  between the customer's browser and the server. */
export interface HandoffView {
  reference: string
  /** ISO 8601. */
  createdAt: string
  reason: string
  /** The exact summary the customer saw and approved on the card. */
  summary: string
  transcript: { role: 'user' | 'assistant'; content: string }[]
  actions: { tickets: string[]; orders: string[] }
  followUps: { at: string; text: string }[]
  /** True when later customer messages were turned away for lack of room. */
  followUpsFull: boolean
  status: 'waiting'
}

/** Body of GET /api/operator/handoffs: the newest 50, newest first. There is
 *  no paging yet, so `nextCursor` is always null. */
export interface OperatorListResponse {
  handoffs: HandoffView[]
  nextCursor: null
}
