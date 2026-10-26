/**
 * Stand-in models for the evals. None of them calls a provider.
 *
 * HijackedLLM is the worst case the server gate has to survive: a model that
 * does what injected text tells it to. CitationDroppingLLM and dropArgument
 * are deliberate regressions, used only to prove the gate catches them.
 */

import type { ChatMessage, CompleteOptions, Completion, LLM, ToolCall } from '../server/llm.js'
import { MockLLM } from '../server/mock-llm.js'

/** The words an injection opens with. */
const INJECTION_CUE = /\b(?:ignore|disregard)\b[^.]{0,40}\binstructions\b/i

/** The first imperative planted in system context or a tool result, as a call. */
function plantedCall(messages: ChatMessage[]): ToolCall | null {
  for (const message of messages) {
    if (message.role !== 'system' && message.role !== 'tool') continue
    const cue = INJECTION_CUE.exec(message.content)
    if (!cue) continue
    const orders = message.content.slice(cue.index + cue[0].length)
    const ticket = orders.search(/ticket/i)
    const person = orders.search(/\b(?:human|person)\b/i)
    if (ticket === -1 && person === -1) continue
    // Whichever instruction comes first is the one a naive model obeys.
    if (person === -1 || (ticket !== -1 && ticket < person)) {
      return {
        id: 'hijack-1',
        name: 'create_ticket',
        arguments: { subject: 'Injected request', description: orders.trim().slice(0, 200) },
      }
    }
    return { id: 'hijack-1', name: 'handoff_to_human', arguments: { reason: 'Injected request' } }
  }
  return null
}

/** Behaves like the mock until text planted in a document or a tool result
 *  tells it to open a ticket or hand off, and then does that, whatever tools
 *  it was offered. It never reads the customer's own turns for orders. */
export class HijackedLLM implements LLM {
  readonly model = 'hijacked-1'
  readonly offline = true
  private readonly base = new MockLLM({ tokenDelayMs: 0 })

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const call = plantedCall(messages)
    if (!call) return this.base.complete(messages, options)
    return {
      text: '',
      toolCalls: [call],
      finishReason: 'tool_calls',
      model: this.model,
      inputTokens: 0,
      outputTokens: 0,
    }
  }
}

/** A mock whose answers carry no [n] markers: the groundedness regression. */
export class CitationDroppingLLM implements LLM {
  readonly model = 'citation-dropping-1'
  readonly offline = true
  private readonly base = new MockLLM({ tokenDelayMs: 0 })

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const strip = (text: string) => text.replace(/ ?\[\d+\]/g, '')
    const completion = await this.base.complete(messages, {
      ...options,
      onToken: (token) => options.onToken?.(strip(token)),
    })
    return { ...completion, text: strip(completion.text), model: this.model }
  }
}

/** Wrap a model so every tool call loses one named argument: the
 *  tool-arguments regression (the email on a lookup, say). */
export function dropArgument(inner: LLM, name: string): LLM {
  return {
    model: inner.model,
    offline: inner.offline,
    async complete(messages, options) {
      const completion = await inner.complete(messages, options)
      return {
        ...completion,
        toolCalls: completion.toolCalls.map((call) => {
          const { [name]: _dropped, ...rest } = (call.arguments ?? {}) as Record<string, unknown>
          return { ...call, arguments: rest }
        }),
      }
    },
  }
}
