/**
 * The chat pipeline: retrieve context, build the prompt inside the token
 * budget, stream the model, remember the exchange - with each step traced.
 */

import type { LLM, ChatMessage } from './llm.js'
import { MockLLM } from './llm.js'
import { ConversationMemory, SessionStore, extractiveSummarizer, type Summarizer } from './memory.js'
import type { BM25Index, Hit } from './retrieval.js'
import type { Tracer } from './trace.js'

export interface ChatDeps {
  llm: LLM
  index: BM25Index
  tracer: Tracer
  sessions: SessionStore
  productName?: string
}

export interface ChatResult {
  text: string
  sources: { source: string; heading: string }[]
  model: string
  inputTokens: number
  outputTokens: number
}

/** LLM-backed rolling summarizer; falls back to extractive on any failure
 *  (ConversationMemory.compact already guards the call). */
export function llmSummarizer(llm: LLM): Summarizer {
  return async (turns, previousSummary) => {
    const transcript = turns.map((t) => `${t.role}: ${t.content}`).join('\n')
    const { text } = await llm.complete([
      {
        role: 'system',
        content:
          'Update the running conversation summary. Keep every fact a support ' +
          'agent would need later. Reply with the new summary only, under 150 words.',
      },
      {
        role: 'user',
        content: `Current summary:\n${previousSummary || '(none)'}\n\nNew turns:\n${transcript}`,
      },
    ])
    return text
  }
}

export function makeSessionStore(llm: LLM): SessionStore {
  const summarize = llm instanceof MockLLM ? extractiveSummarizer : llmSummarizer(llm)
  return new SessionStore(
    () => new ConversationMemory({ budgetTokens: 2000, keepRecentTurns: 6, summarize }),
  )
}

function buildMessages(
  product: string,
  hits: Hit[],
  summary: string,
  turns: { role: 'user' | 'assistant'; content: string }[],
  question: string,
): ChatMessage[] {
  const context = hits
    .map((h, i) => `[${i + 1}] ${h.source} - ${h.heading}\n${h.text}`)
    .join('\n\n')
  const system = [
    `You are the support assistant for ${product}, embedded on its website.`,
    'Answer from the documentation context below. Cite sections as [1], [2]. ' +
      'If the context does not cover the question, say so plainly instead of guessing.',
    context ? `Context:\n${context}` : 'Context: (nothing relevant found)',
    '---',
    summary ? `Conversation so far (summarized):\n${summary}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  return [
    { role: 'system', content: system },
    ...turns,
    { role: 'user', content: question },
  ]
}

export async function answer(
  deps: ChatDeps,
  sessionId: string,
  question: string,
  onToken?: (token: string) => void,
  onSources?: (sources: ChatResult['sources']) => void,
): Promise<ChatResult> {
  const product = deps.productName ?? 'helpdeck'
  const memory = deps.sessions.get(sessionId)
  const trace = deps.tracer.start('chat-request', { product }, sessionId)

  try {
    const hits = await trace.span('retrieve-context', 'retrieval', async () => {
      return deps.index.search(question, 4)
    }, (record, result) => {
      record.input = question
      record.attributes = { hits: result.length, top: result[0]?.source ?? null }
    })
    const sources = hits.map((h) => ({ source: h.source, heading: h.heading }))
    onSources?.(sources)

    const { summary, turns } = memory.render()
    const messages = buildMessages(product, hits, summary, turns, question)

    const completion = await trace.span('answer', 'llm', async () => {
      return deps.llm.complete(messages, onToken)
    }, (record, result) => {
      trace.recordLlmUsage(record, result.model, result.inputTokens, result.outputTokens)
      record.input = question
      record.output = result.text
    })

    memory.add({ role: 'user', content: question })
    memory.add({ role: 'assistant', content: completion.text })
    await trace.span('compact-memory', 'other', () => memory.compact())

    return {
      text: completion.text,
      sources,
      model: completion.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
    }
  } finally {
    void deps.tracer.send(trace)
  }
}
