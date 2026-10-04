/**
 * LLM providers over plain fetch - no SDK dependencies. Streaming first:
 * every provider yields tokens through an onToken callback and returns the
 * full text plus real usage numbers.
 *
 * MockLLM keeps the whole product runnable (and testable, and demoable)
 * with zero keys: it answers from the retrieved context deterministically.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface Completion {
  text: string
  model: string
  inputTokens: number
  outputTokens: number
}

export interface LLM {
  readonly model: string
  complete(messages: ChatMessage[], onToken?: (token: string) => void): Promise<Completion>
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('data: ')) yield line.slice(6)
    }
  }
}

export class AnthropicLLM implements LLM {
  constructor(
    private readonly apiKey: string,
    readonly model = 'claude-haiku-4-5',
    private readonly maxTokens = 1024,
  ) {}

  async complete(messages: ChatMessage[], onToken?: (token: string) => void): Promise<Completion> {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
        messages: messages.filter((m) => m.role !== 'system'),
      }),
    })
    if (!response.ok || !response.body) {
      throw new Error(`anthropic: HTTP ${response.status} ${await response.text()}`)
    }
    let text = ''
    let inputTokens = 0
    let outputTokens = 0
    for await (const data of sseData(response.body)) {
      const event = JSON.parse(data) as {
        type: string
        message?: { usage?: { input_tokens?: number } }
        usage?: { output_tokens?: number }
        delta?: { type?: string; text?: string }
      }
      if (event.type === 'message_start') {
        inputTokens = event.message?.usage?.input_tokens ?? 0
      } else if (event.type === 'content_block_delta' && event.delta?.text) {
        text += event.delta.text
        onToken?.(event.delta.text)
      } else if (event.type === 'message_delta') {
        outputTokens = event.usage?.output_tokens ?? outputTokens
      }
    }
    return { text, model: this.model, inputTokens, outputTokens }
  }
}

export class OpenAILLM implements LLM {
  constructor(
    private readonly apiKey: string,
    readonly model = 'gpt-5.6-luna',
  ) {}

  async complete(messages: ChatMessage[], onToken?: (token: string) => void): Promise<Completion> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        stream_options: { include_usage: true },
        messages,
      }),
    })
    if (!response.ok || !response.body) {
      throw new Error(`openai: HTTP ${response.status} ${await response.text()}`)
    }
    let text = ''
    let inputTokens = 0
    let outputTokens = 0
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') break
      const event = JSON.parse(data) as {
        choices?: { delta?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null
      }
      const token = event.choices?.[0]?.delta?.content
      if (token) {
        text += token
        onToken?.(token)
      }
      if (event.usage) {
        inputTokens = event.usage.prompt_tokens ?? 0
        outputTokens = event.usage.completion_tokens ?? 0
      }
    }
    return { text, model: this.model, inputTokens, outputTokens }
  }
}

/** Deterministic offline model: answers with the top context passage. Keeps
 *  demos, tests, and CI fully keyless. */
export class MockLLM implements LLM {
  readonly model = 'mock-1'

  async complete(messages: ChatMessage[], onToken?: (token: string) => void): Promise<Completion> {
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    const contextMatch = /\[1\] [^\n]*\n([\s\S]*?)(?:\n\n\[2\]|\n\n---|$)/.exec(system)
    const answer = contextMatch?.[1]?.trim()
      ? `Here is what the documentation says:\n\n${contextMatch[1].trim().slice(0, 500)}`
      : 'I could not find that in the documentation, so I would rather not guess. ' +
        'Try asking about setup, memory, retrieval, or tracing.'
    for (const word of answer.split(/(?<= )/)) {
      onToken?.(word)
      await new Promise((r) => setTimeout(r, 1))
    }
    const inputTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4)
    return { text: answer, model: this.model, inputTokens, outputTokens: Math.ceil(answer.length / 4) }
  }
}

/** Provider selection: Anthropic, then OpenAI, then the offline mock. */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LLM {
  if (env.ANTHROPIC_API_KEY) return new AnthropicLLM(env.ANTHROPIC_API_KEY, env.HELPDECK_MODEL || 'claude-haiku-4-5')
  if (env.OPENAI_API_KEY) return new OpenAILLM(env.OPENAI_API_KEY, env.HELPDECK_MODEL || 'gpt-5.6-luna')
  return new MockLLM()
}
