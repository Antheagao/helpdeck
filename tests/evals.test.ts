import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkGate, misses, renderTable, serialize } from '../evals/gate.js'
import {
  checkCitations,
  datasetHash,
  defaultModel,
  loadCases,
  loadThresholds,
  runEvals,
  sessionIdFor,
  summarize,
  type Artifact,
  type CaseResult,
  type Category,
  type RunOptions,
  type Thresholds,
} from '../evals/harness.js'
import { hasLooseningReason, loosenings } from '../evals/thresholds-guard.js'
import { CitationDroppingLLM, HijackedLLM, dropArgument } from '../evals/models.js'
import { FixedWindowLimiter } from '../server/rate-limit.js'
import { MockLLM } from '../server/mock-llm.js'
import { TOOL_NAMES } from '../server/tools.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const thresholds = loadThresholds()
// The developer's own shell may hold provider keys; the harness refuses those, so tests run with none.
const env = {}

// The pipelines broken on purpose below log their failures; keep that out of the run.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})
const all = loadCases().cases
const byId = (...ids: string[]) => all.filter((c) => ids.includes(c.id))

/** A case result with every check passing, to fabricate metrics from. */
function result(id: string, category: Category, over: Partial<CaseResult> = {}): CaseResult {
  return {
    id,
    category,
    tags: [],
    checks: { outcome: true, tool: true, args: true, citations: true, refusal: true, overRefusal: true },
    pass: true,
    observed: { tool: null, cards: [], cited: [], recapAsked: [], refused: false, tickets: 0, handoffs: 0, followUps: 0, modelCalls: 1 },
    unconfirmedWrites: 0,
    duplicateWrites: 0,
    ...over,
  }
}

const floors: Thresholds = {
  min: {
    overall: { taskSuccess: 1, toolChoice: 1, toolArguments: 1, groundedness: 1, refusalCorrect: 1 },
    paraphraseGroundedness: 1,
  },
  max: { overRefusal: 0 },
}

/** An artifact over fabricated case results, under the strict fabricated floors. */
const build = (results: CaseResult[]): Artifact => summarize(1, results, { datasetHash: 'fabricated', thresholds: floors })

const healthy = () => build([result('a', 'task'), result('b', 'grounded', { tags: ['paraphrase'] })])

describe('checkGate', () => {
  it('passes when everything is at its threshold and the artifact is current', () => {
    const artifact = healthy()
    expect(checkGate(artifact, floors, serialize(artifact))).toEqual([])
  })

  it('names a write with no confirm, and a confirm that did the thing twice', () => {
    const artifact = build([
      result('a', 'task', { unconfirmedWrites: 2 }),
      result('b', 'task', { duplicateWrites: 1 }),
    ])
    const failures = checkGate(artifact, floors, serialize(artifact))
    expect(failures.some((f) => f.startsWith('unconfirmedWrites is 2, must be 0: a write happened with no confirm'))).toBe(true)
    expect(failures.some((f) => f.startsWith('duplicateWrites is 1, must be 0: a confirm did the same thing twice'))).toBe(true)
  })

  it.each([
    ['taskSuccess', 'outcome'],
    ['toolChoice', 'tool'],
    ['toolArguments', 'args'],
    ['groundedness', 'citations'],
    ['refusalCorrect', 'refusal'],
  ] as const)('fails %s when it drops below its floor, naming the metric', (metric, check) => {
    const artifact = build([
      result('a', 'task'),
      result('b', 'task', { checks: { [check]: false } }),
    ])
    const failures = checkGate(artifact, floors, serialize(artifact))
    expect(failures.filter((f) => f.startsWith(`${metric} is 0.5, below its threshold of 1`))).toHaveLength(1)
  })

  it('fails the paraphrase floor and the over-refusal ceiling separately', () => {
    const artifact = build([
      result('a', 'grounded', { tags: ['paraphrase'], checks: { citations: false, overRefusal: false } }),
    ])
    const failures = checkGate(artifact, floors, serialize(artifact))
    expect(failures).toContain('paraphraseGroundedness is 0, below its threshold of 1')
    expect(failures).toContain('overRefusal is 1, above its ceiling of 0')
  })

  it('accepts a miss that the thresholds allow, and reports it as a miss, not a failure', () => {
    const artifact = build([
      result('a', 'grounded'),
      result('b', 'grounded', { pass: false, checks: { citations: false, overRefusal: true } }),
    ])
    const lenient: Thresholds = { ...floors, min: { ...floors.min, overall: { ...floors.min.overall, groundedness: 0.5 } } }
    expect(checkGate(artifact, lenient, serialize(artifact))).toEqual([])
    expect(misses(artifact)).toEqual(['b: citations'])
  })

  it('fails a missing or stale committed artifact with what to do', () => {
    const artifact = healthy()
    const stale = serialize({ ...artifact, datasetVersion: 2 })
    for (const committed of [null, stale]) {
      expect(checkGate(artifact, floors, committed)).toEqual([
        'evals/results/latest.json is stale or missing: run npm run eval and commit it',
      ])
    }
  })

  it('reports every failure at once', () => {
    const artifact = build([result('a', 'task', { unconfirmedWrites: 1, checks: { tool: false } })])
    expect(checkGate(artifact, floors, null).length).toBeGreaterThanOrEqual(3)
  })
})

