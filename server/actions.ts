/**
 * Pending actions: the server-side half of "the customer must confirm".
 *
 * A write tool call from the model never runs. The chat loop can only
 * `propose` it, which stores a record and returns the card to show. The
 * record runs when the customer confirms it, and only the confirm route holds
 * the function that executes it (execute.ts); this module deliberately has
 * none, and the chat loop is typed with `ProposalPort`, which has no confirm.
 *
 * The action id doubles as the idempotency key: confirming the same action
 * again, or twice at once, shares one execution and returns one result.
 */

import { randomBytes } from 'node:crypto'

import type { HandoffDraft } from './handoff.js'
import type { ActionResult, ActionStatus, ActionView, WriteToolName } from './protocol.js'
import type { WriteCall } from './tools.js'

/** A validated write, ready to be shown and, once confirmed, run. A handoff
 *  carries the draft the customer is shown, so confirm shares exactly that. */
export type Proposal =
  | Extract<WriteCall, { tool: 'create_ticket' }>
  | (Extract<WriteCall, { tool: 'handoff_to_human' }> & { draft: HandoffDraft })

/** What the card shows, rendered by the server from validated arguments. */
export interface ActionPreview {
  title: string
  details: { label: string; value: string }[]
  confirmLabel: string
}

/** The outcome of running a write: the structured result and the line the
 *  bot says in the chat. */
export interface ActionOutcome {
  result: ActionResult
  message: string
}

/** What an executor receives: everything it needs and nothing it could widen. */
export interface ExecutableAction {
  sessionId: string
  proposal: Proposal
}

export type Executor = (action: ExecutableAction) => Promise<ActionOutcome>

export type ConfirmResult =
  | { ok: true; id: string; tool: WriteToolName; outcome: ActionOutcome }
  | { ok: false; code: 'not_found' | 'action_not_pending' | 'action_expired' }

export type CancelResult =
  | { ok: true; id: string; tool: WriteToolName }
  | { ok: false; code: 'not_found' | 'action_not_pending' | 'action_expired' }

export interface ConfirmHooks {
  /**
   * Runs once, after the first successful execution has been recorded as
   * done: the place for follow-up work such as remembering the outcome. It
   * runs outside the memoized execution, so a failure here is logged and
   * cannot turn a completed action into a failed one (a retry would repeat
   * the effect).
   */
  onFirstDone?: (outcome: ActionOutcome) => void
}

export interface ActionSummary {
  id: string
  tool: WriteToolName
  status: ActionStatus
  /** Set once the action is done. */
  result: ActionResult | null
}

/** All the chat loop may do with actions: propose one, and read what the
 *  session has done. */
export interface ProposalPort {
  propose(sessionId: string, proposal: Proposal, preview: ActionPreview): ActionView
  listForSession(sessionId: string): ActionSummary[]
}

type State =
  | { status: 'pending' | 'cancelled' | 'expired' | 'failed' }
  | { status: 'running'; execution: Promise<ActionOutcome> }
  | { status: 'done'; outcome: ActionOutcome }

interface ActionRecord {
  id: string
  sessionId: string
  proposal: Proposal
  createdAt: number
  expiresAt: number
  state: State
}

export interface ActionStoreOptions {
  now?: () => number
  ttlMs?: number
}

/** How long a proposal can be confirmed. */
export const ACTION_TTL_MS = 10 * 60 * 1000

/** Records older than this are dropped, so abandoned proposals cannot pile up. */
const RETAIN_MS = 60 * 60 * 1000

export class ActionStore implements ProposalPort {
  private readonly records = new Map<string, ActionRecord>()
  private readonly latestBySession = new Map<string, string>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor({ now = Date.now, ttlMs = ACTION_TTL_MS }: ActionStoreOptions = {}) {
    this.now = now
    this.ttlMs = ttlMs
  }

  /** Store a proposal and return its card. A session has one live card: a
   *  newer proposal cancels its older one if that is still pending or failed
   *  (a failed one is otherwise retryable). */
  propose(sessionId: string, proposal: Proposal, preview: ActionPreview): ActionView {
    this.evictOld()
    const olderId = this.latestBySession.get(sessionId)
    const older = olderId ? this.records.get(olderId) : undefined
    if (older && (older.state.status === 'pending' || older.state.status === 'failed')) {
      older.state = { status: 'cancelled' }
    }

    const createdAt = this.now()
    const record: ActionRecord = {
      id: randomBytes(16).toString('hex'),
      sessionId,
      proposal,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      state: { status: 'pending' },
    }
    this.records.set(record.id, record)
    this.latestBySession.set(sessionId, record.id)
    return {
      id: record.id,
      tool: proposal.tool,
      title: preview.title,
      details: preview.details,
      confirmLabel: preview.confirmLabel,
      expiresAt: new Date(record.expiresAt).toISOString(),
    }
  }

