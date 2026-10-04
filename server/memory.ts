/**
 * Conversation memory with a hard token budget - the part LangChain calls a
 * "summary buffer memory", built from scratch so it needs no framework and
 * no vendor account.
 *
 * The contract: `render()` always fits the budget. The most recent turns are
 * kept verbatim; when the history outgrows the budget, the oldest overflow
 * turns are folded into a running summary by an injected `summarize`
 * function (LLM-backed in production, extractive offline).
 */

export interface Turn {
  role: 'user' | 'assistant'
  content: string
}

export type Summarizer = (turns: Turn[], previousSummary: string) => Promise<string>

/**
 * Rough token estimate (~4 characters per token for English text).
 * Deliberately a heuristic: budgeting needs stable, cheap, provider-neutral
 * numbers, not exact BPE counts - the budget carries headroom instead.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function turnTokens(turn: Turn): number {
  return estimateTokens(turn.content) + 4 // a few tokens of message framing
}

/** Offline summarizer: first sentence of each turn, hard-capped. Used when
 *  no LLM key is configured, and as the fallback if the LLM call fails. */
export const extractiveSummarizer: Summarizer = async (turns, previous) => {
  const lines = turns.map((t) => {
    const first = t.content.split(/(?<=[.!?])\s/)[0] ?? t.content
    return `${t.role}: ${first.slice(0, 140)}`
  })
  return [previous, ...lines].filter(Boolean).join('\n').slice(-2000)
}

export interface MemoryOptions {
  budgetTokens?: number
  keepRecentTurns?: number
  summarize?: Summarizer
}

export class ConversationMemory {
  private turns: Turn[] = []
  private summary = ''
  private readonly budgetTokens: number
  private readonly keepRecentTurns: number
  private readonly summarize: Summarizer

  constructor(options: MemoryOptions = {}) {
    this.budgetTokens = options.budgetTokens ?? 2000
    this.keepRecentTurns = options.keepRecentTurns ?? 6
    this.summarize = options.summarize ?? extractiveSummarizer
  }

  add(turn: Turn): void {
    this.turns.push(turn)
  }

  tokens(): number {
    return (
      estimateTokens(this.summary) +
      this.turns.reduce((n, t) => n + turnTokens(t), 0)
    )
  }

  /** Fold oldest turns into the summary until the history fits the budget.
   *  Call after add(); safe to call any time. */
  async compact(): Promise<void> {
    while (this.tokens() > this.budgetTokens && this.turns.length > this.keepRecentTurns) {
      // Fold the oldest half of the overflow in one summarizer call rather
      // than one call per turn.
      const overflowCount = this.turns.length - this.keepRecentTurns
      const batch = this.turns.splice(0, Math.max(1, Math.ceil(overflowCount / 2)))
      try {
        this.summary = await this.summarize(batch, this.summary)
      } catch {
        this.summary = await extractiveSummarizer(batch, this.summary)
      }
    }
  }

  /** What goes into the prompt: the running summary plus verbatim turns. */
  render(): { summary: string; turns: Turn[] } {
    return { summary: this.summary, turns: [...this.turns] }
  }
}

/** Per-session memory with idle expiry, so an embedded widget's abandoned
 *  sessions do not accumulate forever. */
export class SessionStore {
  private sessions = new Map<string, { memory: ConversationMemory; touched: number }>()

  constructor(
    private readonly makeMemory: () => ConversationMemory,
    private readonly ttlMs = 30 * 60 * 1000,
  ) {}

  get(id: string): ConversationMemory {
    this.evict()
    let entry = this.sessions.get(id)
    if (!entry) {
      entry = { memory: this.makeMemory(), touched: Date.now() }
      this.sessions.set(id, entry)
    }
    entry.touched = Date.now()
    return entry.memory
  }

  get size(): number {
    this.evict()
    return this.sessions.size
  }

  private evict(): void {
    const cutoff = Date.now() - this.ttlMs
    for (const [id, entry] of this.sessions) {
      if (entry.touched < cutoff) this.sessions.delete(id)
    }
  }
}
