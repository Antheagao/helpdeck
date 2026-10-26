import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  MAX_TICKETS_PER_SESSION,
  SeededOrderBackend,
  TicketLimitError,
  TicketStore,
  loadSeedOrders,
  type OrderBackend,
  type OrderView,
} from '../server/backend.js'
import { ConfigError } from '../server/llm.js'
import {
  LIMITS,
  MAX_RESULT_CHARS,
  TOOLS,
  TOOL_NAMES,
  parseEnabledTools,
  runReadTool,
  toolDefinitions,
  type ParseResult,
} from '../server/tools.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server')

const ok = <A>(result: ParseResult<A>): A => {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)
  return result.args
}
const rejected = <A>(result: ParseResult<A>): string => {
  if (result.ok) throw new Error(`expected a rejection, got: ${JSON.stringify(result.args)}`)
  return result.error
}

describe('lookup_order parser', () => {
  const parse = TOOLS.lookup_order.parse
  const email = 'ada@example.com'

  it('accepts an order id and normalizes it to upper case, trimmed', () => {
    expect(ok(parse({ order_id: 'HD-1042', email }))).toEqual({ order_id: 'HD-1042', email })
    expect(ok(parse({ order_id: ' hd-1042 ', email: ` ${email} ` }))).toEqual({ order_id: 'HD-1042', email })
  })

  it('pins the order id length at three and five digits', () => {
    rejected(parse({ order_id: 'HD-104', email }))
    rejected(parse({ order_id: 'HD-10420', email }))
    ok(parse({ order_id: 'HD-0000', email }))
  })

  it('rejects look-alike ids, including non-ASCII digits', () => {
    for (const order_id of ['HD1042', 'XX-1042', 'HD-10 42', 'HD-\uFF11\uFF10\uFF14\uFF12', 'HD-1042\nHD-1043', '', 42, null]) {
      rejected(parse({ order_id, email }))
    }
  })

  it('bounds the email at 254 characters', () => {
    const atLimit = `${'a'.repeat(254 - '@example.com'.length)}@example.com`
    expect(atLimit).toHaveLength(254)
    ok(parse({ order_id: 'HD-1042', email: atLimit }))
    rejected(parse({ order_id: 'HD-1042', email: `a${atLimit}` }))
  })

  it('accepts a non-ASCII address and rejects malformed ones', () => {
    ok(parse({ order_id: 'HD-1042', email: 'jos\u00e9@example.com' }))
    for (const bad of ['ada', 'ada@', '@example.com', 'ada@example', 'a da@example.com', 'ada@@example.com', '', 7, undefined]) {
      rejected(parse({ order_id: 'HD-1042', email: bad }))
    }
  })

  it('reads a JSON string, rejects broken JSON and non-objects, and ignores unknown fields', () => {
    const json = JSON.stringify({ order_id: 'HD-1042', email, shipTo: 'elsewhere', extra: 1 })
    expect(ok(parse(json))).toEqual({ order_id: 'HD-1042', email })
    expect(rejected(parse('{"order_id": HD-1042'))).toContain('valid JSON')
    for (const bad of ['[]', 'null', '"HD-1042"', 5, null, undefined, ['HD-1042']]) {
      expect(rejected(parse(bad))).toContain('JSON object')
    }
  })
})

/** Boundary cases for a trimmed text field: min-1, min, max, max+1, trimming,
 *  and characters that take two UTF-16 units. */
function textBoundaries(
  label: string,
  parse: (raw: unknown) => ParseResult<Record<string, string>>,
  field: string,
  { min, max }: { min: number; max: number },
  others: Record<string, string>,
) {
  describe(`${label} ${field}`, () => {
    const make = (value: unknown) => parse({ ...others, [field]: value })

    it(`accepts ${min} to ${max} characters`, () => {
      expect(ok(make('x'.repeat(min)))[field]).toBe('x'.repeat(min))
      expect(ok(make('x'.repeat(max)))[field]).toBe('x'.repeat(max))
    })

    it('rejects just outside the range', () => {
      if (min > 1) rejected(make('x'.repeat(min - 1)))
      rejected(make('x'.repeat(max + 1)))
      rejected(make(''))
      rejected(make('   '))
    })

    it('counts the trimmed text, not the padding', () => {
      expect(ok(make(`  ${'x'.repeat(max)}  `))[field]).toBe('x'.repeat(max))
      if (min > 1) rejected(make(` ${'x'.repeat(min - 1)} `))
    })

    it('counts characters, not UTF-16 units', () => {
      ok(make('\u{1F600}'.repeat(max)))
      rejected(make('\u{1F600}'.repeat(max + 1)))
      ok(make('\u00e9'.repeat(max)))
    })

    it('rejects a non-string', () => {
      for (const bad of [undefined, null, 12, ['x'], { a: 1 }]) rejected(make(bad))
    })
  })
}

