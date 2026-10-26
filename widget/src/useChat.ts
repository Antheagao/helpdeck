import { useCallback, useMemo, useReducer, useRef, useState } from 'react'

import type { ConfirmResponse } from '../../server/protocol.js'
import {
  actionsBase,
  chatReducer,
  failureFrom,
  initialState,
  networkFailure,
  newSessionId,
  type Failure,
} from './chatState'
import { parseSse } from './sse'

export type { ActionItem, ActionState, Message } from './chatState'

async function readFailure(response: Response): Promise<Failure> {
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Not JSON (a proxy's error page): the status alone decides.
  }
  return failureFrom(response.status, body, response.headers.get('retry-after'))
}

/** Chat state over the SSE endpoint, plus confirm and cancel for the action
 *  cards. The state itself lives in chatReducer; this only does the fetching. */
export function useChat(endpoint: string, actionsEndpoint?: string) {
  const [state, dispatch] = useReducer(chatReducer, initialState)
  const [streaming, setStreaming] = useState(false)
  const session = useRef(newSessionId())
  const streamingRef = useRef(false)
  const inFlight = useRef(new Set<string>())
  const base = useMemo(() => actionsBase(endpoint, actionsEndpoint), [endpoint, actionsEndpoint])

  const reset = useCallback(() => {
    session.current = newSessionId()
    dispatch({ type: 'reset' })
  }, [])

  const send = useCallback(
    async (text: string) => {
      const question = text.trim()
      if (!question || streamingRef.current) return
      streamingRef.current = true
      setStreaming(true)
      dispatch({ type: 'send', text: question })
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: session.current, message: question }),
        })
        if (!response.ok || !response.body) {
          const failure = response.ok ? networkFailure() : await readFailure(response)
          dispatch({ type: 'transport-failed', message: failure.message })
          return
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parsed = parseSse(buffer)
          buffer = parsed.rest
          for (const event of parsed.events) dispatch({ type: 'event', event })
        }
        for (const event of parseSse(buffer + decoder.decode(), true).events) dispatch({ type: 'event', event })
      } catch {
        dispatch({ type: 'transport-failed', message: 'I could not reach the assistant. Please try again.' })
      } finally {
        streamingRef.current = false
        setStreaming(false)
      }
    },
    [endpoint],
  )

  const postAction = useCallback(
    (id: string, verb: 'confirm' | 'cancel') =>
      fetch(`${base}/${encodeURIComponent(id)}/${verb}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: session.current }),
      }),
    [base],
  )

  // One request per card at a time. Retrying a failed confirm is safe: the
  // server runs an action once however often it is confirmed.
  const confirm = useCallback(
    async (id: string) => {
      if (inFlight.current.has(id)) return
      inFlight.current.add(id)
      dispatch({ type: 'confirming', id })
      try {
        const response = await postAction(id, 'confirm')
        if (response.ok) {
          dispatch({ type: 'confirmed', id, response: (await response.json()) as ConfirmResponse })
        } else {
          dispatch({ type: 'confirm-failed', id, failure: await readFailure(response) })
        }
      } catch {
        dispatch({ type: 'confirm-failed', id, failure: networkFailure() })
      } finally {
        inFlight.current.delete(id)
      }
    },
    [postAction],
  )

  const cancel = useCallback(
    async (id: string) => {
      if (inFlight.current.has(id)) return
      inFlight.current.add(id)
      try {
        const response = await postAction(id, 'cancel')
        if (response.ok) dispatch({ type: 'cancelled', id })
        else dispatch({ type: 'cancel-failed', id, failure: await readFailure(response) })
      } catch {
        dispatch({ type: 'cancel-failed', id, failure: networkFailure() })
      } finally {
        inFlight.current.delete(id)
      }
    },
    [postAction],
  )

  return { ...state, streaming, send, confirm, cancel, reset }
}
