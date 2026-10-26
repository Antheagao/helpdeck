/**
 * Wiring: one place that builds the stores and limiters a running app needs.
 * The server main, the tests, the evals, and the recorder all start from here,
 * so they cannot drift apart.
 */

import { ActionStore } from './actions.js'
import { SeededOrderBackend, TicketStore, type OrderBackend } from './backend.js'
import { makeSessionStore, type ChatDeps } from './chat.js'
import type { LLM } from './llm.js'
import { FixedWindowLimiter, type RateLimit } from './rate-limit.js'
import { BM25Index } from './retrieval.js'
import { DEFAULT_TOOLS, type ToolName } from './tools.js'
import { Tracer } from './trace.js'

/** Per client address, per window (see rate-limit.ts). */
export const DEFAULT_LIMITS = {
  chat: { max: 60, windowMs: 10 * 60 * 1000 },
  actions: { max: 20, windowMs: 10 * 60 * 1000 },
} satisfies Record<string, RateLimit>

/** What the HTTP app needs: the chat pipeline's deps plus everything only the
 *  routes touch. `actions` here is the full store, with confirm. */
export interface AppDeps extends ChatDeps {
  actions: ActionStore
  tickets: TicketStore
  limiters: { chat: FixedWindowLimiter; actions: FixedWindowLimiter }
}

export type BuildDepsOptions = {
  llm: LLM
  enabledTools?: readonly ToolName[]
  tracer?: Tracer
  orders?: OrderBackend
  productName?: string
  limits?: Partial<typeof DEFAULT_LIMITS>
  /** Clock for action expiry and rate limits; tests inject one. */
  now?: () => number
} & ({ index: BM25Index; docsDir?: never } | { docsDir: string; index?: never })

/** Fresh stores around the given model and knowledge base. */
export function buildDeps(options: BuildDepsOptions): AppDeps {
  const { llm, now } = options
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  return {
    llm,
    index: options.index ?? BM25Index.fromMarkdownDir(options.docsDir),
    tracer: options.tracer ?? new Tracer(undefined),
    sessions: makeSessionStore(llm),
    orders: options.orders ?? new SeededOrderBackend(),
    enabledTools: options.enabledTools ?? DEFAULT_TOOLS,
    actions: new ActionStore({ now }),
    tickets: new TicketStore(now ? () => new Date(now()) : undefined),
    limiters: {
      chat: new FixedWindowLimiter(limits.chat, now),
      actions: new FixedWindowLimiter(limits.actions, now),
    },
    productName: options.productName,
  }
}