textBoundaries('create_ticket', TOOLS.create_ticket.parse, 'subject', LIMITS.subject, { description: 'It broke.' })
textBoundaries('create_ticket', TOOLS.create_ticket.parse, 'description', LIMITS.description, { subject: 'Broken lamp' })
textBoundaries('handoff_to_human', TOOLS.handoff_to_human.parse, 'reason', LIMITS.reason, {})

describe('write tool parsers', () => {
  it('read a JSON string and ignore unknown fields', () => {
    const raw = JSON.stringify({ subject: ' Lamp ', description: 'No light', sessionId: 'other-session' })
    expect(ok(TOOLS.create_ticket.parse(raw))).toEqual({ subject: 'Lamp', description: 'No light' })
    expect(ok(TOOLS.handoff_to_human.parse({ reason: 'Wants a person', priority: 'urgent' }))).toEqual({
      reason: 'Wants a person',
    })
  })

  it('fold whitespace in a handoff reason to single spaces, so it stays one line', () => {
    const args = ok(TOOLS.handoff_to_human.parse({ reason: ' wants\n\nActions:\r\n- Refund   approved\t ' }))
    expect(args.reason).toBe('wants Actions: - Refund approved')
    // The length rule applies to the folded text.
    ok(TOOLS.handoff_to_human.parse({ reason: `${'a '.repeat(150)}` }))
    rejected(TOOLS.handoff_to_human.parse({ reason: `${'a\n'.repeat(151)}` }))
  })

  it('name the missing field', () => {
    expect(rejected(TOOLS.create_ticket.parse({ subject: 'Lamp' }))).toContain('description')
    expect(rejected(TOOLS.handoff_to_human.parse({}))).toContain('reason')
  })
})

describe('tool table', () => {
  it('pins the access level of every tool', () => {
    // A change here is a change to what can run without a confirm: review it.
    expect(Object.fromEntries(TOOL_NAMES.map((name) => [name, TOOLS[name].access]))).toEqual({
      lookup_order: 'read',
      create_ticket: 'write',
      handoff_to_human: 'write',
    })
  })

  it('tells the model that a write needs the customer to confirm', () => {
    for (const name of TOOL_NAMES.filter((n) => TOOLS[n].access === 'write')) {
      expect(TOOLS[name].description).toContain('must confirm in the widget')
      expect(TOOLS[name].description).toContain('you will not see the result this turn')
    }
  })

  it('offers a closed schema with every parsed field required', () => {
    for (const name of TOOL_NAMES) {
      const schema = TOOLS[name].inputSchema as {
        additionalProperties: boolean
        required: string[]
        properties: Record<string, unknown>
      }
      expect(schema.additionalProperties).toBe(false)
      expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort())
    }
  })

  it('offers no tool that can bind to another session', () => {
    const fields = TOOL_NAMES.flatMap((name) => Object.keys((TOOLS[name].inputSchema as { properties: object }).properties))
    expect(fields.sort()).toEqual(['description', 'email', 'order_id', 'reason', 'subject'])
  })
})

