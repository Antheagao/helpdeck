/**
 * Deterministic offline model: answers with the top context passage. Keeps
 * demos, tests, and CI fully keyless.
 */

import type { ChatMessage, CompleteOptions, Completion, LLM } from './llm.js'

export interface MockOptions {
  /** Pause between streamed words, so the UI visibly streams. Use 0 in tests
   *  and evals that want no timing at all. */
  tokenDelayMs?: number
}

export class MockLLM implements LLM {
  readonly model = 'mock-1'
  private readonly tokenDelayMs: number

  constructor({ tokenDelayMs = 1 }: MockOptions = {}) {
    this.tokenDelayMs = tokenDelayMs
  }

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    const contextMatch = /\[1\] [^\n]*\n([\s\S]*?)(?:\n\n\[2\]|\n\n---|$)/.exec(system)
    // The marker lets a reader (and the evals) see which passage the answer
    // came from; the prompt numbers the same passage [1].
    const answer = contextMatch?.[1]?.trim()
      ? `Here is what the documentation says [1]:\n\n${contextMatch[1].trim().slice(0, 500)}`
      : 'I could not find that in the documentation, so I would rather not guess. ' +
        'Try asking about setup, memory, retrieval, or tracing.'
    for (const word of answer.split(/(?<= )/)) {
      options.onToken?.(word)
      if (this.tokenDelayMs > 0) await new Promise((r) => setTimeout(r, this.tokenDelayMs))
    }
    const inputTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4)
    return {
      text: answer,
      toolCalls: [],
      finishReason: 'stop',
      model: this.model,
      inputTokens,
      outputTokens: Math.ceil(answer.length / 4),
    }
  }
}
