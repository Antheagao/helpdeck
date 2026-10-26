import { describe, expect, it } from 'vitest'

import type { ActionView, ApiErrorCode, ChatEvent, ConfirmResponse } from '../server/protocol.js'
import {
  actionsBase,
  chatReducer,
  failureFrom,
  initialState,
  networkFailure,
  newSessionId,
  type ChatAction,
  type ChatState,
} from '../widget/src/chatState.js'

const run = (actions: ChatAction[], from: ChatState = initialState) => actions.reduce(chatReducer, from)
const event = (e: ChatEvent): ChatAction => ({ type: 'event', event: e })

const view: ActionView = {
  id: 'a'.repeat(32),
  tool: 'create_ticket',
  title: 'Open a support ticket',
  details: [{ label: 'Subject', value: 'Lamp' }],
  confirmLabel: 'Open ticket',
  expiresAt: '2026-10-26T12:10:00.000Z',
}
const proposed = run([
  { type: 'send', text: 'Open a ticket: lamp' },
  event({ event: 'sources', data: { sources: [] } }),
  event({ event: 'action', data: { action: view } }),
])
const actionState = (s: ChatState) => s.messages.at(-1)?.action?.state

const confirmedResponse: ConfirmResponse = {
  action: { id: view.id, tool: 'create_ticket', status: 'done', result: { tool: 'create_ticket', ticketId: 'T-1001' } },
  message: 'Created ticket T-1001: Lamp',
}

describe('sending and streaming', () => {
  it('adds the customer message and an empty reply to fill', () => {
    const state = run([{ type: 'send', text: 'hello' }])
    expect(state.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '' },
    ])
  })

  it('appends tokens, then sets sources and tool chips on the reply', () => {
    const state = run([
      { type: 'send', text: 'where is HD-1042' },
      event({ event: 'sources', data: { sources: [{ source: 'a.md', heading: 'A' }] } }),
      event({ event: 'tool', data: { name: 'lookup_order', label: 'Looked up order HD-1042' } }),
      event({ event: 'token', data: { token: 'Let me ' } }),
      event({ event: 'token', data: { token: 'look.' } }),
      event({ event: 'done', data: { model: 'm', inputTokens: 1, outputTokens: 1 } }),
    ])
    expect(state.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'Let me look.',
      sources: [{ source: 'a.md', heading: 'A' }],
      tools: ['Looked up order HD-1042'],
    })
  })

  it('turns an action event into a pending card on the reply', () => {
    expect(proposed.messages.at(-1)?.action).toEqual({ view, state: { status: 'pending' } })
  })

  it('marks the reply failed on an error event or a transport failure', () => {
    const errored = run([{ type: 'send', text: 'x' }, event({ event: 'error', data: { error: 'The assistant hit an error.' } })])
    expect(errored.messages.at(-1)).toMatchObject({ content: 'The assistant hit an error.', failed: true })
    const dropped = run([{ type: 'send', text: 'x' }, { type: 'transport-failed', message: 'offline' }])
    expect(dropped.messages.at(-1)).toMatchObject({ content: 'offline', failed: true })
  })

  it('flags a follow-up to a person as not sent, keeping what the customer wrote', () => {
    const state = run([{ type: 'send', text: 'photos attached' }, { type: 'transport-failed', message: 'offline' }], {
      ...initialState,
      handoff: { reference: 'H-1001' },
    })
    expect(state.messages).toEqual([{ role: 'user', content: 'photos attached', failed: true }])
    expect(state.announcement).toBe('offline')
  })

  it('leaves state alone for an event with nothing to attach to', () => {
    expect(run([event({ event: 'token', data: { token: 'orphan' } })])).toEqual(initialState)
  })

  it('resets to the empty state', () => {
    expect(run([{ type: 'reset' }], proposed)).toEqual(initialState)
  })
})

