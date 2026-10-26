/**
 * The helpdeck server: one Express app serving the chat API (SSE streaming),
 * the action confirm/cancel API, the embeddable widget bundle, and the demo
 * page.
 *
 * Environment:
 *   PORT               listen port (default 4319)
 *   MODEL_PROVIDER     anthropic | openai | mock; unset picks by key (below)
 *   ANTHROPIC_API_KEY  use Claude (else OPENAI_API_KEY, else the offline mock)
 *   HELPDECK_MODEL     override the model id
 *   HELPDECK_DOCS      knowledge-base directory (default ./docs)
 *   HELPDECK_TOOLS     tools offered to the model: a comma-separated list of
 *                      lookup_order, create_ticket, handoff_to_human; "none"
 *                      or empty for none (default: all). Whether a tool needs
 *                      confirmation is fixed in code, not configurable.
 *   HELPDECK_OPERATOR_TOKEN  bearer token (at least 32 characters) for the
 *                      operator API that lists handoffs; unset turns it off
 *   SPANLIGHT_URL      ship traces to a spanlight collector (off when unset)
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

import type { Executor } from './actions.js'
import { answer } from './chat.js'
import { buildDeps, type AppDeps } from './deps.js'
import { executeWrite } from './execute.js'
import { HandoffQueueFullError, parseOperatorToken, toOperatorView } from './handoff.js'
import { TicketLimitError } from './backend.js'
import { ConfigError, llmFromEnv, type LLM, type ModelProvider } from './llm.js'
import {
  MAX_MESSAGE_CHARS,
  type ApiErrorBody,
  type ApiErrorCode,
  type CancelResponse,
  type ChatEvent,
  type ConfirmResponse,
  type OperatorListResponse,
} from './protocol.js'
import { clientKey, type FixedWindowLimiter } from './rate-limit.js'
import { BM25Index } from './retrieval.js'
import { parseEnabledTools, type ToolName } from './tools.js'
import { Tracer } from './trace.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Action ids are 16 random bytes in hex; anything else is not an action. */
const ACTION_ID = /^[0-9a-f]{32}$/

/** Handoff references run H-1001, H-1002, ... */
const HANDOFF_REFERENCE = /^H-\d{4,9}$/

/** Handoffs per page of the operator list. */
const OPERATOR_PAGE_SIZE = 50

function apiError(res: express.Response, status: number, code: ApiErrorCode, message: string): void {
  const body: ApiErrorBody = { error: { code, message } }
  res.status(status).json(body)
}

/** An unknown action, another session's, or one long gone: all the same answer. */
const ACTION_NOT_FOUND = 'That request is no longer available. Please ask again.'

/** How a refused confirm or cancel is reported to the client. */
const REFUSALS = {
  not_found: { status: 404, code: 'action_not_found', message: ACTION_NOT_FOUND },
  action_not_pending: {
    status: 409,
    code: 'action_not_pending',
    message: 'This request was already cancelled or carried out.',
  },
  action_expired: { status: 409, code: 'action_expired', message: 'This request expired. Please ask again.' },
} as const

/** Reject with 429 once a client address has used its window. Mounted before
 *  the body parser on each limited route, so a flood is turned away before
 *  any body is read. */
function rateLimited(limiter: FixedWindowLimiter): express.RequestHandler {
  return (req, res, next) => {
    // req.ip is the socket address: no proxy headers are trusted.
    const decision = limiter.hit(clientKey(req.ip))
    if (decision.allowed) {
      next()
      return
    }
    res.setHeader('Retry-After', String(decision.retryAfterSeconds))
    apiError(res, 429, 'rate_limited', 'Too many requests. Please wait a moment and try again.')
  }
}

/** The session id the widget sent, or null when it is not an 8-64 character string. */
function sessionIdFrom(body: unknown): string | null {
  const { sessionId } = (body ?? {}) as { sessionId?: unknown }
  return typeof sessionId === 'string' && sessionId.length >= 8 && sessionId.length <= 64 ? sessionId : null
}

