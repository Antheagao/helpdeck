/**
 * The widget's chat state as a pure reducer, so every transition (each stream
 * event, each confirm outcome) is tested without a browser. useChat wires it
 * to fetch; Widget and ActionCard only render it.
 */

import type {
  ActionView,
  ApiErrorBody,
  ApiErrorCode,
  ChatEvent,
  ConfirmResponse,
  Source,
} from '../../server/protocol.js'

/** Where a proposed action stands on the customer's side. */
export type ActionState =
  | { status: 'pending' }
  | { status: 'confirming' }
  | { status: 'done'; message: string }
  | { status: 'cancelled' }
  /** `retryable` is only true where asking again can work; confirm is
   *  idempotent on the server, so a retry cannot do the thing twice. */
  | { status: 'failed'; message: string; retryable: boolean }

export interface ActionItem {
  view: ActionView
  state: ActionState
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
  sources?: Source[]
  /** Chip labels for read tools the bot ran, e.g. "Looked up order HD-1042". */
  tools?: string[]
  action?: ActionItem
  /** On a reply: it did not arrive. On a customer message: it was not sent. */
  failed?: boolean
  /** On a customer message sent after handoff: whether the team got it. */
  followUp?: { recorded: boolean; reference: string }
}

export interface ChatState {
  messages: Message[]
  /** Set once the conversation is with a person. */
  handoff: { reference: string } | null
  /** The latest outcome, for the screen-reader live region. */
  announcement: string
}

export const initialState: ChatState = { messages: [], handoff: null, announcement: '' }

/** Why a request failed, in terms the customer can act on. */
export interface Failure {
  code: ApiErrorCode | 'network'
  message: string
  retryable: boolean
}

/**
 * Whether asking again can succeed, per error code. A Record over the whole
 * union: a code added to the protocol fails tsc here until it is decided.
 */
const RETRYABLE: Record<ApiErrorCode, boolean> = {
  invalid_session_id: false,
  invalid_message: false,
  action_not_found: false,
  action_not_pending: false,
  action_expired: false,
  limit_reached: false,
  action_failed: true,
  rate_limited: true,
  unauthorized: false,
  invalid_body: false,
  payload_too_large: false,
  handoff_not_found: false,
  handoff_queue_full: true,
  not_found: false,
  internal_error: true,
}

const isErrorBody = (body: unknown): body is ApiErrorBody => {
  const error = (body as { error?: unknown } | null)?.error as { code?: unknown; message?: unknown } | undefined
  return typeof error?.code === 'string' && typeof error.message === 'string'
}

export const networkFailure = (): Failure => ({
  code: 'network',
  message: 'I could not reach the server. Check your connection and try again.',
  retryable: true,
})

/**
 * Turn a failed HTTP response into a Failure. Behavior follows the stable
 * `error.code`; the server's `message` is only what gets shown. A 429 adds how
 * long to wait, from Retry-After.
 */
export function failureFrom(status: number, body: unknown, retryAfter: string | null): Failure {
  if (!isErrorBody(body)) {
    return { code: 'internal_error', message: 'Something went wrong. Please try again.', retryable: status >= 500 }
  }
  const { code, message } = body.error
  const known = Object.hasOwn(RETRYABLE, code)
  const seconds = Number(retryAfter)
  const wait = code === 'rate_limited' && Number.isFinite(seconds) && seconds >= 1
  return {
    code: known ? (code as ApiErrorCode) : 'internal_error',
    message: wait ? `${message} Try again in ${Math.ceil(seconds)} second${Math.ceil(seconds) === 1 ? '' : 's'}.` : message,
    retryable: known ? RETRYABLE[code as ApiErrorCode] : status >= 500,
  }
}

/**
 * Where confirm and cancel are posted. `data-actions-endpoint` wins; otherwise
 * it is derived from the chat endpoint by swapping a trailing `/chat` for
 * `/actions`, which is how the shipped server lays its routes out.
 */
export function actionsBase(chatEndpoint: string, override?: string): string {
  if (override) return override.replace(/\/+$/, '')
  return chatEndpoint.replace(/\/chat\/?$/, '/actions')
}

/** 16 random bytes in hex. getRandomValues rather than randomUUID, which
 *  needs a secure context, and a site may embed the widget over plain http.
 *  This id authorizes confirm for the customer, so it is not guessable. */