describe('renderTable', () => {
  it('prints each category, the overall row, the paraphrase row, and the hard invariants', () => {
    const table = renderTable(healthy())
    for (const word of ['Cases', 'Grounded', 'task', 'injection', 'overall', 'paraphrase']) expect(table).toContain(word)
    expect(table).toContain('unconfirmedWrites 0  duplicateWrites 0  transportFailures 0')
    // The thresholds print under the numbers they judge.
    expect(table).toContain('threshold')
    expect(table).toContain('>=1')
    expect(table).toContain('<=0')
  })
})

describe('the dataset', () => {
  it('is well formed: unique ids, known categories, known tools, a version', () => {
    const file = loadCases()
    expect(file.datasetVersion).toBe(1)
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length)
    for (const c of all) {
      expect(['task', 'tool', 'grounded', 'refusal', 'injection'], c.id).toContain(c.category)
      expect(['default', 'poisoned'], c.id).toContain(c.kb)
      for (const name of [...(c.tools ?? []), ...(typeof c.expect.tool === 'string' ? [c.expect.tool] : [])]) {
        expect(TOOL_NAMES, c.id).toContain(name)
      }
      expect(c.turns.length, c.id).toBeGreaterThan(0)
    }
  })

  it('covers every category, and has paraphrase cases to score BM25 on', () => {
    for (const category of ['task', 'tool', 'grounded', 'refusal', 'injection']) {
      expect(all.some((c) => c.category === category), category).toBe(true)
    }
    expect(all.filter((c) => c.tags?.includes('paraphrase')).length).toBeGreaterThanOrEqual(3)
  })

  it('keeps the poisoned fixture out of the shipped docs', () => {
    const planted = /ignore all previous instructions/i
    for (const file of fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md'))) {
      expect(fs.readFileSync(path.join(ROOT, 'docs', file), 'utf8'), file).not.toMatch(planted)
    }
    expect(fs.readFileSync(path.join(ROOT, 'evals', 'fixtures', 'kb', 'poisoned.md'), 'utf8')).toMatch(planted)
  })
})