export function createApp(deps: AppDeps): express.Express {
  const app = express()
  const jsonBody = express.json({ limit: '32kb' })

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      model: deps.llm.model,
      passages: deps.index.passages.length,
      spanlight: deps.tracer.enabled,
    })
  })

  app.post('/api/chat', rateLimited(deps.limiters.chat), jsonBody, async (req, res) => {
    const sessionId = sessionIdFrom(req.body)
    if (!sessionId) {
      apiError(res, 400, 'invalid_session_id', 'sessionId must be a string of 8-64 characters')
      return
    }
    const { message } = req.body as { message?: unknown }
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_CHARS) {
      apiError(res, 400, 'invalid_message', `message must be a non-empty string of at most ${MAX_MESSAGE_CHARS} characters`)
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event: ChatEvent) => {
      res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
    }

    try {
      const result = await answer(deps, sessionId, message.trim(), send)
      send({
        event: 'done',
        data: { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      })
    } catch (error) {
      send({ event: 'error', data: { error: 'The assistant hit an internal error. Please try again.' } })
      console.error('chat failed:', error)
    }
    res.end()
  })

  // The only route that executes a write. Express 4 does not forward a
  // rejected async handler, so each handler below catches for itself.
  app.post('/api/actions/:id/confirm', rateLimited(deps.limiters.actions), jsonBody, async (req, res) => {
    const sessionId = sessionIdFrom(req.body)
    if (!sessionId) {
      apiError(res, 400, 'invalid_session_id', 'sessionId must be a string of 8-64 characters')
      return
    }
    const id = req.params.id ?? ''
    if (!ACTION_ID.test(id)) {
      apiError(res, 404, 'action_not_found', ACTION_NOT_FOUND)
      return
    }

    const trace = deps.tracer.start('action-confirm', {}, sessionId)
    // Only the effect itself is memoized, so nothing after it can fail the run
    // and make a retry repeat it.
    const execute: Executor = (action) => executeWrite(action, { tickets: deps.tickets, handoffs: deps.handoffs })
    try {
      // A confirm repeated within an hour of the proposal (the store's retention)
      // replays the stored result; after that the action is not found.
      const confirmed = await trace.span('confirm-action', 'tool', () => {
        return deps.actions.confirm(id, sessionId, execute, {
          onFirstDone: (outcome) => {
            deps.sessions.get(sessionId).add({ role: 'assistant', content: outcome.message })
          },
        })
      }, (record, result) => {
        record.attributes = result.ok ? { tool: result.tool, result: result.outcome.result } : { refused: result.code }
      })
      if (!confirmed.ok) {
        const { status, code, message } = REFUSALS[confirmed.code]
        apiError(res, status, code, message)
        return
      }
      const body: ConfirmResponse = {
        action: { id: confirmed.id, tool: confirmed.tool, status: 'done', result: confirmed.outcome.result },
        message: confirmed.outcome.message,
      }
      res.json(body)
    } catch (error) {
      if (error instanceof TicketLimitError) {
        apiError(res, 409, 'limit_reached', 'You have reached the limit of tickets for this chat.')
        return
      }
      if (error instanceof HandoffQueueFullError) {
        // Not consumed: the action stays retryable and the bot keeps answering.
        console.warn('handoff queue is full; a customer could not be handed off')
        apiError(res, 409, 'handoff_queue_full', 'The support team cannot take new handoffs right now. Please try again later.')
        return
      }
      console.error('action failed:', error)
      apiError(res, 500, 'action_failed', 'Something went wrong. Please try again.')
    } finally {
      void deps.tracer.send(trace)
    }
  })

  app.post('/api/actions/:id/cancel', rateLimited(deps.limiters.actions), jsonBody, (req, res) => {
    try {
      const sessionId = sessionIdFrom(req.body)
      if (!sessionId) {
        apiError(res, 400, 'invalid_session_id', 'sessionId must be a string of 8-64 characters')
        return
      }
      const id = req.params.id ?? ''
      if (!ACTION_ID.test(id)) {
        apiError(res, 404, 'action_not_found', ACTION_NOT_FOUND)
        return
      }
      const cancelled = deps.actions.cancel(id, sessionId)
      if (!cancelled.ok) {
        const { status, code, message } = REFUSALS[cancelled.code]
        apiError(res, status, code, message)
        return
      }
      const body: CancelResponse = { action: { id: cancelled.id, tool: cancelled.tool, status: 'cancelled' } }
      res.json(body)
    } catch (error) {
      console.error('cancel failed:', error)
      apiError(res, 500, 'action_failed', 'Something went wrong. Please try again.')
    }
  })

  // The operator API: handoff records hold customer text, so the token is the
  // boundary. With no token set these routes do not exist (the final handler
  // answers 404). Marked uncacheable, then limited, then authenticated.
  const authorize = deps.operatorAuth
  if (authorize) {
    // Handoffs hold customer text: no response from these routes, a 429
    // included, may be stored by a cache.
    const noStore: express.RequestHandler = (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store')
      next()
    }
    const operatorOnly: express.RequestHandler = (req, res, next) => {
      if (authorize(req.headers.authorization)) {
        next()
        return
      }
      res.setHeader('WWW-Authenticate', 'Bearer')
      apiError(res, 401, 'unauthorized', 'A valid operator token is required.')
    }
    app.get('/api/operator/handoffs', noStore, rateLimited(deps.limiters.operator), operatorOnly, (_req, res) => {
      const body: OperatorListResponse = {
        handoffs: deps.handoffs.list(OPERATOR_PAGE_SIZE).map(toOperatorView),
        nextCursor: null,
      }
      res.json(body)
    })
    app.get('/api/operator/handoffs/:reference', noStore, rateLimited(deps.limiters.operator), operatorOnly, (req, res) => {
      const reference = req.params.reference ?? ''
      const record = HANDOFF_REFERENCE.test(reference) ? deps.handoffs.get(reference) : undefined
      if (!record) {
        apiError(res, 404, 'handoff_not_found', 'No such handoff.')
        return
      }
      res.json(toOperatorView(record))
    })
  }

  // The built widget and the demo page, when present.
  app.use(express.static(path.join(ROOT, 'widget', 'dist')))
  app.use(express.static(path.join(ROOT, 'demo')))

  // Nothing below this point may answer with Express's HTML pages: they carry
  // stack traces and absolute paths.
  app.use((_req, res) => {
    apiError(res, 404, 'not_found', 'Not found.')
  })
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(error)
      return
    }
    // body-parser tags its failures with a `type`.
    const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined
    if (type === 'entity.parse.failed') {
      apiError(res, 400, 'invalid_body', 'The request body must be valid JSON.')
    } else if (type === 'entity.too.large') {
      apiError(res, 413, 'payload_too_large', 'The request body is too large.')
    } else {
      console.error('request failed:', error)
      apiError(res, 500, 'internal_error', 'Something went wrong. Please try again.')
    }
  })

  return app
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  let config: { provider: ModelProvider; llm: LLM; enabledTools: ToolName[]; operatorToken: string | undefined }
  try {
    config = {
      ...llmFromEnv(),
      enabledTools: parseEnabledTools(process.env.HELPDECK_TOOLS),
      operatorToken: parseOperatorToken(process.env.HELPDECK_OPERATOR_TOKEN),
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    console.error(`helpdeck: ${error.message}`)
    process.exit(1)
  }
  const { provider, llm, enabledTools, operatorToken } = config
  const docsDir = process.env.HELPDECK_DOCS || path.join(ROOT, 'docs')
  const deps = buildDeps({
    llm,
    index: BM25Index.fromMarkdownDir(docsDir),
    enabledTools,
    tracer: new Tracer(process.env.SPANLIGHT_URL),
    operatorToken,
  })
  const port = Number(process.env.PORT || 4319)
  createApp(deps).listen(port, () => {
    console.log(
      `helpdeck on http://127.0.0.1:${port} ` +
        `(provider: ${provider}, model: ${deps.llm.model}, passages: ${deps.index.passages.length}, ` +
        `tools: ${enabledTools.join(',') || 'none'}, ` +
        `operator api: ${operatorToken ? 'on' : 'off'}, ` +
        `spanlight: ${deps.tracer.enabled ? 'on' : 'off'})`,
    )
  })
}