export function newSessionId(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return Array.from(random(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export type ChatAction =
  | { type: 'send'; text: string }
  | { type: 'event'; event: ChatEvent }
  | { type: 'transport-failed'; message: string }
  | { type: 'confirming'; id: string }
  | { type: 'confirmed'; id: string; response: ConfirmResponse }
  | { type: 'confirm-failed'; id: string; failure: Failure }
  | { type: 'cancelled'; id: string }
  | { type: 'cancel-failed'; id: string; failure: Failure }
  | { type: 'reset' }

function lastIndex(messages: Message[], role: Message['role']): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === role) return i
  return -1
}

function patchAt(messages: Message[], index: number, patch: (m: Message) => Message): Message[] {
  return messages.map((m, i) => (i === index ? patch(m) : m))
}

function patchAction(state: ChatState, id: string, next: ActionState): ChatState {
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.action?.view.id === id ? { ...m, action: { ...m.action, state: next } } : m,
    ),
  }
}

function onEvent(state: ChatState, event: ChatEvent): ChatState {
  const { messages } = state
  const assistant = messages.length - 1
  const onLastAssistant = (patch: (m: Message) => Message): ChatState =>
    messages[assistant]?.role === 'assistant' ? { ...state, messages: patchAt(messages, assistant, patch) } : state

  switch (event.event) {
    case 'sources':
      return onLastAssistant((m) => ({ ...m, sources: event.data.sources }))
    case 'token':
      return onLastAssistant((m) => ({ ...m, content: m.content + event.data.token }))
    case 'tool':
      return onLastAssistant((m) => ({ ...m, tools: [...(m.tools ?? []), event.data.label] }))
    case 'action':
      return onLastAssistant((m) => ({ ...m, action: { view: event.data.action, state: { status: 'pending' } } }))
    case 'handoff': {
      // The server answered with a handoff instead of a reply: drop the empty
      // reply placeholder and mark the customer's message.
      const { reference, followUpRecorded } = event.data
      const trimmed =
        messages.at(-1)?.role === 'assistant' && !messages.at(-1)?.content && !messages.at(-1)?.action
          ? messages.slice(0, -1)
          : messages
      const user = lastIndex(trimmed, 'user')
      return {
        ...state,
        handoff: { reference },
        messages: user === -1 ? trimmed : patchAt(trimmed, user, (m) => ({ ...m, followUp: { recorded: followUpRecorded, reference } })),
        announcement: followUpRecorded
          ? `Added to ${reference}.`
          : `Your message could not be added to ${reference}.`,
      }
    }
    case 'error':
      return onLastAssistant((m) => ({ ...m, content: event.data.error || 'Something went wrong.', failed: true }))
    case 'done':
      return state
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'send': {
      const user: Message = { role: 'user', content: action.text }
      // With a person on the other end there is no bot reply to wait for.
      const reply: Message[] = state.handoff ? [] : [{ role: 'assistant', content: '' }]
      return { ...state, messages: [...state.messages, user, ...reply] }
    }
    case 'event':
      return onEvent(state, action.event)
    case 'transport-failed': {
      const last = state.messages.length - 1
      const message = state.messages[last]
      if (!message) return state
      // A reply shows the reason in place of its text; a follow-up to a person
      // keeps what the customer wrote and is flagged as not sent.
      return {
        ...state,
        messages: patchAt(state.messages, last, (m) =>
          m.role === 'assistant' ? { ...m, content: action.message, failed: true } : { ...m, failed: true },
        ),
        announcement: action.message,
      }
    }
    case 'confirming':
      return patchAction(state, action.id, { status: 'confirming' })
    case 'confirmed': {
      const { result } = action.response.action
      const next = patchAction(state, action.id, { status: 'done', message: action.response.message })
      return {
        ...next,
        handoff: result.tool === 'handoff_to_human' ? { reference: result.reference } : next.handoff,
        announcement: action.response.message,
      }
    }
    case 'confirm-failed':
      return {
        ...patchAction(state, action.id, {
          status: 'failed',
          message: action.failure.message,
          retryable: action.failure.retryable,
        }),
        announcement: action.failure.message,
      }
    case 'cancelled':
      return { ...patchAction(state, action.id, { status: 'cancelled' }), announcement: 'Request cancelled.' }
    case 'cancel-failed':
      // The action may still be live on the server, but the customer asked to
      // drop it: stop offering the buttons and say what happened.
      return {
        ...patchAction(state, action.id, { status: 'failed', message: action.failure.message, retryable: false }),
        announcement: action.failure.message,
      }
    case 'reset':
      return initialState
  }
}