describe('an action card', () => {
  it('goes pending, confirming, done with the server message', () => {
    const confirming = run([{ type: 'confirming', id: view.id }], proposed)
    expect(actionState(confirming)).toEqual({ status: 'confirming' })
    const done = run([{ type: 'confirmed', id: view.id, response: confirmedResponse }], confirming)
    expect(actionState(done)).toEqual({ status: 'done', message: 'Created ticket T-1001: Lamp' })
    expect(done.announcement).toBe('Created ticket T-1001: Lamp')
    expect(done.handoff).toBeNull()
  })

  it('can fail and be retried to done', () => {
    const failed = run(
      [
        { type: 'confirming', id: view.id },
        { type: 'confirm-failed', id: view.id, failure: { code: 'action_failed', message: 'Try again.', retryable: true } },
      ],
      proposed,
    )
    expect(actionState(failed)).toEqual({ status: 'failed', message: 'Try again.', retryable: true })
    expect(failed.announcement).toBe('Try again.')
    const retried = run(
      [{ type: 'confirming', id: view.id }, { type: 'confirmed', id: view.id, response: confirmedResponse }],
      failed,
    )
    expect(actionState(retried)).toEqual({ status: 'done', message: 'Created ticket T-1001: Lamp' })
  })

  it('records a non-retryable failure without buttons to retry', () => {
    const state = run(
      [{ type: 'confirm-failed', id: view.id, failure: { code: 'action_expired', message: 'Expired.', retryable: false } }],
      proposed,
    )
    expect(actionState(state)).toMatchObject({ status: 'failed', retryable: false })
  })

  it('cancels, and a failed cancel closes the card instead of offering a retry that would confirm', () => {
    expect(actionState(run([{ type: 'cancelled', id: view.id }], proposed))).toEqual({ status: 'cancelled' })
    const failed = run(
      [{ type: 'cancel-failed', id: view.id, failure: { code: 'network', message: 'Offline.', retryable: true } }],
      proposed,
    )
    expect(actionState(failed)).toEqual({ status: 'failed', message: 'Offline.', retryable: false })
  })

  it('touches only the card it names', () => {
    const second: ActionView = { ...view, id: 'b'.repeat(32) }
    const both = run([
      { type: 'send', text: 'again' },
      event({ event: 'action', data: { action: second } }),
    ], proposed)
    const state = run([{ type: 'cancelled', id: second.id }], both)
    expect(state.messages.map((m) => m.action?.state.status)).toEqual([undefined, 'pending', undefined, 'cancelled'])
  })

  it('ignores an outcome for a card it does not have', () => {
    expect(run([{ type: 'cancelled', id: 'missing' }], proposed)).toEqual({ ...proposed, announcement: 'Request cancelled.' })
  })
})

describe('handoff', () => {
  const handoffResponse: ConfirmResponse = {
    action: { id: view.id, tool: 'handoff_to_human', status: 'done', result: { tool: 'handoff_to_human', reference: 'H-1001' } },
    message: 'I have passed this conversation to the support team (reference H-1001).',
  }

  it('moves the chat into the handed-off state when the handoff is confirmed', () => {
    const state = run([{ type: 'confirmed', id: view.id, response: handoffResponse }], proposed)
    expect(state.handoff).toEqual({ reference: 'H-1001' })
    expect(actionState(state)).toMatchObject({ status: 'done' })
  })

  it('adds a follow-up with no reply placeholder, and marks it when the server files it', () => {
    const handed = run([{ type: 'confirmed', id: view.id, response: handoffResponse }], proposed)
    const sent = run([{ type: 'send', text: 'I have photos' }], handed)
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'I have photos' })
    const filed = run(
      [event({ event: 'handoff', data: { reference: 'H-1001', status: 'waiting', followUpRecorded: true } })],
      sent,
    )
    expect(filed.messages.at(-1)).toEqual({
      role: 'user',
      content: 'I have photos',
      followUp: { recorded: true, reference: 'H-1001' },
    })
    expect(filed.announcement).toBe('Added to H-1001.')
  })

  it('says when a follow-up was not recorded', () => {
    const state = run(
      [
        { type: 'send', text: 'more' },
        event({ event: 'handoff', data: { reference: 'H-1001', status: 'waiting', followUpRecorded: false } }),
      ],
      { ...initialState, handoff: { reference: 'H-1001' } },
    )
    expect(state.messages.at(-1)?.followUp).toEqual({ recorded: false, reference: 'H-1001' })
    expect(state.announcement).toBe('Your message could not be added to H-1001.')
  })

  it('catches up when the server reports a handoff the widget did not know about', () => {
    const state = run([
      { type: 'send', text: 'hello?' },
      event({ event: 'handoff', data: { reference: 'H-1002', status: 'waiting', followUpRecorded: true } }),
    ])
    expect(state.handoff).toEqual({ reference: 'H-1002' })
    // The empty reply placeholder is dropped.
    expect(state.messages).toEqual([{ role: 'user', content: 'hello?', followUp: { recorded: true, reference: 'H-1002' } }])
  })

  it('starts a fresh bot conversation on reset', () => {
    const handed = run([{ type: 'confirmed', id: view.id, response: handoffResponse }], proposed)
    expect(run([{ type: 'reset' }], handed).handoff).toBeNull()
  })
})