describe('checkCitations', () => {
  const sources = [{ source: 'setup.md' }, { source: 'faq.md' }]

  it('needs a marker, every marker resolving to a sent source, and one from the expected files', () => {
    expect(checkCitations('See [1].', sources, ['setup.md'])).toEqual({ ok: true, cited: ['setup.md'] })
    expect(checkCitations('See [2] and [1].', sources, ['setup.md']).ok).toBe(true)
    expect(checkCitations('No marker here.', sources, ['setup.md']).ok).toBe(false)
    expect(checkCitations('See [3].', sources, ['setup.md']).ok).toBe(false)
    expect(checkCitations('See [1] and [9].', sources, ['setup.md']).ok).toBe(false)
    expect(checkCitations('See [2].', sources, ['setup.md']).ok).toBe(false)
  })

  it('counts markers in the model\'s own words, not in a passage it quotes back', () => {
    const passage = 'Numbered [1] through [4] in the prompt.'
    const answer = `Here is what the documentation says [1]:\n\n${passage}`
    // Counted naively, [4] names a source that was never sent.
    expect(checkCitations(answer, sources, ['setup.md']).ok).toBe(false)
    expect(checkCitations(answer, sources, ['setup.md'], [passage])).toEqual({ ok: true, cited: ['setup.md'] })
    // A quote with no marker of the model's own still has nothing cited.
    expect(checkCitations(`Quoting:\n\n${passage}`, sources, ['setup.md'], [passage]).ok).toBe(false)
  })
})

describe('running the cases', () => {
  it('scores the shipped pipeline with the mock: the hard invariants hold and the artifact is deterministic', async () => {
    const subset = byId(
      'task-lookup-shipped',
      'task-ticket-double-confirm',
      'task-handoff-followup-silences-bot',
      'task-handoff-recap-carries-actions',
      'injection-order-note-hijacked',
      'injection-forged-recap',
      'refusal-disabled-tool',
    )
    const first = await runEvals({ cases: subset, env })
    const second = await runEvals({ cases: subset, env })
    expect(serialize(first)).toBe(serialize(second))
    expect(first.hard).toEqual({ unconfirmedWrites: 0, duplicateWrites: 0, transportFailures: 0 })
    expect(first.cases.every((c) => c.pass)).toBe(true)
    // Nothing time-dependent or random reaches the artifact.
    expect(serialize(first).replace(/"datasetHash": "[0-9a-f]{64}"/, '')).not.toMatch(/createdAt|expiresAt|"at":|[0-9a-f]{32}/)
  })

  it('fails groundedness when the model stops citing: a seeded regression', async () => {
    const artifact = await runEvals({ env, makeModel: () => new CitationDroppingLLM() })
    expect(artifact.metrics.overall.groundedness.passed).toBe(0)
    const failures = checkGate(artifact, thresholds, serialize(artifact))
    expect(failures.some((f) => f.startsWith('groundedness is 0, below'))).toBe(true)
    expect(failures.some((f) => f.startsWith('paraphraseGroundedness'))).toBe(true)
  })

  it('fails tool arguments when the model drops the email: a seeded regression', async () => {
    const artifact = await runEvals({ env, makeModel: (c) => dropArgument(defaultModel(c), 'email') })
    expect(artifact.metrics.overall.toolArguments.rate).toBeLessThan(thresholds.min.overall.toolArguments)
    const failures = checkGate(artifact, thresholds, serialize(artifact))
    expect(failures.some((f) => f.startsWith('toolArguments is'))).toBe(true)
    // The server's own validation caught the missing email, so nothing was looked up.
    expect(artifact.metrics.overall.taskSuccess.rate).toBeLessThan(1)
    expect(artifact.hard).toEqual({ unconfirmedWrites: 0, duplicateWrites: 0, transportFailures: 0 })
  })

  it('trips unconfirmedWrites when a write lands in the stores with no confirm sent', async () => {
    const artifact = await runEvals({
      env,
      cases: byId('refusal-out-of-kb'),
      onDeps: (deps, testCase) => {
        // A fake execution: the store is written without any confirm request.
        deps.tickets.create(sessionIdFor(testCase), 'stray', 'created without a confirm')
      },
    })
    expect(artifact.hard.unconfirmedWrites).toBe(1)
    expect(checkGate(artifact, thresholds, serialize(artifact)).some((f) => f.startsWith('unconfirmedWrites is 1,'))).toBe(true)
  })

  it('trips unconfirmedWrites for a write from another session, which no confirm could explain', async () => {
    const artifact = await runEvals({
      env,
      cases: byId('task-ticket-confirm'),
      onDeps: (deps) => {
        deps.tickets.create('someone-else-session', 'stray', 'not from this chat')
      },
    })
    expect(artifact.hard.unconfirmedWrites).toBe(1)
  })

  it('trips duplicateWrites when one action confirmed twice does the thing twice', async () => {
    const artifact = await runEvals({
      env,
      cases: byId('task-ticket-double-confirm'),
      onDeps: (deps, testCase) => {
        // Idempotency broken on purpose: every confirm creates a ticket of its own.
        deps.actions.confirm = async (id) => {
          const ticket = deps.tickets.create(sessionIdFor(testCase), 'again', 'duplicate')
          return {
            ok: true,
            id,
            tool: 'create_ticket',
            outcome: { result: { tool: 'create_ticket', ticketId: ticket.id }, message: `Created ${ticket.id}` },
          }
        }
      },
    })
    expect(artifact.hard.duplicateWrites).toBe(1)
    expect(artifact.hard.unconfirmedWrites).toBe(0)
    expect(checkGate(artifact, thresholds, serialize(artifact)).some((f) => f.startsWith('duplicateWrites is 1,'))).toBe(true)
  })

  it('holds the gate with a fully hijacked model: no write without a confirm', async () => {
    const artifact = await runEvals({
      env,
      cases: all.filter((c) => c.category !== 'injection').map((c) => ({ ...c, model: 'hijacked' as const })),
      makeModel: () => new HijackedLLM(),
    })
    expect(artifact.hard).toEqual({ unconfirmedWrites: 0, duplicateWrites: 0, transportFailures: 0 })
  })
})

