/**
 * The helpdeck server: one Express app serving the chat API (SSE streaming),
 * the embeddable widget bundle, and the demo page.
 *
 * Environment:
 *   PORT               listen port (default 4319)
 *   ANTHROPIC_API_KEY  use Claude (else OPENAI_API_KEY, else the offline mock)
 *   HELPDECK_MODEL     override the model id
 *   HELPDECK_DOCS      knowledge-base directory (default ./docs)
 *   SPANLIGHT_URL      ship traces to a spanlight collector (off when unset)
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

import { answer, makeSessionStore, type ChatDeps } from './chat.js'
import { llmFromEnv } from './llm.js'
import { BM25Index } from './retrieval.js'
import { Tracer } from './trace.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export function createApp(deps: ChatDeps): express.Express {
  const app = express()
  app.use(express.json({ limit: '32kb' }))

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      model: deps.llm.model,
      passages: deps.index.passages.length,
      spanlight: deps.tracer.enabled,
    })
  })

  app.post('/api/chat', async (req, res) => {
    const { sessionId, message } = req.body as { sessionId?: unknown; message?: unknown }
    if (typeof sessionId !== 'string' || sessionId.length < 8 || sessionId.length > 64) {
      res.status(400).json({ error: 'sessionId must be a string of 8-64 characters' })
      return
    }
    if (typeof message !== 'string' || !message.trim() || message.length > 4000) {
      res.status(400).json({ error: 'message must be a non-empty string under 4000 characters' })
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
      const result = await answer(
        deps,
        sessionId,
        message.trim(),
        (token) => send('token', { token }),
        (sources) => send('sources', { sources }),
      )
      send('done', {
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      })
    } catch (error) {
      send('error', { error: 'The assistant hit an internal error. Please try again.' })
      console.error('chat failed:', error)
    }
    res.end()
  })

  // The built widget and the demo page, when present.
  app.use(express.static(path.join(ROOT, 'widget', 'dist')))
  app.use(express.static(path.join(ROOT, 'demo')))

  return app
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const llm = llmFromEnv()
  const docsDir = process.env.HELPDECK_DOCS || path.join(ROOT, 'docs')
  const deps: ChatDeps = {
    llm,
    index: BM25Index.fromMarkdownDir(docsDir),
    tracer: new Tracer(process.env.SPANLIGHT_URL),
    sessions: makeSessionStore(llm),
  }
  const port = Number(process.env.PORT || 4319)
  createApp(deps).listen(port, () => {
    console.log(
      `helpdeck on http://127.0.0.1:${port} ` +
        `(model: ${deps.llm.model}, passages: ${deps.index.passages.length}, ` +
        `spanlight: ${deps.tracer.enabled ? 'on' : 'off'})`,
    )
  })
}