describe('failureFrom', () => {
  const body = (code: string, message = 'Server words.') => ({ error: { code, message } })

  it('decides on the code, and shows the server message', () => {
    expect(failureFrom(500, body('action_failed'), null)).toEqual({
      code: 'action_failed',
      message: 'Server words.',
      retryable: true,
    })
    expect(failureFrom(409, body('action_expired', 'Expired, ask again.'), null)).toEqual({
      code: 'action_expired',
      message: 'Expired, ask again.',
      retryable: false,
    })
  })

  it('does not look at the message text to decide', () => {
    expect(failureFrom(409, body('action_expired', 'Try again later, this is temporary'), null).retryable).toBe(false)
    expect(failureFrom(500, body('action_failed', 'This request expired.'), null).retryable).toBe(true)
  })

  it('covers every code the server can send', () => {
    const retryable: ApiErrorCode[] = ['action_failed', 'rate_limited', 'handoff_queue_full', 'internal_error']
    const all: ApiErrorCode[] = [
      'invalid_session_id', 'invalid_message', 'action_not_found', 'action_not_pending', 'action_expired',
      'limit_reached', 'action_failed', 'rate_limited', 'unauthorized', 'invalid_body', 'payload_too_large',
      'handoff_not_found', 'handoff_queue_full', 'not_found', 'internal_error',
    ]
    for (const code of all) {
      const failure = failureFrom(409, body(code), null)
      expect(failure.code).toBe(code)
      expect(failure.retryable, code).toBe(retryable.includes(code))
    }
  })

  it('adds the wait to a 429 from Retry-After', () => {
    expect(failureFrom(429, body('rate_limited', 'Too many requests.'), '30').message).toBe(
      'Too many requests. Try again in 30 seconds.',
    )
    expect(failureFrom(429, body('rate_limited', 'Too many requests.'), '1').message).toBe(
      'Too many requests. Try again in 1 second.',
    )
    expect(failureFrom(429, body('rate_limited', 'Too many requests.'), null).message).toBe('Too many requests.')
    expect(failureFrom(429, body('rate_limited', 'Too many requests.'), 'soon').message).toBe('Too many requests.')
  })

  it('handles an unknown code and a body that is not the envelope', () => {
    expect(failureFrom(409, body('brand_new_code'), null)).toMatchObject({ code: 'internal_error', retryable: false })
    expect(failureFrom(503, body('brand_new_code'), null).retryable).toBe(true)
    expect(failureFrom(502, '<html>Bad gateway</html>', null)).toEqual({
      code: 'internal_error',
      message: 'Something went wrong. Please try again.',
      retryable: true,
    })
    expect(failureFrom(404, null, null).retryable).toBe(false)
  })

  it('treats a network error as retryable', () => {
    expect(networkFailure()).toMatchObject({ code: 'network', retryable: true })
  })
})

describe('actionsBase', () => {
  it('swaps a trailing /chat for /actions', () => {
    expect(actionsBase('/api/chat')).toBe('/api/actions')
    expect(actionsBase('https://help.example.com/api/chat/')).toBe('https://help.example.com/api/actions')
  })

  it('lets data-actions-endpoint override it, without a trailing slash', () => {
    expect(actionsBase('/support/ask', '/support/act/')).toBe('/support/act')
    expect(actionsBase('/api/chat', '/other')).toBe('/other')
  })
})

describe('newSessionId', () => {
  it('is 32 hex characters, which the server accepts (8-64), and differs each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('draws on the supplied random source, 16 bytes', () => {
    let asked = 0
    const id = newSessionId((bytes) => {
      asked = bytes.length
      return bytes.fill(255)
    })
    expect(asked).toBe(16)
    expect(id).toBe('ff'.repeat(16))
  })
})