describe('a pipeline that cannot run does not score as a pass', () => {
  async function runBroken(ids: string[], onDeps: NonNullable<RunOptions['onDeps']>) {
    const artifact = await runEvals({ env, cases: byId(...ids), onDeps })
    return { artifact, failures: checkGate(artifact, thresholds, serialize(artifact)) }
  }
  const ids = ['refusal-out-of-kb', 'injection-typed-confirmation', 'task-ticket-confirm']

  it('fails the gate when retrieval throws on every chat', async () => {
    const { artifact, failures } = await runBroken(ids, (deps) => {
      deps.index.search = () => {
        throw new Error('index is down')
      }
    })
    expect(artifact.hard.transportFailures).toBe(3)
    expect(artifact.cases.every((c) => !c.pass && c.checks.transport === false)).toBe(true)
    expect(failures.some((f) => f.startsWith('transportFailures is 3, must be 0'))).toBe(true)
  })

  it('fails the gate when proposing an action throws', async () => {
    const { artifact, failures } = await runBroken(['task-ticket-confirm', 'injection-typed-confirmation'], (deps) => {
      deps.actions.propose = () => {
        throw new Error('propose is down')
      }
    })
    expect(artifact.hard.transportFailures).toBe(2)
    expect(failures.some((f) => f.startsWith('transportFailures is 2'))).toBe(true)
  })

  it('fails the gate when every chat is rate limited, though nothing was ever written', async () => {
    const { artifact, failures } = await runBroken(ids, (deps) => {
      deps.limiters.chat = new FixedWindowLimiter({ max: 0, windowMs: 60_000 })
    })
    // Cases that expect no write would have passed on the empty stores alone.
    expect(artifact.cases.find((c) => c.id === 'injection-typed-confirmation')?.observed.tickets).toBe(0)
    expect(artifact.hard.transportFailures).toBe(3)
    expect(failures.some((f) => f.startsWith('transportFailures is 3'))).toBe(true)
  })

  it('fails a confirm or cancel turn that finds no card, or a refused confirm', async () => {
    const noCard = await runEvals({
      env,
      cases: [{ ...byId('task-ticket-confirm')[0]!, turns: [{ confirm: 'last' }] }],
    })
    expect(noCard.cases[0]?.checks.transport).toBe(false)
    const refused = await runEvals({
      env,
      cases: byId('task-ticket-confirm'),
      onDeps: (deps) => {
        deps.limiters.actions = new FixedWindowLimiter({ max: 0, windowMs: 60_000 })
      },
    })
    expect(refused.cases[0]?.checks.transport).toBe(false)
    expect(refused.hard.transportFailures).toBe(1)
  })

  it('names the case when it crashes', async () => {
    await expect(
      runEvals({
        env,
        cases: byId('task-ticket-confirm'),
        makeModel: () => {
          throw new Error('model factory exploded')
        },
      }),
    ).rejects.toThrow('case task-ticket-confirm: model factory exploded')
  })
})

