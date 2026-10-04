import { useCallback, useRef, useState } from 'react'

export interface Source {
  source: string
  heading: string
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
  sources?: Source[]
  failed?: boolean
}

function newSessionId(): string {
  return `s-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/** Chat state over the SSE endpoint: appends tokens to the last assistant
 *  message as they arrive. */
export function useChat(endpoint: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState(false)
  const session = useRef(newSessionId())

  const reset = useCallback(() => {
    session.current = newSessionId()
    setMessages([])
  }, [])

  const send = useCallback(
    async (text: string) => {
      const question = text.trim()
      if (!question || streaming) return
      setMessages((m) => [...m, { role: 'user', content: question }, { role: 'assistant', content: '' }])
      setStreaming(true)

      const patchLast = (patch: Partial<Message>) =>
        setMessages((m) =>
          m.map((msg, i) => (i === m.length - 1 ? { ...msg, ...patch } : msg)),
        )
      const appendLast = (token: string) =>
        setMessages((m) =>
          m.map((msg, i) => (i === m.length - 1 ? { ...msg, content: msg.content + token } : msg)),
        )

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: session.current, message: question }),
        })
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split('\n\n')
          buffer = chunks.pop() ?? ''
          for (const chunk of chunks) {
            const event = /^event: (.+)$/m.exec(chunk)?.[1]
            const data = /^data: (.+)$/m.exec(chunk)?.[1]
            if (!event || !data) continue
            const payload = JSON.parse(data) as {
              token?: string
              sources?: Source[]
              error?: string
            }
            if (event === 'token' && payload.token) appendLast(payload.token)
            else if (event === 'sources' && payload.sources) patchLast({ sources: payload.sources })
            else if (event === 'error') {
              patchLast({ content: payload.error ?? 'Something went wrong.', failed: true })
            }
          }
        }
      } catch {
        patchLast({
          content: 'I could not reach the assistant. Please try again.',
          failed: true,
        })
      } finally {
        setStreaming(false)
      }
    },
    [endpoint, streaming],
  )

  return { messages, streaming, send, reset }
}
