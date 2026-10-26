import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  AnthropicLLM,
  ConfigError,
  OpenAILLM,
  llmFromEnv,
  resolveProvider,
  type ChatMessage,
  type ToolDefinition,
} from '../server/llm.js'
import { MockLLM } from '../server/mock-llm.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const lookupOrder: ToolDefinition = {
  name: 'lookup_order',
  description: 'Look up an order by id and the email on it.',
  inputSchema: {
    type: 'object',
    properties: { order_id: { type: 'string' }, email: { type: 'string' } },
    required: ['order_id', 'email'],
  },
}

interface Recorded {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

interface FakeOptions {
  status?: number
  /** Bytes per read; small values split frames, JSON, and UTF-8 across reads. */
  chunkSize?: number
  /** Leave the connection open after the last frame, like a live stream. */
  keepOpen?: boolean
  onCancel?: () => void
}

/** A fetch that records the request and replies with the given SSE frames,
 *  cut into small chunks so frames and JSON split across reads, as they do on
 *  a real connection. */
function fakeProvider(frames: string[], options: FakeOptions = {}) {
  const { status = 200, chunkSize = 11, keepOpen = false, onCancel } = options
  const calls: Recorded[] = []
  const fetchFn = (async (url: unknown, init?: { headers?: unknown; body?: unknown }) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    })
    const bytes = new TextEncoder().encode(frames.join(''))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize))
        if (!keepOpen) controller.close()
      },
      cancel() {
        onCancel?.()
      },
    })
    return new Response(stream, { status })
  }) as typeof fetch
  return { fetchFn, calls }
}

const anthropicFrame = (event: object) =>
  `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`
const openaiFrame = (chunk: object | '[DONE]') =>
  `data: ${chunk === '[DONE]' ? chunk : JSON.stringify(chunk)}\n\n`

const toolTurn: ChatMessage[] = [
  { role: 'system', content: 'You are support.' },
  { role: 'system', content: 'Second system block.' },
  { role: 'user', content: 'Where is HD-1042? ada@example.com' },
  {
    role: 'assistant',
    content: 'Let me check.',
    toolCalls: [
      { id: 'call_a', name: 'lookup_order', arguments: { order_id: 'HD-1042', email: 'ada@example.com' } },
      { id: 'call_b', name: 'lookup_order', arguments: { order_id: 'HD-1043', email: 'ada@example.com' } },
    ],
  },
  { role: 'tool', toolCallId: 'call_a', name: 'lookup_order', content: '{"status":"shipped"}' },
  { role: 'tool', toolCallId: 'call_b', name: 'lookup_order', content: '{"status":"delivered"}' },
  { role: 'user', content: 'Thanks' },
]

// The shape of Anthropic's documented streaming tool_use example: a text block
// at index 0, a tool_use block at index 1 whose input arrives as partial JSON
// starting with an empty fragment, then message_delta with stop_reason tool_use.
const anthropicToolStream = [
  anthropicFrame({
    type: 'message_start',
    message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 472, output_tokens: 2 } },
  }),
  anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  anthropicFrame({ type: 'ping' }),
  anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } }),
  anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } }),
  anthropicFrame({ type: 'content_block_stop', index: 0 }),
  anthropicFrame({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_01', name: 'lookup_order', input: {} },
  }),
  anthropicFrame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '' } }),
  anthropicFrame({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"order_id": "HD-' },
  }),
  anthropicFrame({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '1042", "email": "ada@exa' },
  }),
  anthropicFrame({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: 'mple.com"}' },
  }),
  anthropicFrame({ type: 'content_block_stop', index: 1 }),
  anthropicFrame({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 89 },
  }),
  anthropicFrame({ type: 'message_stop' }),
]

