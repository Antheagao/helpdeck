/**
 * The tools the model may call, with a fixed access level per tool.
 *
 * `access` is part of the type, not configuration: a read tool runs inside
 * the chat loop, a write tool can only be proposed there and runs from the
 * confirm route. HELPDECK_TOOLS only chooses which tools are offered; no
 * setting can turn a write into a read.
 *
 * Arguments from the model are untrusted. Each tool's `parse` is the single
 * place they are validated, and everything after it works with typed values.
 */

import type { OrderBackend } from './backend.js'
import { ConfigError, type ToolDefinition } from './llm.js'
import type { ReadToolName, ToolName, WriteToolName } from './protocol.js'

export type { ReadToolName, ToolName, WriteToolName }

/** Validated arguments per tool. Names match the model-facing schema. */
export interface ToolArgs {
  lookup_order: { order_id: string; email: string }
  create_ticket: { subject: string; description: string }
  handoff_to_human: { reason: string }
}

export type ParseResult<A> = { ok: true; args: A } | { ok: false; error: string }

export interface ToolSpec<A, Access extends 'read' | 'write'> {
  access: Access
  description: string
  inputSchema: Record<string, unknown>
  /** Accepts the arguments as the provider delivered them: an object, or a
   *  JSON string (including the raw string kept for malformed JSON). */
  parse(raw: unknown): ParseResult<A>
}

/** A missing entry, or a read/write mismatch with the name lists above,
 *  fails tsc. */
export type ToolTable = {
  [K in ToolName]: ToolSpec<ToolArgs[K], K extends ReadToolName ? 'read' : 'write'>
}

const ORDER_ID = /^HD-\d{4}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const LIMITS = {
  emailMax: 254,
  subject: { min: 3, max: 120 },
  description: { min: 1, max: 2000 },
  reason: { min: 1, max: 300 },
} as const

/** Characters as a person counts them, not UTF-16 units. */
const charLength = (text: string) => [...text].length

type Fields = Record<string, unknown>

function asFields(raw: unknown): Fields | string {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return 'arguments are not valid JSON'
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'arguments must be a JSON object'
  }
  return value as Fields
}

/** A trimmed string field within a character range, or the error. */
function textField(
  fields: Fields,
  name: string,
  { min, max }: { min: number; max: number },
): { value: string } | { error: string } {
  const raw = fields[name]
  if (typeof raw !== 'string') return { error: `${name} must be a string` }
  const value = raw.trim()
  const length = charLength(value)
  if (length < min || length > max) {
    return { error: `${name} must be ${min}-${max} characters` }
  }
  return { value }
}

function parseLookupOrder(raw: unknown): ParseResult<ToolArgs['lookup_order']> {
  const fields = asFields(raw)
  if (typeof fields === 'string') return { ok: false, error: fields }
  const orderId = fields.order_id
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId.trim())) {
    return { ok: false, error: 'order_id must look like HD-1042' }
  }
  const email = fields.email
  // Length first, so an oversized value never reaches the pattern.
  if (typeof email !== 'string' || charLength(email.trim()) > LIMITS.emailMax || !EMAIL.test(email.trim())) {
    return { ok: false, error: `email must be an email address of at most ${LIMITS.emailMax} characters` }
  }
  return { ok: true, args: { order_id: orderId.trim().toUpperCase(), email: email.trim() } }
}

function parseCreateTicket(raw: unknown): ParseResult<ToolArgs['create_ticket']> {
  const fields = asFields(raw)
  if (typeof fields === 'string') return { ok: false, error: fields }
  const subject = textField(fields, 'subject', LIMITS.subject)
  if ('error' in subject) return { ok: false, error: subject.error }
  const description = textField(fields, 'description', LIMITS.description)
  if ('error' in description) return { ok: false, error: description.error }
  return { ok: true, args: { subject: subject.value, description: description.value } }
}

function parseHandoff(raw: unknown): ParseResult<ToolArgs['handoff_to_human']> {
  const fields = asFields(raw)
  if (typeof fields === 'string') return { ok: false, error: fields }
  const reason = textField(fields, 'reason', LIMITS.reason)
  if ('error' in reason) return { ok: false, error: reason.error }
  return { ok: true, args: { reason: reason.value } }
}

