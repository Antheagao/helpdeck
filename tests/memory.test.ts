import { describe, expect, it } from 'vitest'

import {
  ConversationMemory,
  SessionStore,
  estimateTokens,
  type Turn,
} from '../server/memory.js'

const turn = (role: Turn['role'], content: string): Turn => ({ role, content })

describe('estimateTokens', () => {
  it('is roughly chars/4 and never zero for text', () => {
    expect(estimateTokens('abcd'.repeat(10))).toBe(10)
    expect(estimateTokens('x')).toBe(1)
  })
})

describe('ConversationMemory', () => {
  it('keeps everything verbatim while under budget', async () => {
    const memory = new ConversationMemory({ budgetTokens: 10_000 })
    memory.add(turn('user', 'hello'))
    memory.add(turn('assistant', 'hi, how can I help?'))
    await memory.compact()
    expect(memory.render()).toEqual({
      summary: '',
      turns: [turn('user', 'hello'), turn('assistant', 'hi, how can I help?')],
    })
  })

  it('folds oldest turns into the summary when over budget, keeping recent turns', async () => {
    const summarized: Turn[][] = []
    const memory = new ConversationMemory({
      budgetTokens: 300,
      keepRecentTurns: 4,
      summarize: async (turns, previous) => {
        summarized.push(turns)
        return `${previous} +${turns.length}turns`.trim()
      },
    })
    for (let i = 0; i < 12; i++) {
      memory.add(turn(i % 2 ? 'assistant' : 'user', `message ${i} ${'x'.repeat(120)}`))
    }
    await memory.compact()
    const { summary, turns } = memory.render()
    expect(summarized.length).toBeGreaterThan(0)
    expect(summary).toContain('turns')
    expect(turns.length).toBeGreaterThanOrEqual(4)
    // The verbatim window keeps the latest messages, in order.
    expect(turns.at(-1)?.content).toContain('message 11')
    expect(memory.tokens()).toBeLessThanOrEqual(300 + 100) // summary adds back a little
  })

  it('falls back to the extractive summarizer when the LLM one throws', async () => {
    const memory = new ConversationMemory({
      budgetTokens: 100,
      keepRecentTurns: 2,
      summarize: async () => {
        throw new Error('provider down')
      },
    })
    for (let i = 0; i < 6; i++) {
      // Long enough that the six turns genuinely overflow the 100-token budget.
      memory.add(turn('user', `Question number ${i}. ${'More detail follows here. '.repeat(8)}`))
    }
    await memory.compact()
    const { summary } = memory.render()
    expect(summary).toContain('Question number 0.')
  })
})

describe('SessionStore', () => {
  it('returns the same memory for the same id and expires idle sessions', async () => {
    const store = new SessionStore(() => new ConversationMemory(), 10)
    const a = store.get('session-a')
    a.add(turn('user', 'remember me'))
    expect(store.get('session-a').render().turns).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 25))
    expect(store.get('session-a').render().turns).toHaveLength(0)
  })
})
