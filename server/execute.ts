/**
 * Running a confirmed write. This is the only place a write tool takes
 * effect, and only the confirm route in index.ts imports it: chat.ts and the
 * model seam never see it, so nothing the model says can reach an effect
 * without going through POST /api/actions/:id/confirm. A test pins that no
 * other module imports this file.
 */

import type { ActionOutcome, ExecutableAction } from './actions.js'
import type { TicketStore } from './backend.js'
import type { HandoffStore } from './handoff.js'

export interface ExecuteContext {
  tickets: TicketStore
  handoffs: HandoffStore
}

/**
 * Execute a validated write for the session that confirmed it.
 *
 * @throws TicketLimitError when the session is at its ticket cap.
 */
export async function executeWrite(
  { sessionId, proposal }: ExecutableAction,
  ctx: ExecuteContext,
): Promise<ActionOutcome> {
  switch (proposal.tool) {
    case 'create_ticket': {
      const ticket = ctx.tickets.create(sessionId, proposal.args.subject, proposal.args.description)
      return {
        result: { tool: 'create_ticket', ticketId: ticket.id },
        message: `Created ticket ${ticket.id}: ${ticket.subject}`,
      }
    }
    case 'handoff_to_human': {
      // The one place a handoff record is made. Storing it is what silences
      // the bot for the session; everything else (the memory turn, tracing)
      // runs after, in onFirstDone, so a retry cannot repeat this.
      const handoff = ctx.handoffs.create({ sessionId, reason: proposal.args.reason, draft: proposal.draft })
      return {
        result: { tool: 'handoff_to_human', reference: handoff.reference },
        message:
          `I have passed this conversation to the support team (reference ${handoff.reference}). ` +
          'A person will pick it up. Anything you add here goes to them.',
      }
    }
  }
}