  /**
   * Run a pending action once. The status flips to `running` before anything
   * awaits, so a second confirm that arrives while the first is executing
   * finds `running` and shares its promise instead of starting another run.
   * A confirm after success returns the stored outcome. A failed run clears
   * its memo and may be retried.
   *
   * An action from another session is `not_found`, the same as an unknown id.
   */
  confirm(
    id: string,
    sessionId: string,
    execute: Executor,
    hooks: ConfirmHooks = {},
  ): Promise<ConfirmResult> {
    const record = this.find(id, sessionId)
    if (!record) return Promise.resolve({ ok: false, code: 'not_found' })
    const { state } = record
    switch (state.status) {
      case 'running':
        return state.execution.then((outcome) => confirmed(record, outcome))
      case 'done':
        return Promise.resolve(confirmed(record, state.outcome))
      case 'cancelled':
        return Promise.resolve({ ok: false, code: 'action_not_pending' })
      case 'expired':
        return Promise.resolve({ ok: false, code: 'action_expired' })
      case 'pending':
      case 'failed': {
        if (this.now() >= record.expiresAt) {
          record.state = { status: 'expired' }
          return Promise.resolve({ ok: false, code: 'action_expired' })
        }
        const execution = this.start(record, execute, hooks)
        record.state = { status: 'running', execution }
        return execution.then((outcome) => confirmed(record, outcome))
      }
    }
  }

  /** Cancel an action. Cancelling twice is fine; one that already ran or is
   *  running cannot be undone, and one that expired reports as expired. */
  cancel(id: string, sessionId: string): CancelResult {
    const record = this.find(id, sessionId)
    if (!record) return { ok: false, code: 'not_found' }
    if (record.state.status === 'running' || record.state.status === 'done') {
      return { ok: false, code: 'action_not_pending' }
    }
    if (record.state.status === 'expired') return { ok: false, code: 'action_expired' }
    record.state = { status: 'cancelled' }
    return { ok: true, id: record.id, tool: record.proposal.tool }
  }

  /** The session's actions in the order proposed. */
  listForSession(sessionId: string): ActionSummary[] {
    return [...this.records.values()]
      .filter((record) => record.sessionId === sessionId)
      .map((record) => ({
        id: record.id,
        tool: record.proposal.tool,
        status: record.state.status,
        result: record.state.status === 'done' ? record.state.outcome.result : null,
      }))
  }

  private start(record: ActionRecord, execute: Executor, hooks: ConfirmHooks): Promise<ActionOutcome> {
    // Deferred by a microtask so the caller marks the record running before
    // the executor's first line runs; it also turns a synchronous throw from
    // the executor into a rejection that takes the same failure path.
    return Promise.resolve()
      .then(() => execute({ sessionId: record.sessionId, proposal: record.proposal }))
      .then(
        (outcome) => {
          record.state = { status: 'done', outcome }
          try {
            hooks.onFirstDone?.(outcome)
          } catch (error) {
            console.warn('action: follow-up after a completed action failed:', error)
          }
          return outcome
        },
        (error: unknown) => {
          record.state = { status: 'failed' }
          throw error
        },
      )
  }

  private find(id: string, sessionId: string): ActionRecord | undefined {
    const record = this.records.get(id)
    if (!record || record.sessionId !== sessionId) return undefined
    if (record.state.status === 'pending' && this.now() >= record.expiresAt) {
      record.state = { status: 'expired' }
    }
    return record
  }

  private evictOld(): void {
    const cutoff = this.now() - RETAIN_MS
    for (const [id, record] of this.records) {
      if (record.createdAt < cutoff && record.state.status !== 'running') {
        this.records.delete(id)
        if (this.latestBySession.get(record.sessionId) === id) {
          this.latestBySession.delete(record.sessionId)
        }
      }
    }
  }
}

function confirmed(record: ActionRecord, outcome: ActionOutcome): ConfirmResult {
  return { ok: true, id: record.id, tool: record.proposal.tool, outcome }
}

/** The card for a validated write. Exhaustive over write tools, so a new one
 *  cannot ship without a preview. */
export function previewAction(proposal: Proposal): ActionPreview {
  switch (proposal.tool) {
    case 'create_ticket':
      return {
        title: 'Open a support ticket',
        details: [
          { label: 'Subject', value: proposal.args.subject },
          { label: 'Description', value: proposal.args.description },
        ],
        confirmLabel: 'Open ticket',
      }
    case 'handoff_to_human':
      return {
        title: 'Hand this chat to a person',
        details: [
          { label: 'Reason', value: proposal.args.reason },
          { label: 'Shared with the support team', value: proposal.draft.summary },
        ],
        confirmLabel: 'Hand off',
      }
  }
}