describe('AnthropicLLM', () => {
  it('maps tools and tool turns onto the Messages request', async () => {
    const { fetchFn, calls } = fakeProvider(anthropicToolStream)
    const llm = new AnthropicLLM('test-key', { model: 'claude-haiku-4-5', fetchFn })
    await llm.complete(toolTurn, { tools: [lookupOrder] })

    const [call] = calls
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(call?.headers['x-api-key']).toBe('test-key')
    expect(call?.body).toMatchObject({
      model: 'claude-haiku-4-5',
      stream: true,
      system: 'You are support.\n\nSecond system block.',
      tools: [
        { name: 'lookup_order', description: lookupOrder.description, input_schema: lookupOrder.inputSchema },
      ],
    })
    expect(call?.body.messages).toEqual([
      { role: 'user', content: 'Where is HD-1042? ada@example.com' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'call_a', name: 'lookup_order', input: { order_id: 'HD-1042', email: 'ada@example.com' } },
          { type: 'tool_use', id: 'call_b', name: 'lookup_order', input: { order_id: 'HD-1043', email: 'ada@example.com' } },
        ],
      },
      // Both results share one user message, as the API requires.
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_a', content: '{"status":"shipped"}' },
          { type: 'tool_result', tool_use_id: 'call_b', content: '{"status":"delivered"}' },
        ],
      },
      { role: 'user', content: 'Thanks' },
    ])
  })

  it('omits tools when none are offered', async () => {
    const { fetchFn, calls } = fakeProvider(anthropicToolStream)
    await new AnthropicLLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }])
    expect(calls[0]?.body).not.toHaveProperty('tools')
  })

  it('sends an object input for a tool call whose arguments were malformed', async () => {
    const { fetchFn, calls } = fakeProvider(anthropicToolStream)
    await new AnthropicLLM('k', { model: 'm', fetchFn }).complete([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'lookup_order', arguments: '{"order_id": ' }] },
      { role: 'tool', toolCallId: 't1', name: 'lookup_order', content: 'invalid arguments' },
    ])
    expect((calls[0]?.body.messages as { content: unknown }[])[1]?.content).toEqual([
      { type: 'tool_use', id: 't1', name: 'lookup_order', input: {} },
    ])
  })

  it('parses text, one tool call, usage, and stop_reason tool_use from the stream', async () => {
    const { fetchFn } = fakeProvider(anthropicToolStream)
    const tokens: string[] = []
    const completion = await new AnthropicLLM('k', { model: 'claude-haiku-4-5', fetchFn }).complete(
      [{ role: 'user', content: 'hi' }],
      { tools: [lookupOrder], onToken: (t) => tokens.push(t) },
    )
    expect(tokens).toEqual(['Let me ', 'check.'])
    expect(completion).toEqual({
      text: 'Let me check.',
      toolCalls: [
        { id: 'toolu_01', name: 'lookup_order', arguments: { order_id: 'HD-1042', email: 'ada@example.com' } },
      ],
      finishReason: 'tool_calls',
      model: 'claude-haiku-4-5',
      inputTokens: 472,
      outputTokens: 89,
    })
  })

  it('keeps parallel tool calls apart by block index, in order', async () => {
    const block = (index: number, id: string, json: string) => [
      anthropicFrame({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'lookup_order', input: {} } }),
      anthropicFrame({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } }),
      anthropicFrame({ type: 'content_block_stop', index }),
    ]
    const { fetchFn } = fakeProvider([
      anthropicFrame({ type: 'message_start', message: { usage: { input_tokens: 5 } } }),
      ...block(0, 'toolu_a', '{"order_id":"HD-1041"}'),
      ...block(1, 'toolu_b', '{"order_id":"HD-1042"}'),
      anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
      anthropicFrame({ type: 'message_stop' }),
    ])
    const { toolCalls } = await new AnthropicLLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }])
    expect(toolCalls.map((c) => [c.id, c.arguments])).toEqual([
      ['toolu_a', { order_id: 'HD-1041' }],
      ['toolu_b', { order_id: 'HD-1042' }],
    ])
  })

  it('treats a tool with no arguments as an empty object', async () => {
    const { fetchFn } = fakeProvider([
      anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'handoff', input: {} } }),
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '' } }),
      anthropicFrame({ type: 'content_block_stop', index: 0 }),
      anthropicFrame({ type: 'message_stop' }),
    ])
    const { toolCalls } = await new AnthropicLLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }])
    expect(toolCalls).toEqual([{ id: 'toolu_a', name: 'handoff', arguments: {} }])
  })

  it('surfaces malformed tool JSON as the raw string instead of throwing', async () => {
    const { fetchFn } = fakeProvider([
      anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'lookup_order', input: {} } }),
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"order_id": HD-1042,' } }),
      anthropicFrame({ type: 'content_block_stop', index: 0 }),
      anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }),
      anthropicFrame({ type: 'message_stop' }),
    ])
    const completion = await new AnthropicLLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }])
    expect(completion.toolCalls).toEqual([
      { id: 'toolu_a', name: 'lookup_order', arguments: '{"order_id": HD-1042,' },
    ])
  })

  it('keeps a tool call cut off by max_tokens and reports the truncation', async () => {
    // The model stops mid-JSON: the block is still closed and the message
    // still ends cleanly, with stop_reason max_tokens.
    const { fetchFn } = fakeProvider([
      anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'lookup_order', input: {} } }),
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"order_id": "HD-10' } }),
      anthropicFrame({ type: 'content_block_stop', index: 0 }),
      anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1024 } }),
      anthropicFrame({ type: 'message_stop' }),
    ])
    const completion = await new AnthropicLLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }])
    expect(completion.finishReason).toBe('length')
    expect(completion.toolCalls).toEqual([
      { id: 'toolu_a', name: 'lookup_order', arguments: '{"order_id": "HD-10' },
    ])
  })

  it('reads a non-ASCII answer split across single-byte reads', async () => {
    const { fetchFn } = fakeProvider(
      [
        anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Caf\u00e9 \u2615 \u{1F600}' } }),
        anthropicFrame({ type: 'content_block_stop', index: 0 }),
        anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
        anthropicFrame({ type: 'message_stop' }),
      ],
      { chunkSize: 1 },
    )
    const { text, finishReason } = await new AnthropicLLM('k', { model: 'm', fetchFn }).complete([
      { role: 'user', content: 'hi' },
    ])
    expect(text).toBe('Caf\u00e9 \u2615 \u{1F600}')
    expect(finishReason).toBe('stop')
  })

  it('reads CRLF line endings and data lines without a space after the colon', async () => {
    const frames = [
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
      anthropicFrame({ type: 'message_stop' }),
    ].map((frame) => frame.replaceAll('data: ', 'data:').replaceAll('\n', '\r\n'))
    const { fetchFn } = fakeProvider(frames)
    const { text } = await new AnthropicLLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }])
    expect(text).toBe('ok')
  })

  it('does not drop a final event that has no trailing newline', async () => {
    const { fetchFn } = fakeProvider([
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
    ])
    const { text } = await new AnthropicLLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }])
    expect(text).toBe('ok')
  })

  it('throws on a mid-stream error event instead of returning a truncated answer', async () => {
    const tokens: string[] = []
    const { fetchFn } = fakeProvider([
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial ' } }),
      anthropicFrame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ])
    await expect(
      new AnthropicLLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }], {
        onToken: (t) => tokens.push(t),
      }),
    ).rejects.toThrow('anthropic: overloaded_error: Overloaded')
    expect(tokens).toEqual(['Partial '])
  })

  it('throws when the connection closes before message_stop', async () => {
    const { fetchFn } = fakeProvider([
      anthropicFrame({ type: 'message_start', message: { usage: { input_tokens: 5 } } }),
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Cut ' } }),
    ])
    await expect(
      new AnthropicLLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('anthropic: stream ended before message_stop')
  })

  it('releases the connection when the stream throws', async () => {
    let cancelled = false
    const { fetchFn } = fakeProvider(
      [anthropicFrame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })],
      { keepOpen: true, onCancel: () => (cancelled = true) },
    )
    await expect(
      new AnthropicLLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('overloaded_error')
    expect(cancelled).toBe(true)
  })

  it('skips empty assistant turns and empty text blocks, which the API rejects', async () => {
    const { fetchFn, calls } = fakeProvider(anthropicToolStream)
    await new AnthropicLLM('k', { model: 'm', fetchFn }).complete([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: '  \n' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: ' ', toolCalls: [{ id: 'c1', name: 'lookup_order', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', name: 'lookup_order', content: 'ok' },
    ])
    expect(calls[0]?.body.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'lookup_order', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
    ])
  })

  it('throws with the status on an HTTP error', async () => {
    const { fetchFn } = fakeProvider(['{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'], {
      status: 529,
    })
    await expect(
      new AnthropicLLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('anthropic: HTTP 529 overloaded_error')
  })
})

