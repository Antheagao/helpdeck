import { describe, expect, it } from 'vitest'

import type { ChatEvent } from '../server/protocol.js'
import { parseSse } from '../widget/src/sse.js'

/** Feed a stream to the parser chunk by chunk, as the widget's read loop does. */
function parseChunks(chunks: string[]): ChatEvent[] {
  const events: ChatEvent[] = []
  let buffer = ''
  for (const chunk of chunks) {
    buffer += chunk
    const parsed = parseSse(buffer)
    events.push(...parsed.events)
    buffer = parsed.rest
  }
  events.push(...parseSse(buffer, true).events)
  return events
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const STREAM =
  frame('sources', { sources: [{ source: 'setup.md', heading: 'Install and run' }] }) +
  frame('token', { token: 'Café ☕ ' }) +
  frame('tool', { name: 'lookup_order', label: 'Looked up order HD-1042' }) +
  frame('handoff', { reference: 'H-1001', status: 'waiting', followUpRecorded: true }) +
  frame('done', { model: 'mock-1', inputTokens: 3, outputTokens: 4 })

const EXPECTED: ChatEvent[] = [
  { event: 'sources', data: { sources: [{ source: 'setup.md', heading: 'Install and run' }] } },
  { event: 'token', data: { token: 'Café ☕ ' } },
  { event: 'tool', data: { name: 'lookup_order', label: 'Looked up order HD-1042' } },
  { event: 'handoff', data: { reference: 'H-1001', status: 'waiting', followUpRecorded: true } },
  { event: 'done', data: { model: 'mock-1', inputTokens: 3, outputTokens: 4 } },
]

describe('parseSse', () => {
  it('parses a whole stream in one chunk', () => {
    expect(parseChunks([STREAM])).toEqual(EXPECTED)
  })

  it('returns the unfinished tail as rest', () => {
    const { events, rest } = parseSse(`${frame('token', { token: 'a' })}event: token\ndata: {"tok`)
    expect(events).toEqual([{ event: 'token', data: { token: 'a' } }])
    expect(rest).toBe('event: token\ndata: {"tok')
  })

  it('gives the same events however the stream is cut into chunks', () => {
    for (let i = 0; i <= STREAM.length; i++) {
      expect(parseChunks([STREAM.slice(0, i), STREAM.slice(i)]), `split at ${i}`).toEqual(EXPECTED)
    }
    expect(parseChunks([...STREAM])).toEqual(EXPECTED)
  })

  it('reads CRLF line endings, including a CRLF split between chunks', () => {
    const crlf = STREAM.replaceAll('\n', '\r\n')
    expect(parseChunks([crlf])).toEqual(EXPECTED)
    for (let i = 0; i <= crlf.length; i++) {
      expect(parseChunks([crlf.slice(0, i), crlf.slice(i)]), `split at ${i}`).toEqual(EXPECTED)
    }
    expect(parseChunks([...crlf])).toEqual(EXPECTED)
  })

  it('reads fields with no space after the colon', () => {
    expect(parseChunks(['event:token\ndata:{"token":"hi"}\n\n'])).toEqual([
      { event: 'token', data: { token: 'hi' } },
    ])
  })

  it('joins a payload split over several data lines', () => {
    expect(parseChunks(['event: token\ndata: {"token":\ndata: "a b"}\n\n'])).toEqual([
      { event: 'token', data: { token: 'a b' } },
    ])
  })

  it('parses a final event that has no blank line after it, only when the stream ends', () => {
    const unterminated = 'event: done\ndata: {"model":"m","inputTokens":1,"outputTokens":2}'
    expect(parseSse(unterminated).events).toEqual([])
    expect(parseSse(unterminated).rest).toBe(unterminated)
    expect(parseChunks([unterminated])).toEqual([
      { event: 'done', data: { model: 'm', inputTokens: 1, outputTokens: 2 } },
    ])
  })

  it('ignores unknown events, comments, keep-alives, and frames with no data', () => {
    const stream =
      ': keep-alive\n\n' +
      frame('future-event', { anything: true }) +
      'data: {"token":"no event name"}\n\n' +
      'event: token\n\n' +
      frame('token', { token: 'kept' })
    expect(parseChunks([stream])).toEqual([{ event: 'token', data: { token: 'kept' } }])
  })

  it('skips a frame whose data is not a JSON object, and keeps going', () => {
    const stream =
      'event: token\ndata: {broken\n\n' +
      'event: token\ndata: "a string"\n\n' +
      'event: token\ndata: null\n\n' +
      frame('token', { token: 'after' })
    expect(parseChunks([stream])).toEqual([{ event: 'token', data: { token: 'after' } }])
  })

  it('does not treat a lookalike event name as known', () => {
    expect(parseChunks([frame('constructor', {}), frame('__proto__', {}), frame('toString', {})])).toEqual([])
  })
})
