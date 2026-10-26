/**
 * Shared test harness for the HTTP tests: a fresh app and stores per test, an
 * SSE reader, and scripted models.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import request from 'supertest'

import { buildDeps, type BuildDepsOptions } from '../server/deps.js'
import { createApp } from '../server/index.js'
import type { ChatMessage, Completion, LLM, ToolCall } from '../server/llm.js'
import { MockLLM } from '../server/mock-llm.js'
import type { ActionView, ChatEvent } from '../server/protocol.js'
import { BM25Index } from '../server/retrieval.js'

export const INDEX = BM25Index.fromMarkdownDir(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs'),
)

export type DepsOptions = Partial<Omit<BuildDepsOptions, 'index' | 'docsDir'>>

export function setup(options: DepsOptions = {}) {
  const deps = buildDeps({ llm: new MockLLM({ tokenDelayMs: 0 }), index: INDEX, ...options })
  return { deps, app: createApp(deps) }
}
export type Harness = ReturnType<typeof setup>['app']

export function parseEvents(body: string): ChatEvent[] {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1] ?? ''
      const data = JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? 'null') as unknown
      return { event, data } as ChatEvent
    })
}

export const textOf = (events: ChatEvent[]) =>
  events.flatMap((e) => (e.event === 'token' ? [e.data.token] : [])).join('')
export const actionOf = (events: ChatEvent[]): ActionView | undefined =>
  events.flatMap((e) => (e.event === 'action' ? [e.data.action] : []))[0]
export const kinds = (events: ChatEvent[]) => events.map((e) => e.event)

export async function chat(app: Harness, sessionId: string, message: string) {
  const res = await request(app)
    .post('/api/chat')
    .send({ sessionId, message })
    .buffer(true)
    .parse((r, cb) => {
      let data = ''
      r.on('data', (chunk: Buffer) => (data += chunk))
      r.on('end', () => cb(null, data))
    })
  if (res.status !== 200) throw new Error(`chat answered ${res.status}: ${JSON.stringify(res.body)}`)
  return { status: res.status, events: parseEvents(res.body as string) }
}

export const confirm = (app: Harness, id: string, sessionId: string) =>
  request(app).post(`/api/actions/${id}/confirm`).send({ sessionId })
export const cancel = (app: Harness, id: string, sessionId: string) =>
  request(app).post(`/api/actions/${id}/cancel`).send({ sessionId })

export async function proposeTicket(app: Harness, sessionId: string, message = 'Open a ticket: my desk lamp stopped working') {
  const { events } = await chat(app, sessionId, message)
  const action = actionOf(events)
  if (!action) throw new Error(`no action card in: ${kinds(events).join(', ')}`)
  return action
}

/** A model that returns the given turns in order, recording what it was sent. */
export class ScriptedLLM implements LLM {
  readonly model = 'scripted'
  readonly offline = false
  readonly seen: ChatMessage[][] = []
  private step = 0

  constructor(private readonly script: { text?: string; toolCalls?: ToolCall[]; finishReason?: Completion['finishReason'] }[]) {}

  async complete(messages: ChatMessage[], options?: { onToken?: (t: string) => void }): Promise<Completion> {
    this.seen.push(structuredClone(messages))
    const turn = this.script[Math.min(this.step++, this.script.length - 1)] ?? {}
    if (turn.text) options?.onToken?.(turn.text)
    const toolCalls = turn.toolCalls ?? []
    return {
      text: turn.text ?? '',
      toolCalls,
      finishReason: turn.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      model: this.model,
      inputTokens: 10,
      outputTokens: 5,
    }
  }
}

export const call = (name: string, args: unknown, id = 'call-1'): ToolCall => ({ id, name, arguments: args })
export const ticketCall = (id = 'call-1') => call('create_ticket', { subject: 'Hijacked', description: 'Do it' }, id)

/** A model taken over by injected text: it calls create_ticket every time. */
export const hijacked = () => new ScriptedLLM([{ toolCalls: [ticketCall()] }])