// Chat Completions streaming: the first tool-call chunk carries the id, type,
// and name with empty arguments; later chunks carry only `index` and an
// arguments fragment; the usage chunk arrives last with an empty choices list.
const openaiToolStream = [
  openaiFrame({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }], usage: null }),
  openaiFrame({ choices: [{ index: 0, delta: { content: 'Let me ' }, finish_reason: null }], usage: null }),
  openaiFrame({ choices: [{ index: 0, delta: { content: 'check.' }, finish_reason: null }], usage: null }),
  openaiFrame({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_a', type: 'function', function: { name: 'lookup_order', arguments: '' } },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  }),
  openaiFrame({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"order_id":' } }] }, finish_reason: null }],
    usage: null,
  }),
  // A second, parallel call starts while the first is still streaming.
  openaiFrame({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 1, id: 'call_b', type: 'function', function: { name: 'lookup_order', arguments: '' } },
            { index: 0, function: { arguments: ' "HD-1042", "email": "ada@' } },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  }),
  openaiFrame({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: 'example.com"}' } },
            { index: 1, function: { arguments: '{"order_id":"HD-1043"}' } },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  }),
  openaiFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: null }),
  openaiFrame({ choices: [], usage: { prompt_tokens: 310, completion_tokens: 42, total_tokens: 352 } }),
  openaiFrame('[DONE]'),
]