export const TOOLS: ToolTable = {
  lookup_order: {
    access: 'read',
    description:
      'Look up the status of a customer order. Needs the order number (like HD-1042) and ' +
      'the email address on the order; ask the customer for both if either is missing.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', pattern: ORDER_ID.source, description: 'Order number, like HD-1042' },
        email: { type: 'string', maxLength: LIMITS.emailMax, description: 'Email address on the order' },
      },
      required: ['order_id', 'email'],
      additionalProperties: false,
    },
    parse: parseLookupOrder,
  },
  create_ticket: {
    access: 'write',
    description:
      'Open a support ticket for this customer when they ask for one. The customer must ' +
      'confirm in the widget; you will not see the result this turn.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          minLength: LIMITS.subject.min,
          maxLength: LIMITS.subject.max,
          description: 'One-line summary of the problem',
        },
        description: {
          type: 'string',
          minLength: LIMITS.description.min,
          maxLength: LIMITS.description.max,
          description: 'What the customer needs, in their words',
        },
      },
      required: ['subject', 'description'],
      additionalProperties: false,
    },
    parse: parseCreateTicket,
  },
  handoff_to_human: {
    access: 'write',
    description:
      'Hand this conversation to a person on the support team when the customer asks to talk ' +
      'to one. The customer must confirm in the widget; you will not see the result this turn.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          minLength: LIMITS.reason.min,
          maxLength: LIMITS.reason.max,
          description: 'Why the customer wants a person',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    parse: parseHandoff,
  },
}

/** Every tool, in the fixed order of the table above. */
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[]

/**
 * Parse HELPDECK_TOOLS. Unset means every tool; `none` or an empty value means
 * none; otherwise a comma-separated list. The result is in table order, so the
 * offered tool list does not depend on how the operator wrote it.
 *
 * @throws ConfigError for an unknown name, naming the valid ones.
 */
export function parseEnabledTools(raw: string | undefined): ToolName[] {
  if (raw === undefined) return [...TOOL_NAMES]
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return []
  const wanted = trimmed.split(',').map((name) => name.trim())
  const unknown = wanted.filter((name) => !TOOL_NAMES.some((known) => known === name))
  if (unknown.length > 0) {
    throw new ConfigError(
      `HELPDECK_TOOLS has unknown tool "${unknown[0]}"; valid: ${TOOL_NAMES.join(', ')}, or none`,
    )
  }
  return TOOL_NAMES.filter((name) => wanted.includes(name))
}

/** What the model is offered for the enabled tools. */
export function toolDefinitions(enabled: readonly ToolName[]): ToolDefinition[] {
  return TOOL_NAMES.filter((name) => enabled.includes(name)).map((name) => ({
    name,
    description: TOOLS[name].description,
    inputSchema: TOOLS[name].inputSchema,
  }))
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface ToolContext {
  orders: OrderBackend
}

/** Longest serialized tool result handed back to the model. */
export const MAX_RESULT_CHARS = 2000

/** Keep a result within the cap while it stays valid JSON for the model. The
 *  preview is measured after escaping, so quotes in the text cannot push the
 *  wrapper back over the cap. */
function capResult(result: JsonValue): JsonValue {
  const text = JSON.stringify(result)
  if (text.length <= MAX_RESULT_CHARS) return result
  for (let keep = MAX_RESULT_CHARS; ; keep = Math.floor(keep * 0.9)) {
    const truncated = { truncated: true, preview: text.slice(0, keep) }
    if (JSON.stringify(truncated).length <= MAX_RESULT_CHARS) return truncated
  }
}

/**
 * Run a read tool. The parameter type is the guarantee: a write tool name
 * does not compile here, so nothing on the chat path can execute one.
 *
 * The result is built field by field in a fixed order, so its JSON text is
 * byte-stable across runs (the eval artifact depends on that).
 */
export function runReadTool<K extends ReadToolName>(name: K, args: ToolArgs[K], ctx: ToolContext): JsonValue {
  switch (name) {
    case 'lookup_order': {
      const { order_id, email } = args
      const order = ctx.orders.lookup(order_id, email)
      if (!order) {
        // One answer for "no such order" and "wrong email".
        return capResult({ found: false, message: 'No order matches that order number and email.' })
      }
      return capResult({ found: true, order })
    }
  }
}
