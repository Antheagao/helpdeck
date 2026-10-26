/**
 * LLM providers over plain fetch - no SDK dependencies. Streaming first:
 * every provider yields tokens through an onToken callback and returns the
 * full text, any tool calls the model made, and real usage numbers.
 *
 * Tool calls are provider-neutral here: callers pass ToolDefinitions and read
 * ToolCalls, and each provider maps them to its own wire format.
 *
 * The offline MockLLM lives in mock-llm.ts and keeps the whole product
 * runnable (and testable, and demoable) with zero keys.
 */

import { MockLLM } from './mock-llm.js'

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the arguments object. */
  inputSchema: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  /** The parsed JSON arguments. When the provider sent JSON that does not
   *  parse (truncated or malformed), this is the raw string instead, so the
   *  tool's own validation rejects it; the stream never throws on it. */
  arguments: unknown
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

/** Why the model stopped. `length` means the output was cut off, so a tool
 *  call in the same completion may be incomplete. */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other'

export interface Completion {
  text: string
  toolCalls: ToolCall[]
  finishReason: FinishReason
  model: string
  inputTokens: number
  outputTokens: number
}

export interface CompleteOptions {
  tools?: ToolDefinition[]
  onToken?: (token: string) => void
}

export interface LLM {
  readonly model: string
  /**
   * True for a model that needs no provider and cannot write prose: the
   * offline mock, and any stand-in built on it. Summaries (the rolling memory
   * summary, a handoff recap) then take the deterministic extractive path
   * instead of asking the model. A wrapper must forward this from the model it
   * wraps, or it will be asked for prose it cannot write.
   */
  readonly offline: boolean
  complete(messages: ChatMessage[], options?: CompleteOptions): Promise<Completion>
}

/** A startup configuration mistake, reported to the operator and fatal. */
export class ConfigError extends Error {}

/** The payload of one SSE line, or null for any other line. Tolerates CRLF
 *  endings and a missing space after the colon, both legal SSE. */
function dataOf(rawLine: string): string | null {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
  if (!line.startsWith('data:')) return null
  return line.slice(line.startsWith('data: ') ? 6 : 5)
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const data = dataOf(line)
        if (data !== null) yield data
      }
    }
    const last = dataOf(buffer + decoder.decode())
    if (last !== null) yield last
  } finally {
    // A throw or break in the consumer must not leave the socket open.
    await reader.cancel().catch(() => {})
  }
}

/** Build the error for a non-2xx provider response. Only the status and the
 *  error type and code are kept: the raw body can echo the API key (OpenAI's
 *  401 includes a partially redacted one) and must never reach a log. */
async function httpError(provider: string, response: Response): Promise<Error> {
  let detail = ''
  try {
    const parsed = (await response.json()) as { error?: { type?: unknown; code?: unknown } }
    const safe = (v: unknown) => (typeof v === 'string' && /^[\w.-]{1,64}$/.test(v) ? v : null)
    detail = [safe(parsed.error?.type), safe(parsed.error?.code)].filter(Boolean).join(' ')
  } catch {
    // Not JSON: the status alone is the diagnosis.
  }
  return new Error(`${provider}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`)
}

/** Parse the JSON a provider streamed for a tool call. An empty string is a
 *  tool with no arguments. Anything unparseable is kept raw. */
function parseToolArguments(raw: string): unknown {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicBlock[]
}

function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
      }
      // All results for one assistant turn must share a single user message.
      const last = out.at(-1)
      if (last?.role === 'user' && typeof last.content !== 'string') last.content.push(block)
      else out.push({ role: 'user', content: [block] })
    } else if (message.role === 'assistant' && message.toolCalls?.length) {
      // Anthropic rejects empty text blocks (and empty messages) with a 400.
      const blocks: AnthropicBlock[] = message.content.trim()
        ? [{ type: 'text', text: message.content }]
        : []
      for (const call of message.toolCalls) {
        // Anthropic requires `input` to be an object; malformed arguments
        // (kept as a raw string) are replaced, the tool result carries the error.
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: isRecord(call.arguments) ? call.arguments : {},
        })
      }
      out.push({ role: 'assistant', content: blocks })
    } else if (message.role === 'assistant' && !message.content.trim()) {
      continue
    } else {
      out.push({ role: message.role, content: message.content })
    }
  }
  return out
}

const ANTHROPIC_FINISH: Record<string, FinishReason> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
}