describe('OpenAILLM', () => {
  it('maps tools and tool turns onto the Chat Completions request', async () => {
    const { fetchFn, calls } = fakeProvider(openaiToolStream)
    const llm = new OpenAILLM('test-key', { model: 'gpt-5.6-luna', fetchFn })
    await llm.complete(toolTurn, { tools: [lookupOrder] })

    const [call] = calls
    expect(call?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(call?.headers.authorization).toBe('Bearer test-key')
    expect(call?.body).toMatchObject({
      model: 'gpt-5.6-luna',
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup_order',
            description: lookupOrder.description,
            parameters: lookupOrder.inputSchema,
          },
        },
      ],
    })
    expect(call?.body.messages).toEqual([
      { role: 'system', content: 'You are support.' },
      { role: 'system', content: 'Second system block.' },
      { role: 'user', content: 'Where is HD-1042? ada@example.com' },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'lookup_order', arguments: '{"order_id":"HD-1042","email":"ada@example.com"}' },
          },
          {
            id: 'call_b',
            type: 'function',
            function: { name: 'lookup_order', arguments: '{"order_id":"HD-1043","email":"ada@example.com"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: '{"status":"shipped"}' },
      { role: 'tool', tool_call_id: 'call_b', content: '{"status":"delivered"}' },
      { role: 'user', content: 'Thanks' },
    ])
  })

  it('sends null content for an assistant turn that only called tools', async () => {
    const { fetchFn, calls } = fakeProvider(openaiToolStream)
    await new OpenAILLM('k', { model: 'm', fetchFn }).complete([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'lookup_order', arguments: '{"order_id": ' }] },
    ])
    expect((calls[0]?.body.messages as { content: unknown }[])[1]).toMatchObject({
      content: null,
      // Malformed arguments go back exactly as received.
      tool_calls: [{ function: { arguments: '{"order_id": ' } }],
    })
  })

  it('omits tools when none are offered', async () => {
    const { fetchFn, calls } = fakeProvider(openaiToolStream)
    await new OpenAILLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }])
    expect(calls[0]?.body).not.toHaveProperty('tools')
  })

  it('accumulates text, parallel tool calls by index, and usage from the stream', async () => {
    const { fetchFn } = fakeProvider(openaiToolStream)
    const tokens: string[] = []
    const completion = await new OpenAILLM('k', { model: 'gpt-5.6-luna', fetchFn }).complete(
      [{ role: 'user', content: 'hi' }],
      { tools: [lookupOrder], onToken: (t) => tokens.push(t) },
    )
    expect(tokens).toEqual(['Let me ', 'check.'])
    expect(completion).toEqual({
      text: 'Let me check.',
      toolCalls: [
        { id: 'call_a', name: 'lookup_order', arguments: { order_id: 'HD-1042', email: 'ada@example.com' } },
        { id: 'call_b', name: 'lookup_order', arguments: { order_id: 'HD-1043' } },
      ],
      finishReason: 'tool_calls',
      model: 'gpt-5.6-luna',
      inputTokens: 310,
      outputTokens: 42,
    })
  })

  it('surfaces malformed tool JSON as the raw string instead of throwing', async () => {
    const { fetchFn } = fakeProvider([
      openaiFrame({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id": HD' } }] },
            finish_reason: null,
          },
        ],
      }),
      openaiFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
      openaiFrame('[DONE]'),
    ])
    const completion = await new OpenAILLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }])
    expect(completion.finishReason).toBe('length')
    expect(completion.toolCalls).toEqual([
      { id: 'call_a', name: 'lookup_order', arguments: '{"order_id": HD' },
    ])
  })

  it('reads a CRLF stream, including a CRLF [DONE]', async () => {
    const frames = [
      openaiFrame({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }),
      openaiFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      openaiFrame('[DONE]'),
    ].map((frame) => frame.replaceAll('\n', '\r\n'))
    const { fetchFn } = fakeProvider(frames)
    const completion = await new OpenAILLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }])
    expect(completion).toMatchObject({ text: 'ok', finishReason: 'stop' })
  })

  it('throws on a mid-stream error chunk instead of returning a truncated answer', async () => {
    const { fetchFn } = fakeProvider([
      openaiFrame({ choices: [{ index: 0, delta: { content: 'Partial ' }, finish_reason: null }] }),
      openaiFrame({ error: { type: 'server_error', code: null, message: 'The server had an error' } }),
    ])
    await expect(
      new OpenAILLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('openai: server_error: The server had an error')
  })

  it('throws when the connection closes before [DONE]', async () => {
    const { fetchFn } = fakeProvider([
      openaiFrame({ choices: [{ index: 0, delta: { content: 'Cut ' }, finish_reason: null }] }),
    ])
    await expect(
      new OpenAILLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('openai: stream ended before [DONE]')
  })

  it('releases the connection after [DONE] and when the stream throws', async () => {
    let cancels = 0
    const onCancel = () => cancels++
    const done = fakeProvider(
      [openaiFrame({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }), openaiFrame('[DONE]')],
      { keepOpen: true, onCancel },
    )
    await new OpenAILLM('k', { model: 'm', fetchFn: done.fetchFn }).complete([{ role: 'user', content: 'hi' }])
    expect(cancels).toBe(1)
    const failed = fakeProvider([openaiFrame({ error: { type: 'server_error', message: 'boom' } })], {
      keepOpen: true,
      onCancel,
    })
    await expect(
      new OpenAILLM('k', { model: 'm', fetchFn: failed.fetchFn }).complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('server_error')
    expect(cancels).toBe(2)
  })

  it('keeps the key echoed in a 401 body out of the error', async () => {
    const body = JSON.stringify({
      error: {
        message: 'Incorrect API key provided: sk-proj-********abcd.',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    })
    const { fetchFn } = fakeProvider([body], { status: 401 })
    await expect(
      new OpenAILLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toMatchObject({ message: 'openai: HTTP 401 invalid_request_error invalid_api_key' })
  })

  it('reports only the status when the error body is not JSON', async () => {
    const { fetchFn } = fakeProvider(['<html>sk-live-secret</html>'], { status: 502 })
    await expect(
      new OpenAILLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toMatchObject({ message: 'openai: HTTP 502' })
  })

  it('throws with the status on an HTTP error', async () => {
    const { fetchFn } = fakeProvider(['{"error":{"type":"requests","code":"rate_limit_exceeded","message":"Slow down"}}'], {
      status: 429,
    })
    await expect(
      new OpenAILLM('k', { model: 'm', fetchFn }).complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('openai: HTTP 429 requests rate_limit_exceeded')
  })
})

describe('MockLLM', () => {
  const withContext = (passage: string): ChatMessage[] => [
    { role: 'system', content: `Context:\n[1] setup.md - Install\n${passage}\n\n---` },
    { role: 'user', content: 'How do I install it?' },
  ]

  it('cites the passage it answers from and makes no tool calls', async () => {
    const tokens: string[] = []
    const completion = await new MockLLM({ tokenDelayMs: 0 }).complete(withContext('Run npm install.'), {
      tools: [lookupOrder],
      onToken: (t) => tokens.push(t),
    })
    expect(completion.text).toBe('Here is what the documentation says [1]:\n\nRun npm install.')
    expect(tokens.join('')).toBe(completion.text)
    expect(completion).toMatchObject({ toolCalls: [], finishReason: 'stop', model: 'mock-1' })
  })

  it('declines without a citation marker when nothing was retrieved', async () => {
    const { text } = await new MockLLM({ tokenDelayMs: 0 }).complete([
      { role: 'system', content: 'Context: (nothing relevant found)' },
      { role: 'user', content: 'quantum lasagna' },
    ])
    expect(text).toContain('could not find that')
    expect(text).not.toContain('[1]')
  })
})

describe('provider selection', () => {
  const failing = (env: NodeJS.ProcessEnv, message: RegExp) => {
    expect(() => resolveProvider(env)).toThrow(ConfigError)
    expect(() => resolveProvider(env)).toThrow(message)
  }

  it.each([
    ['nothing set', {}, 'mock'],
    ['an Anthropic key', { ANTHROPIC_API_KEY: 'a' }, 'anthropic'],
    ['an OpenAI key', { OPENAI_API_KEY: 'o' }, 'openai'],
    ['both keys (Anthropic wins)', { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, 'anthropic'],
    ['empty keys', { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' }, 'mock'],
    ['explicit anthropic with its key', { MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' }, 'anthropic'],
    ['explicit openai beside both keys', { MODEL_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, 'openai'],
    ['explicit mock with nothing else', { MODEL_PROVIDER: 'mock' }, 'mock'],
    ['explicit mock with empty values', { MODEL_PROVIDER: 'mock', ANTHROPIC_API_KEY: '', HELPDECK_MODEL: '' }, 'mock'],
    ['a padded, upper-case value', { MODEL_PROVIDER: ' MOCK ' }, 'mock'],
    ['an empty MODEL_PROVIDER', { MODEL_PROVIDER: '', OPENAI_API_KEY: 'o' }, 'openai'],
  ])('resolves %s', (_label, env, expected) => {
    expect(resolveProvider(env)).toBe(expected)
  })

  it('requires the key of an explicit provider', () => {
    failing({ MODEL_PROVIDER: 'anthropic' }, /requires ANTHROPIC_API_KEY/)
    failing({ MODEL_PROVIDER: 'anthropic', OPENAI_API_KEY: 'o' }, /requires ANTHROPIC_API_KEY/)
    failing({ MODEL_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'a' }, /requires OPENAI_API_KEY/)
  })

  it('refuses the mock beside a key or HELPDECK_MODEL, naming each variable', () => {
    failing({ MODEL_PROVIDER: 'mock', ANTHROPIC_API_KEY: 'a' }, /refuses to start while ANTHROPIC_API_KEY is set/)
    failing({ MODEL_PROVIDER: 'mock', OPENAI_API_KEY: 'o' }, /OPENAI_API_KEY/)
    failing({ MODEL_PROVIDER: 'mock', HELPDECK_MODEL: 'claude-haiku-4-5' }, /HELPDECK_MODEL/)
    failing(
      { MODEL_PROVIDER: 'mock', ANTHROPIC_API_KEY: 'a', HELPDECK_MODEL: 'm' },
      /ANTHROPIC_API_KEY, HELPDECK_MODEL/,
    )
    failing({ MODEL_PROVIDER: 'mock', OPENAI_API_KEY: 'o' }, /without --env-file/)
  })

  it('rejects an unknown provider and lists the valid ones', () => {
    failing({ MODEL_PROVIDER: 'gemini' }, /anthropic, openai, mock \(got "gemini"\)/)
  })

  it('builds the matching model, honouring HELPDECK_MODEL', () => {
    expect(llmFromEnv({}).provider).toBe('mock')
    expect(llmFromEnv({}).llm).toBeInstanceOf(MockLLM)
    const claude = llmFromEnv({ ANTHROPIC_API_KEY: 'a', HELPDECK_MODEL: 'claude-sonnet-5' })
    expect(claude.provider).toBe('anthropic')
    expect(claude.llm).toBeInstanceOf(AnthropicLLM)
    expect(claude.llm.model).toBe('claude-sonnet-5')
    expect(llmFromEnv({ ANTHROPIC_API_KEY: 'a' }).llm.model).toBe('claude-haiku-4-5')
    const gpt = llmFromEnv({ MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'o' })
    expect(gpt.provider).toBe('openai')
    expect(gpt.llm.model).toBe('gpt-5.6-luna')
    expect(() => llmFromEnv({ MODEL_PROVIDER: 'mock', OPENAI_API_KEY: 'o' })).toThrow(ConfigError)
  })
})

describe('server startup', () => {
  // End to end: the real entry point, with a dummy value that the guard must
  // reject before any model is built, so nothing can reach a provider.
  it('prints the config error and exits 1 when the mock is guarded', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(ROOT, 'server', 'index.ts')],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          MODEL_PROVIDER: 'mock',
          ANTHROPIC_API_KEY: 'dummy-not-a-real-key',
        },
      },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('MODEL_PROVIDER=mock refuses to start while ANTHROPIC_API_KEY is set')
    expect(result.stderr).not.toContain('dummy-not-a-real-key')
  })
})