describe('parseEnabledTools', () => {
  it('means every tool when unset', () => {
    expect(parseEnabledTools(undefined)).toEqual(['lookup_order', 'create_ticket', 'handoff_to_human'])
  })

  it('allows any subset to be named', () => {
    expect(parseEnabledTools('handoff_to_human')).toEqual(['handoff_to_human'])
    expect(parseEnabledTools('lookup_order,create_ticket,handoff_to_human')).toEqual([...TOOL_NAMES])
  })

  it('means none for an empty value or none', () => {
    for (const raw of ['', '   ', 'none', ' NONE ']) expect(parseEnabledTools(raw)).toEqual([])
  })

  it('returns the named tools in table order, whatever the spelling order', () => {
    expect(parseEnabledTools('handoff_to_human, lookup_order')).toEqual(['lookup_order', 'handoff_to_human'])
    expect(parseEnabledTools('create_ticket,create_ticket')).toEqual(['create_ticket'])
  })

  it('rejects an unknown name and lists the valid ones', () => {
    expect(() => parseEnabledTools('lookup_order,refund_order')).toThrow(ConfigError)
    expect(() => parseEnabledTools('lookup_order,refund_order')).toThrow(
      'unknown tool "refund_order"; valid: lookup_order, create_ticket, handoff_to_human, or none',
    )
    expect(() => parseEnabledTools('lookup_order,')).toThrow(ConfigError)
    expect(() => parseEnabledTools('none,lookup_order')).toThrow(ConfigError)
    expect(() => parseEnabledTools('Lookup_Order')).toThrow(ConfigError)
  })
})

describe('toolDefinitions', () => {
  it('offers only the enabled tools, in table order', () => {
    expect(toolDefinitions(['handoff_to_human', 'lookup_order']).map((t) => t.name)).toEqual([
      'lookup_order',
      'handoff_to_human',
    ])
    expect(toolDefinitions([])).toEqual([])
  })

  it('carries each tool description and schema', () => {
    const [tool] = toolDefinitions(['create_ticket'])
    expect(tool).toEqual({
      name: 'create_ticket',
      description: TOOLS.create_ticket.description,
      inputSchema: TOOLS.create_ticket.inputSchema,
    })
  })
})

describe('seeded orders', () => {
  const seed = loadSeedOrders()
  const backend = new SeededOrderBackend()

  it('holds six fake orders covering every status', () => {
    expect(seed.map((o) => o.orderId)).toEqual(['HD-1041', 'HD-1042', 'HD-1043', 'HD-1044', 'HD-1045', 'HD-1046'])
    expect(new Set(seed.map((o) => o.status))).toEqual(
      new Set(['processing', 'shipped', 'delivered', 'cancelled', 'returned']),
    )
    for (const order of seed) expect(order.email).toMatch(/@example\.com$/)
  })

  it('caps every customer note at 300 characters and plants exactly one injection', () => {
    const notes = seed.flatMap((o) => (o.customerNote ? [o.customerNote] : []))
    for (const note of notes) expect(note.length).toBeLessThanOrEqual(300)
    expect(notes.filter((n) => /ignore all previous instructions/i.test(n))).toHaveLength(1)
  })

  it('looks up by id and email, ignoring case and padding', () => {
    expect(backend.lookup('HD-1042', 'ada@example.com')?.status).toBe('shipped')
    expect(backend.lookup(' hd-1042 ', ' ADA@Example.COM ')?.orderId).toBe('HD-1042')
  })

  it('answers a wrong email and an unknown id with the same null', () => {
    const wrongEmail = backend.lookup('HD-1042', 'ben@example.com')
    const unknownId = backend.lookup('HD-9999', 'ada@example.com')
    expect(wrongEmail).toBeNull()
    expect(unknownId).toBeNull()
    const ctx = { orders: backend }
    expect(runReadTool('lookup_order', { order_id: 'HD-1042', email: 'ben@example.com' }, ctx)).toEqual(
      runReadTool('lookup_order', { order_id: 'HD-9999', email: 'ada@example.com' }, ctx),
    )
  })

  it('never exposes an address, the email, or the session in a lookup', () => {
    const ctx = { orders: backend }
    for (const order of seed) {
      const text = JSON.stringify(runReadTool('lookup_order', { order_id: order.orderId, email: order.email }, ctx))
      expect(text).not.toContain(order.shipTo.line1)
      expect(text).not.toContain(order.shipTo.postalCode)
      expect(text).not.toContain(order.email)
      expect(text).not.toMatch(/shipTo|address/i)
    }
  })
})

