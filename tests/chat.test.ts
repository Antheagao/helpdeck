import path from 'node:path'
import { fileURLToPath } from 'node:url'

import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { answer, makeHandoffSummarizer, makeSessionStore, makeSummarizer } from '../server/chat.js'
import { buildDeps, type AppDeps } from '../server/deps.js'
import { createApp } from '../server/index.js'
import { AnthropicLLM, OpenAILLM, type LLM } from '../server/llm.js'
import { extractiveSummarizer } from '../server/memory.js'
import { MockLLM } from '../server/mock-llm.js'
import { BM25Index } from '../server/retrieval.js'
import { Tracer } from '../server/trace.js'

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs')

function makeDeps(captured?: { url: string; body: unknown }[]): AppDeps {
  const fetchFn = (async (url: unknown, init?: { body?: unknown }) => {
    captured?.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response('{}', { status: 202 })
  }) as typeof fetch
  return buildDeps({
    llm: new MockLLM(),
    index: BM25Index.fromMarkdownDir(DOCS),
    tracer: new Tracer(captured ? 'http://spanlight.test' : undefined, fetchFn),
  })
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

describe('offline models', () => {
  it('take the extractive path, and a wrapper that forwards offline keeps it', () => {
    const mock = new MockLLM()
    const wrapped: LLM = { model: 'wrapped', offline: mock.offline, complete: (m, o) => mock.complete(m, o) }
    for (const llm of [mock, wrapped]) {
      expect(makeSummarizer(llm)).toBe(extractiveSummarizer)
      expect(makeHandoffSummarizer(llm)).toBeNull()
    }
  })

  it('give a real model the prose summarizers', () => {
    const online: LLM = { model: 'real', offline: false, complete: async () => { throw new Error('unused') } }
    expect(makeSummarizer(online)).not.toBe(extractiveSummarizer)
    expect(makeHandoffSummarizer(online)).toBeTypeOf('function')
  })
})

describe('makeSummarizer', () => {
  it('uses the extractive summarizer for the mock', () => {
    expect(makeSummarizer(new MockLLM())).toBe(extractiveSummarizer)
  })

  it('asks a real model to write the summary', async () => {
    const prompts: string[] = []
    const llm: LLM = {
      model: 'fake',
      offline: false,
      async complete(messages) {
        prompts.push(messages.map((m) => m.content).join('\n'))
        return { text: 'new summary', toolCalls: [], finishReason: 'stop', model: 'fake', inputTokens: 0, outputTokens: 0 }
      },
    }
    const summary = await makeSummarizer(llm)([{ role: 'user', content: 'my order is late' }], 'old summary')
    expect(summary).toBe('new summary')
    expect(prompts[0]).toContain('old summary')
    expect(prompts[0]).toContain('user: my order is late')
  })
})

describe('provider failures', () => {
  const GENERIC = 'The assistant hit an internal error. Please try again.'

  function depsFor(llm: LLM): AppDeps {
    return { ...makeDeps(), llm, sessions: makeSessionStore(llm) }
  }

  it('turns a mid-stream provider error into an SSE error and remembers nothing', async () => {
    const frames = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial ' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ]
    const fetchFn = (async () =>
      new Response(frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(''), {
        status: 200,
      })) as typeof fetch
    const deps = depsFor(new AnthropicLLM('test-key', { fetchFn }))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await sse(createApp(deps), { sessionId: 'failing-session', message: 'What is helpdeck?' })
      const body = res.body as string
      expect(body).toContain('event: error')
      expect(body).toContain(GENERIC)
      expect(body).not.toContain('event: done')
      expect(body).not.toContain('overloaded_error')
      expect(deps.sessions.get('failing-session').render().turns).toHaveLength(0)
    } finally {
      logged.mockRestore()
    }
  })

  it('never logs or returns a key echoed in the provider HTTP error body', async () => {
    const echoed = 'sk-proj-********************abcd'
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          error: {
            message: `Incorrect API key provided: ${echoed}.`,
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        }),
        { status: 401 },
      )) as typeof fetch
    const deps = depsFor(new OpenAILLM('test-key', { fetchFn }))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await sse(createApp(deps), { sessionId: 'bad-key-session', message: 'What is helpdeck?' })
      const output = JSON.stringify(logged.mock.calls, (_k, v: unknown) =>
        v instanceof Error ? { message: v.message, stack: v.stack } : v,
      )
      expect(output).toContain('openai: HTTP 401 invalid_request_error invalid_api_key')
      expect(output).not.toContain('sk-')
      expect(res.body as string).toContain(GENERIC)
      expect(res.body as string).not.toContain('sk-')
    } finally {
      logged.mockRestore()
    }
  })
})
