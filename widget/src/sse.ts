/**
 * Server-sent events, parsed from the text the chat endpoint streams. Pure, so
 * it is tested without a browser: feed it the buffer so far, keep the `rest`
 * it hands back, and call it once more with `final` at the end of the stream.
 *
 * Tolerates what a proxy or another server may do to the stream: CRLF line
 * endings, `data:` with no space, a payload split over several `data:` lines,
 * comment lines, and a last event with no blank line after it. Events it does
 * not know are ignored, which is what keeps a widget working against a newer
 * server that adds events.
 */

import type { ChatEvent } from '../../server/protocol.js'

// A Record, so adding an event to the protocol fails tsc until it is listed.
const KNOWN_EVENTS: Record<ChatEvent['event'], true> = {
  sources: true,
  token: true,
  tool: true,
  action: true,
  handoff: true,
  done: true,
  error: true,
}

const isKnownEvent = (name: string): name is ChatEvent['event'] => Object.hasOwn(KNOWN_EVENTS, name)

function parseFrame(frame: string): ChatEvent | null {
  let name = ''
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') name = value
    else if (field === 'data') data.push(value)
  }
  if (!isKnownEvent(name) || data.length === 0) return null
  let payload: unknown
  try {
    payload = JSON.parse(data.join('\n'))
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  // The one place the stream is trusted to match the protocol: our own server.
  return { event: name, data: payload } as ChatEvent
}

/**
 * Parse every complete event in `buffer`. `rest` is the unfinished tail to
 * prepend to the next chunk. With `final` the tail is parsed too, since the
 * stream has ended and nothing more will complete it.
 */
export function parseSse(buffer: string, final = false): { events: ChatEvent[]; rest: string } {
  // A chunk may end between the \r and \n of a CRLF; hold the \r back.
  const heldCarriageReturn = !final && buffer.endsWith('\r') ? '\r' : ''
  const text = buffer.slice(0, buffer.length - heldCarriageReturn.length).replace(/\r\n?/g, '\n')
  const frames = text.split('\n\n')
  const rest = final ? '' : `${frames.pop() ?? ''}${heldCarriageReturn}`
  const events: ChatEvent[] = []
  for (const frame of frames) {
    const event = parseFrame(frame)
    if (event) events.push(event)
  }
  return { events, rest }
}