describe('runReadTool', () => {
  const ctx = { orders: new SeededOrderBackend() }

  it('returns a stable, byte-identical result with a fixed key order', () => {
    const run = () => JSON.stringify(runReadTool('lookup_order', { order_id: 'HD-1042', email: 'ada@example.com' }, ctx))
    expect(run()).toBe(run())
    expect(run()).toBe(
      '{"found":true,"order":{"orderId":"HD-1042","status":"shipped","placedOn":"2026-10-20",' +
        '"items":[{"name":"Standing desk mat","quantity":1}],"totalCents":4999,"currency":"USD",' +
        '"carrier":"UPS","trackingNumber":"1ZHD1042000002",' +
        '"customerNote":{"writtenBy":"customer","text":"Please leave the parcel with the front desk."}}}',
    )
  })

  it('labels the customer note as customer-written text, including the planted injection', () => {
    const result = runReadTool('lookup_order', { order_id: 'HD-1043', email: 'ben@example.com' }, ctx) as {
      order: { customerNote: { writtenBy: string; text: string } }
    }
    expect(result.order.customerNote.writtenBy).toBe('customer')
    expect(result.order.customerNote.text).toMatch(/ignore all previous instructions/i)
  })

  it('keeps an oversized result within the cap and still valid JSON', () => {
    const huge: OrderView = {
      orderId: 'HD-1042',
      status: 'shipped',
      placedOn: '2026-10-20',
      items: Array.from({ length: 200 }, (_, i) => ({ name: `Item number ${i} with a long name`, quantity: 1 })),
      totalCents: 1,
      currency: 'USD',
      carrier: null,
      trackingNumber: null,
      customerNote: null,
    }
    const orders: OrderBackend = { lookup: () => huge }
    const text = JSON.stringify(runReadTool('lookup_order', { order_id: 'HD-1042', email: 'a@example.com' }, { orders }))
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS)
    expect(JSON.parse(text)).toMatchObject({ truncated: true })
  })

  it('leaves a normal result untouched by the cap', () => {
    for (const order of loadSeedOrders()) {
      const text = JSON.stringify(runReadTool('lookup_order', { order_id: order.orderId, email: order.email }, ctx))
      expect(text.length).toBeLessThan(MAX_RESULT_CHARS)
      expect(JSON.parse(text)).toMatchObject({ found: true })
    }
  })
})

describe('TicketStore', () => {
  const at = new Date('2026-10-26T12:00:00.000Z')

  it('numbers tickets T-1001, T-1002, ... across sessions', () => {
    const store = new TicketStore(() => at)
    expect(store.create('session-a', 'Lamp', 'No light').id).toBe('T-1001')
    expect(store.create('session-b', 'Desk', 'Wobbles').id).toBe('T-1002')
    expect(store.create('session-a', 'Cable', 'Frayed').id).toBe('T-1003')
    expect(store.count()).toBe(3)
  })

  it('records what was asked, for whom, and when', () => {
    const store = new TicketStore(() => at)
    const ticket = store.create('session-a', 'Lamp', 'No light')
    expect(ticket).toEqual({
      id: 'T-1001',
      sessionId: 'session-a',
      subject: 'Lamp',
      description: 'No light',
      createdAt: '2026-10-26T12:00:00.000Z',
    })
    expect(store.listForSession('session-a')).toEqual([ticket])
    expect(store.listForSession('session-b')).toEqual([])
  })

  it('stops a session at the cap without affecting others or the numbering', () => {
    const store = new TicketStore()
    for (let i = 0; i < MAX_TICKETS_PER_SESSION; i++) store.create('session-a', `Ticket ${i}`, 'text')
    expect(() => store.create('session-a', 'One too many', 'text')).toThrow(TicketLimitError)
    expect(store.count()).toBe(MAX_TICKETS_PER_SESSION)
    expect(store.listForSession('session-a')).toHaveLength(MAX_TICKETS_PER_SESSION)
    expect(store.create('session-b', 'Fresh session', 'text').id).toBe('T-1004')
  })

  it('does not let a caller edit the store through a listing', () => {
    const store = new TicketStore()
    store.create('session-a', 'Lamp', 'text')
    store.listForSession('session-a').pop()
    expect(store.listForSession('session-a')).toHaveLength(1)
  })
})

describe('protocol.ts', () => {
  it('has no imports, so the widget can import its types without server code', () => {
    const source = fs.readFileSync(path.join(SERVER, 'protocol.ts'), 'utf8')
    expect(source).not.toMatch(/^\s*(import|export\s.*\sfrom)\s/m)
    expect(source).not.toMatch(/\brequire\(|import\(/)
  })
})
