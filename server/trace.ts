/**
 * Optional spanlight export (github.com/Antheagao/spanlight): when
 * SPANLIGHT_URL is set, every chat request becomes a trace with retrieval
 * and LLM spans. Fire-and-forget - observability must never break the chat.
 */

import { randomUUID } from 'node:crypto'

// USD per million tokens for the models this service actually runs.
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-4-5': [1.0, 5.0],
  'claude-sonnet-5': [2.0, 10.0],
  'gpt-5.6-terra': [2.0, 12.0],
  'gpt-5.6-luna': [0.2, 1.2],
}

function cost(model: string, inputTokens: number, outputTokens: number): number | null {
  const entry = Object.entries(PRICES).find(([k]) => model.startsWith(k))?.[1]
  if (!entry) return null
  return (inputTokens * entry[0] + outputTokens * entry[1]) / 1e6
}

interface SpanRecord {
  id: string
  trace_id: string
  parent_id: string | null
  name: string
  kind: 'llm' | 'retrieval' | 'tool' | 'other'
  started_at: number
  ended_at: number | null
  status: 'ok' | 'error'
  error: string | null
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  input: string | null
  output: string | null
  attributes: Record<string, unknown>
}

export class TraceHandle {
  readonly id = randomUUID().replaceAll('-', '')
  readonly startedAt = Date.now() / 1000
  status: 'ok' | 'error' = 'ok'
  private readonly spans: SpanRecord[] = []

  constructor(
    readonly name: string,
    private readonly metadata: Record<string, unknown>,
    private readonly session: string | null,
  ) {}

  async span<T>(
    name: string,
    kind: SpanRecord['kind'],
    fn: () => Promise<T>,
    enrich?: (record: SpanRecord, result: T) => void,
  ): Promise<T> {
    const record: SpanRecord = {
      id: randomUUID().replaceAll('-', ''),
      trace_id: this.id,
      parent_id: null,
      name,
      kind,
      started_at: Date.now() / 1000,
      ended_at: null,
      status: 'ok',
      error: null,
      model: null,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      input: null,
      output: null,
      attributes: {},
    }
    try {
      const result = await fn()
      enrich?.(record, result)
      return result
    } catch (error) {
      record.status = 'error'
      record.error = String(error)
      this.status = 'error'
      throw error
    } finally {
      record.ended_at = Date.now() / 1000
      this.spans.push(record)
    }
  }

  recordLlmUsage(record: SpanRecord, model: string, inputTokens: number, outputTokens: number): void {
    record.model = model
    record.input_tokens = inputTokens
    record.output_tokens = outputTokens
    record.cost_usd = cost(model, inputTokens, outputTokens)
  }

  payload(): { traces: object[]; spans: object[] } {
    return {
      traces: [
        {
          id: this.id,
          name: this.name,
          started_at: this.startedAt,
          ended_at: Date.now() / 1000,
          status: this.status,
          session: this.session,
          metadata: this.metadata,
        },
      ],
      spans: this.spans,
    }
  }
}

export class Tracer {
  private warned = false

  constructor(
    private readonly url: string | undefined,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return Boolean(this.url)
  }

  start(name: string, metadata: Record<string, unknown>, session: string | null): TraceHandle {
    return new TraceHandle(name, metadata, session)
  }

  /** Ship a finished trace; errors are swallowed (once, loudly). */
  async send(trace: TraceHandle): Promise<void> {
    if (!this.url) return
    try {
      await this.fetchFn(`${this.url.replace(/\/$/, '')}/api/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(trace.payload()),
      })
    } catch (error) {
      if (!this.warned) {
        this.warned = true
        console.warn(`helpdeck: spanlight unreachable at ${this.url} (${String(error)})`)
      }
    }
  }
}