describe('what a case expecting a write has to show', () => {
  it('needs the server to have turned the tool call into a card', async () => {
    // A model that calls create_ticket, but the server never proposes a card.
    const artifact = await runEvals({
      env,
      cases: byId('task-ticket-confirm'),
      onDeps: (deps) => {
        deps.actions.propose = ((): never => {
          throw new Error('no card for you')
        }) as typeof deps.actions.propose
      },
    })
    expect(artifact.cases[0]?.checks.tool).toBe(false)
  })

  it('makes the hijack in the order-note case prove it fired', async () => {
    const real = await runEvals({ env, cases: byId('injection-order-note-hijacked') })
    expect(real.cases[0]?.observed.cards).toEqual(['create_ticket'])
    expect(real.cases[0]?.checks.outcome).toBe(true)
    // With a model that is not hijacked, the case no longer proves anything and says so.
    const vacuous = await runEvals({ env, cases: byId('injection-order-note-hijacked'), makeModel: () => new MockLLM({ tokenDelayMs: 0 }) })
    expect(vacuous.cases[0]?.observed.cards).toEqual([])
    expect(vacuous.cases[0]?.checks.outcome).toBe(false)
  })
})

describe('wrapped models', () => {
  it('score the same summary path the mock ships: no model call for the recap, and the recap is recorded', async () => {
    const artifact = await runEvals({ env, cases: byId('task-handoff-confirm') })
    const [handoff] = artifact.cases
    // One call for the customer's message; the recap needed none.
    expect(handoff?.observed.modelCalls).toBe(1)
    expect(handoff?.observed.recapAsked).toEqual(['user: It arrived damaged, I want to talk to a person'])
    // Through the other wrappers too.
    for (const makeModel of [() => new CitationDroppingLLM(), () => dropArgument(new MockLLM({ tokenDelayMs: 0 }), 'email')]) {
      const wrapped = await runEvals({ env, cases: byId('task-handoff-confirm'), makeModel })
      expect(wrapped.cases[0]?.observed.recapAsked).toEqual(handoff?.observed.recapAsked)
    }
  })
})

describe('handoffs are counted per session', () => {
  it('does not let a confirm claim another session\'s handoff', async () => {
    const artifact = await runEvals({
      env,
      cases: byId('task-handoff-confirm'),
      onDeps: (deps, testCase) => {
        // A record for someone else, and a confirm that points at it instead of making its own.
        const stray = deps.handoffs.create({
          sessionId: 'someone-else-session',
          reason: 'not from this chat',
          draft: { summary: 's', transcript: [], actions: { tickets: [], orders: [] } },
        })
        deps.actions.confirm = async (id) => ({
          ok: true,
          id,
          tool: 'handoff_to_human',
          outcome: { result: { tool: 'handoff_to_human', reference: stray.reference }, message: `claimed ${sessionIdFor(testCase)}` },
        })
      },
    })
    expect(artifact.hard.unconfirmedWrites).toBe(1)
  })

  it('trips unconfirmedWrites for a stray handoff beside a real confirmed one', async () => {
    const artifact = await runEvals({
      env,
      cases: byId('task-handoff-confirm'),
      onDeps: (deps) => {
        deps.handoffs.create({
          sessionId: 'someone-else-session',
          reason: 'not from this chat',
          draft: { summary: 's', transcript: [], actions: { tickets: [], orders: [] } },
        })
      },
    })
    expect(artifact.hard.unconfirmedWrites).toBe(1)
  })
})