interface AnthropicEvent {
  type: string
  index?: number
  error?: { type?: string; message?: string }
  message?: { usage?: { input_tokens?: number } }
  usage?: { input_tokens?: number; output_tokens?: number }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null }
}

export interface AnthropicOptions {
  model?: string
  maxTokens?: number
  fetchFn?: typeof fetch
}

export class AnthropicLLM implements LLM {
  readonly offline = false
  readonly model: string
  private readonly maxTokens: number
  private readonly fetchFn: typeof fetch

  constructor(
    private readonly apiKey: string,
    { model = 'claude-haiku-4-5', maxTokens = 1024, fetchFn = fetch }: AnthropicOptions = {},
  ) {
    this.model = model
    this.maxTokens = maxTokens
    this.fetchFn = fetchFn
  }

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const { tools, onToken } = options
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const response = await this.fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        stream: true,
        ...(system ? { system } : {}),
        ...(tools?.length
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              })),
            }
          : {}),
        messages: toAnthropicMessages(messages),
      }),
    })
    if (!response.ok || !response.body) {
      throw await httpError('anthropic', response)
    }
    let text = ''
    let inputTokens = 0
    let outputTokens = 0
    let finishReason: FinishReason = 'other'
    let finished = false
    // A tool call streams as a content block; the block index keys its
    // argument fragments, and content_block_stop is what completes it.
    const openToolBlocks = new Map<number, { id: string; name: string; json: string }>()
    const toolCalls: ToolCall[] = []
    const closeToolBlock = (index: number) => {
      const block = openToolBlocks.get(index)
      if (!block) return
      openToolBlocks.delete(index)
      toolCalls.push({ id: block.id, name: block.name, arguments: parseToolArguments(block.json) })
    }
    for await (const data of sseData(response.body)) {
      const event = JSON.parse(data) as AnthropicEvent
      if (event.type === 'error') {
        // The API reports mid-stream failures (overloaded_error) as an event
        // inside a 200 response; treating it as a clean end would hand back a
        // truncated answer as if it were complete.
        throw new Error(`anthropic: ${event.error?.type ?? 'error'}: ${event.error?.message ?? 'unknown'}`)
      }
      if (event.type === 'message_start') {
        inputTokens = event.message?.usage?.input_tokens ?? 0
      } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        openToolBlocks.set(event.index ?? 0, {
          id: event.content_block.id ?? '',
          name: event.content_block.name ?? '',
          json: '',
        })
      } else if (event.type === 'content_block_delta' && event.delta?.text) {
        text += event.delta.text
        onToken?.(event.delta.text)
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        const block = openToolBlocks.get(event.index ?? 0)
        if (block) block.json += event.delta.partial_json ?? ''
      } else if (event.type === 'content_block_stop') {
        closeToolBlock(event.index ?? 0)
      } else if (event.type === 'message_delta') {
        // Usage on message_delta is cumulative, so it replaces earlier values.
        inputTokens = event.usage?.input_tokens ?? inputTokens
        outputTokens = event.usage?.output_tokens ?? outputTokens
        const stopReason = event.delta?.stop_reason
        if (stopReason) finishReason = ANTHROPIC_FINISH[stopReason] ?? 'other'
      } else if (event.type === 'message_stop') {
        finished = true
      }
    }
    if (!finished) throw new Error('anthropic: stream ended before message_stop')
    return { text, toolCalls, finishReason, model: this.model, inputTokens, outputTokens }
  }
}

type OpenAIMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  return messages.map((message): OpenAIMessage => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            // The wire field is a JSON string; raw malformed text goes back as received.
            arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
          },
        })),
      }
    }
    return { role: message.role, content: message.content }
  })
}

const OPENAI_FINISH: Record<string, FinishReason> = {
  stop: 'stop',
  tool_calls: 'tool_calls',
  length: 'length',
}

