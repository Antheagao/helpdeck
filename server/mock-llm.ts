/**
 * Deterministic offline model. It answers from the top documentation passage
 * and follows a small, fixed tool policy, so demos, tests, and CI stay fully
 * keyless and repeatable.
 *
 * The tool policy reads intent only from user turns. Documentation, tool
 * results, and its own earlier replies are never searched for instructions,
 * and it only proposes tools it was offered. That is what makes the mock a
 * fair baseline for the injection cases: it cannot be talked into anything by
 * text a customer or a document planted.
 */

import type { ChatMessage, CompleteOptions, Completion, LLM, ToolCall } from './llm.js'
import type { ToolName } from './protocol.js'

export interface MockOptions {
  /** Pause between streamed words, so the UI visibly streams. Use 0 in tests
   *  and evals that want no timing at all. */
  tokenDelayMs?: number
}

const ORDER_ID = /\bHD-\d{4}\b/i
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

// A person is asked for with an intent verb ("talk to", "I want", "connect me
// with"); the bare nouns alone are also doc questions ("How does human handoff
// work?").
const HANDOFF =
  /\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:a\s+|an\s+|the\s+|some\s+)?(?:real\s+|live\s+)?(?:person|human|agent|someone|somebody|representative)\b|\b(?:want|need|get|speak|talk|connect)\b[^.?!]{0,30}\b(?:human|live agent|real person)\b/i
const MASS_ACTION =
  /\b(?:all|every)\s+(?:the\s+)?(?:orders?|customers?|tickets?|users?|accounts?)\b|\beveryone\b|\beverybody\b/i
const TICKET =
  /\b(?:open|create|file|raise|submit|log|make|start)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:support\s+)?ticket\b/i
const UNSUPPORTED =
  /\b(?:refund|cancel|delete|remove)\s+(?:my|the|this|that|an?|all|every|order|account|it)\b|\b(?:want|need|get|give\s+me|issue)\s+(?:a\s+|my\s+)?refund\b/i

const UNAVAILABLE_SUFFIX = 'I can answer questions from the documentation.'
const UNAVAILABLE = `I am not able to do that here. ${UNAVAILABLE_SUFFIX}`
const DECLINE =
  'I could not find that in the documentation, so I would rather not guess. ' +
  'Try asking about setup, memory, retrieval, or tracing.'

/** What the bot says when asked for something it cannot do: what it can do
 *  from the tools it was offered, and a handoff only if that is offered. */
function refusal(offered: Set<string>): string {
  const can = [
    offered.has('lookup_order') ? 'look up an order (with its number and the email on it)' : null,
    offered.has('create_ticket') ? 'open a support ticket for you' : null,
    offered.has('handoff_to_human') ? 'hand this chat to a person' : null,
  ].filter((item) => item !== null)
  if (can.length === 0) return `I am not able to do that. ${UNAVAILABLE_SUFFIX}`
  const list = can.length > 1 ? `${can.slice(0, -1).join(', ')}, or ${can.at(-1)}` : can[0]
  const offer = offered.has('handoff_to_human') ? ' Would you like me to hand this chat to a person?' : ''
  return `I am not able to do that. I can ${list}.${offer}`
}

/** The first `max` characters, cut back to a word boundary when it is cut. A
 *  boundary that would leave under half the room (a short first word, then
 *  one long unbroken token) is not worth it: that cut would be too short to
 *  be a valid subject, so the hard cut stays. */
function cutAtWord(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  const cut = chars.slice(0, max).join('')
  const space = cut.lastIndexOf(' ')
  return (space >= max / 2 ? cut.slice(0, space) : cut).trimEnd()
}

/** The latest user turn that contains a match, searched newest first. */
function latestMatch(userTurns: string[], pattern: RegExp): string | undefined {
  for (const turn of [...userTurns].reverse()) {
    const match = pattern.exec(turn)
    if (match) return match[0]
  }
  return undefined
}

function renderToolResult(content: string): string {
  let result: unknown
  try {
    result = JSON.parse(content)
  } catch {
    return 'I could not read the result of that lookup.'
  }
  const fields = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
  if (fields.found === false) {
    return 'I could not find an order with that number and email. Please check both and try again.'
  }
  const order = fields.order as
    | { orderId: string; status: string; carrier: string | null; trackingNumber: string | null }
    | undefined
  if (fields.found === true && order) {
    const via = order.carrier && order.trackingNumber ? ` via ${order.carrier} (tracking ${order.trackingNumber})` : ''
    return `Order ${order.orderId} is ${order.status}${via}.`
  }
  return 'I could not complete that. Please try again.'
}