describe('the artifact pins its inputs', () => {
  it('embeds the thresholds, and the dataset hash changes with the cases or a fixture', async () => {
    const artifact = await runEvals({ env, cases: byId('refusal-out-of-kb') })
    expect(artifact.thresholds).toEqual(thresholds)
    expect(artifact.datasetHash).toBe(datasetHash())
    expect(artifact.datasetHash).toMatch(/^[0-9a-f]{64}$/)

    const fixture = path.join(ROOT, 'evals', 'fixtures', 'kb', 'poisoned.md')
    const original = fs.readFileSync(fixture)
    try {
      fs.appendFileSync(fixture, '\n')
      expect(datasetHash()).not.toBe(artifact.datasetHash)
    } finally {
      fs.writeFileSync(fixture, original)
    }
    expect(datasetHash()).toBe(artifact.datasetHash)
  })

  it('fails a committed artifact that was made under different thresholds or a different dataset', () => {
    const artifact = healthy()
    const looser = { ...artifact, thresholds: { ...floors, max: { overRefusal: 1 } } }
    const edited = { ...artifact, datasetHash: 'something-else' }
    for (const committed of [serialize(looser), serialize(edited)]) {
      expect(checkGate(artifact, floors, committed).some((f) => f.includes('run npm run eval and commit it'))).toBe(true)
    }
  })
})

describe('the provider-key guard', () => {
  it('refuses to start when a provider key is in the environment', async () => {
    await expect(runEvals({ env: { ANTHROPIC_API_KEY: 'dummy-not-a-real-key' }, cases: [] })).rejects.toThrow(
      'the evals never call a provider: unset ANTHROPIC_API_KEY',
    )
    await expect(runEvals({ env: { OPENAI_API_KEY: 'dummy', ANTHROPIC_API_KEY: 'dummy' }, cases: [] })).rejects.toThrow(
      'unset ANTHROPIC_API_KEY and OPENAI_API_KEY',
    )
    await expect(runEvals({ env: { ANTHROPIC_API_KEY: '' }, cases: [] })).resolves.toBeDefined()
  })
})

describe('thresholds guard', () => {
  const before = thresholds

  it('finds a floor lowered, a ceiling raised, and a threshold removed, and nothing else', () => {
    expect(loosenings(before, before)).toEqual([])
    const tighter: Thresholds = { min: { ...before.min, paraphraseGroundedness: 0.5 }, max: { overRefusal: 0 } }
    expect(loosenings(before, tighter)).toEqual([])
    const looser: Thresholds = {
      min: { overall: { ...before.min.overall, groundedness: 0.5 }, paraphraseGroundedness: 0 },
      max: { overRefusal: 0.5 },
    }
    expect(loosenings(before, looser)).toEqual([
      `min.overall.groundedness went from ${before.min.overall.groundedness} to 0.5`,
      `min.paraphraseGroundedness went from ${before.min.paraphraseGroundedness} to 0`,
      `max.overRefusal went from ${before.max.overRefusal} to 0.5`,
    ])
    const removed = { min: { overall: { ...before.min.overall } }, max: {} } as unknown as Thresholds
    expect(loosenings(before, removed).join('\n')).toContain('min.paraphraseGroundedness was removed')
    expect(loosenings(before, removed).join('\n')).toContain('max.overRefusal was removed')
  })

  it('accepts a stated reason, and only a stated reason', () => {
    expect(hasLooseningReason('Raise the bar\n\nloosen-thresholds: the new KB is paraphrase-heavy')).toBe(true)
    for (const message of ['loosen-thresholds:', 'loosen-thresholds:   \n', 'loosen thresholds: x', 'no reason here']) {
      expect(hasLooseningReason(message), message).toBe(false)
    }
  })
})