interface OpenAIChunk {
  error?: { type?: string; code?: string; message?: string }
  choices?: {
    delta?: {
      content?: string | null
      tool_calls?: {
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

export interface OpenAIOptions {
  model?: string
  fetchFn?: typeof fetch
}

export class OpenAILLM implements LLM {
  readonly offline = false
  readonly model: string
  private readonly fetchFn: typeof fetch

  constructor(
    private readonly apiKey: string,
    { model = 'gpt-5.6-luna', fetchFn = fetch }: OpenAIOptions = {},
  ) {
    this.model = model
    this.fetchFn = fetchFn
  }

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const { tools, onToken } = options
    const response = await this.fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools?.length
          ? {
              tools: tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
            }
          : {}),
        messages: toOpenAIMessages(messages),
      }),
    })
    if (!response.ok || !response.body) {
      throw await httpError('openai', response)
    }
    let text = ''
    let inputTokens = 0
    let outputTokens = 0
    let finishReason: FinishReason = 'other'
    let finished = false
    // Tool calls arrive as fragments keyed by `index`: the id and name come on
    // the first fragment only, and the arguments JSON is split across many.
    const pendingCalls = new Map<number, { id: string; name: string; json: string }>()
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') {
        finished = true
        break
      }
      const event = JSON.parse(data) as OpenAIChunk
      if (event.error) {
        throw new Error(
          `openai: ${event.error.type ?? event.error.code ?? 'error'}: ${event.error.message ?? 'unknown'}`,
        )
      }
      const choice = event.choices?.[0]
      const token = choice?.delta?.content
      if (token) {
        text += token
        onToken?.(token)
      }
      for (const part of choice?.delta?.tool_calls ?? []) {
        let call = pendingCalls.get(part.index)
        if (!call) {
          call = { id: '', name: '', json: '' }
          pendingCalls.set(part.index, call)
        }
        if (part.id) call.id = part.id
        if (part.function?.name) call.name = part.function.name
        call.json += part.function?.arguments ?? ''
      }
      if (choice?.finish_reason) finishReason = OPENAI_FINISH[choice.finish_reason] ?? 'other'
      if (event.usage) {
        inputTokens = event.usage.prompt_tokens ?? 0
        outputTokens = event.usage.completion_tokens ?? 0
      }
    }
    if (!finished) throw new Error('openai: stream ended before [DONE]')
    const toolCalls = [...pendingCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ id: call.id, name: call.name, arguments: parseToolArguments(call.json) }))
    return { text, toolCalls, finishReason, model: this.model, inputTokens, outputTokens }
  }
}

export type ModelProvider = 'anthropic' | 'openai' | 'mock'

const PROVIDERS: readonly ModelProvider[] = ['anthropic', 'openai', 'mock']

/** Where a provider's key lives. The mock has none, which is the point. */
const KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const

/**
 * Pick the provider from MODEL_PROVIDER. Unset keeps the older automatic
 * order (Anthropic key, then OpenAI key, then mock). An explicit value must
 * have its key, and `mock` refuses to start beside any key or HELPDECK_MODEL,
 * so a demo or recording started from a shell that has a key can never spend.
 *
 * @throws ConfigError on an unknown provider, a missing key, or a guarded mock.
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const raw = env.MODEL_PROVIDER?.trim().toLowerCase()
  if (!raw) {
    if (env.ANTHROPIC_API_KEY) return 'anthropic'
    if (env.OPENAI_API_KEY) return 'openai'
    return 'mock'
  }
  const provider = PROVIDERS.find((p) => p === raw)
  if (!provider) {
    throw new ConfigError(`MODEL_PROVIDER must be one of ${PROVIDERS.join(', ')} (got "${raw}")`)
  }
  if (provider === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    throw new ConfigError('MODEL_PROVIDER=anthropic requires ANTHROPIC_API_KEY')
  }
  if (provider === 'openai' && !env.OPENAI_API_KEY) {
    throw new ConfigError('MODEL_PROVIDER=openai requires OPENAI_API_KEY')
  }
  if (provider === 'mock') {
    const present = [...KEY_VARS, 'HELPDECK_MODEL' as const].filter((name) => env[name])
    if (present.length > 0) {
      throw new ConfigError(
        `MODEL_PROVIDER=mock refuses to start while ${present.join(', ')} ${present.length > 1 ? 'are' : 'is'} set, ` +
          'so the mock can never run next to a real key. ' +
          'Unset it, or start without --env-file.',
      )
    }
  }
  return provider
}

/** Build the model chosen by resolveProvider, and say which provider that was. */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): { provider: ModelProvider; llm: LLM } {
  const provider = resolveProvider(env)
  switch (provider) {
    case 'anthropic':
      return {
        provider,
        llm: new AnthropicLLM(env.ANTHROPIC_API_KEY ?? '', { model: env.HELPDECK_MODEL || undefined }),
      }
    case 'openai':
      return {
        provider,
        llm: new OpenAILLM(env.OPENAI_API_KEY ?? '', { model: env.HELPDECK_MODEL || undefined }),
      }
    case 'mock':
      return { provider, llm: new MockLLM() }
  }
}