export class MockLLM implements LLM {
  readonly model = 'mock-1'
  private readonly tokenDelayMs: number

  constructor({ tokenDelayMs = 1 }: MockOptions = {}) {
    this.tokenDelayMs = tokenDelayMs
  }

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const offered = new Set<string>((options.tools ?? []).map((tool) => tool.name))
    const { text, toolCalls } = this.decide(messages, offered)
    for (const word of text.split(/(?<= )/)) {
      if (!word) continue
      options.onToken?.(word)
      if (this.tokenDelayMs > 0) await new Promise((r) => setTimeout(r, this.tokenDelayMs))
    }
    const inputTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4)
    return {
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      model: this.model,
      inputTokens,
      outputTokens: Math.ceil(text.length / 4),
    }
  }

  private decide(messages: ChatMessage[], offered: Set<string>): { text: string; toolCalls: ToolCall[] } {
    // After a read tool ran, say what it found.
    const trailingResults: string[] = []
    for (const message of [...messages].reverse()) {
      if (message.role !== 'tool') break
      trailingResults.unshift(message.content)
    }
    if (trailingResults.length > 0) {
      return { text: trailingResults.map(renderToolResult).join('\n\n'), toolCalls: [] }
    }

    const userTurns = messages.flatMap((m) => (m.role === 'user' ? [m.content] : []))
    const latest = userTurns.at(-1) ?? ''
    const call = (name: ToolName, args: Record<string, string>, text: string) => ({
      text,
      toolCalls: [{ id: 'mock-call-1', name, arguments: args }],
    })
    const needs = (name: ToolName, propose: () => { text: string; toolCalls: ToolCall[] }) =>
      offered.has(name) ? propose() : { text: UNAVAILABLE, toolCalls: [] }

    if (HANDOFF.test(latest)) {
      return needs('handoff_to_human', () =>
        call(
          'handoff_to_human',
          { reason: cutAtWord(latest.trim(), 300) },
          'I can hand this conversation to a person. Please confirm below.',
        ),
      )
    }
    if (MASS_ACTION.test(latest)) return { text: refusal(offered), toolCalls: [] }

    const ticket = TICKET.exec(latest)
    if (ticket) {
      return needs('create_ticket', () => {
        const rest = latest
          .slice(ticket.index + ticket[0].length)
          .replace(/^[\s:,;.-]*(?:(?:for|about|regarding|saying|that)\s+)?/i, '')
          .trim()
        const subject = cutAtWord(rest.length >= 3 ? rest : latest.trim(), 80)
        return call(
          'create_ticket',
          { subject, description: cutAtWord(latest.trim(), 2000) },
          'I can open that ticket for you. Please confirm below.',
        )
      })
    }
    if (UNSUPPORTED.test(latest)) return { text: refusal(offered), toolCalls: [] }

    if (ORDER_ID.test(latest) || EMAIL.test(latest)) {
      const orderId = latestMatch(userTurns, ORDER_ID)
      const email = latestMatch(userTurns, EMAIL)
      if (orderId && email) {
        return needs('lookup_order', () =>
          call('lookup_order', { order_id: orderId, email }, 'Let me look that up.'),
        )
      }
      if (orderId) {
        return {
          text: `Thanks. What is the email address on order ${orderId.toUpperCase()}? I need it to look the order up.`,
          toolCalls: [],
        }
      }
    }
    return { text: this.documentationAnswer(messages), toolCalls: [] }
  }

  private documentationAnswer(messages: ChatMessage[]): string {
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    const block = /<documentation>\n([\s\S]*?)\n<\/documentation>/.exec(system)?.[1] ?? ''
    const contextMatch = /\[1\] [^\n]*\n([\s\S]*?)(?:\n\n\[2\] |$)/.exec(block)
    // The marker lets a reader (and the evals) see which passage the answer
    // came from; the prompt numbers the same passage [1].
    return contextMatch?.[1]?.trim()
      ? `Here is what the documentation says [1]:\n\n${contextMatch[1].trim().slice(0, 500)}`
      : DECLINE
  }
}
