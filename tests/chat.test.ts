import path from 'node:path'
import { fileURLToPath } from 'node:url'

import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { answer, makeSessionStore, type ChatDeps } from '../server/chat.js'
import { createApp } from '../server/index.js'
import { MockLLM } from '../server/llm.js'
import { BM25Index } from '../server/retrieval.js'
import { Tracer } from '../server/trace.js'

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs')

function makeDeps(captured?: { url: string; body: unknown }[]): ChatDeps {
  const llm = new MockLLM()
  const fetchFn = (async (url: unknown, init?: { body?: unknown }) => {
    captured?.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response('{}', { status: 202 })
  }) as typeof fetch
  return {
    llm,
    index: BM25Index.fromMarkdownDir(DOCS),
    tracer: new Tracer(captured ? 'http://spanlight.test' : undefined, fetchFn),
    sessions: makeSessionStore(llm),
  }
}

const sse = (app: ReturnType<typeof createApp>, body: object) =>
  request(app)
    .post('/api/chat')
    .send(body)
    .buffer(true)
    .parse((res, cb) => {
      let data = ''
      res.on('data', (chunk: Buffer) => (data += chunk))
      res.on('end', () => cb(null, data))
    })

describe('POST /api/chat', () => {
  it('rejects malformed requests', async () => {
    const app = createApp(makeDeps())
    await request(app).post('/api/chat').send({ message: 'hi' }).expect(400)
    await request(app).post('/api/chat').send({ sessionId: 'short', message: 'hi' }).expect(400)
    await request(app)
      .post('/api/chat')
      .send({ sessionId: 'a'.repeat(12), message: '' })
      .expect(400)
  })

  it('streams sources, tokens, and a done event', async () => {
    const app = createApp(makeDeps())
    const res = await sse(app, {
      sessionId: 'test-session-1',
      message: 'How do I install the widget?',
    })
    const body = res.body as string
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(body).toContain('event: sources')
    expect(body).toContain('setup.md')
    expect(body).toContain('event: token')
    expect(body).toContain('event: done')
    expect(body).toContain('"model":"mock-1"')
  })

  it('keeps per-session memory across requests', async () => {
    const deps = makeDeps()
    const app = createApp(deps)
    await sse(app, { sessionId: 'memory-session', message: 'What is helpdeck?' })
    await sse(app, { sessionId: 'memory-session', message: 'And how is memory handled?' })
    expect(deps.sessions.get('memory-session').render().turns).toHaveLength(4)
    expect(deps.sessions.get('other-session').render().turns).toHaveLength(0)
  })
})

describe('tracing', () => {
  it('ships one trace with retrieval, llm, and memory spans', async () => {
    const captured: { url: string; body: unknown }[] = []
    const deps = makeDeps(captured)
    await answer(deps, 'traced-session', 'How does retrieval work?')
    expect(captured).toHaveLength(1)
    const batch = captured[0]!.body as {
      traces: { name: string; status: string }[]
      spans: { name: string; kind: string; model: string | null; cost_usd: number | null }[]
    }
    expect(captured[0]!.url).toBe('http://spanlight.test/api/ingest')
    expect(batch.traces[0]).toMatchObject({ name: 'chat-request', status: 'ok' })
    expect(batch.spans.map((s) => s.kind).sort()).toEqual(['llm', 'other', 'retrieval'])
    const llmSpan = batch.spans.find((s) => s.kind === 'llm')!
    expect(llmSpan.model).toBe('mock-1')
    expect(llmSpan.cost_usd).toBeNull() // unknown model: no made-up cost
  })
})
