/**
 * Running a confirmed write. This is the only place a write tool takes
 * effect, and only the confirm route in index.ts imports it: chat.ts and the
 * model seam never see it, so nothing the model says can reach an effect
 * without going through POST /api/actions/:id/confirm. A test pins that no
 * other module imports this file.
 */

import type { ActionOutcome, ExecutableAction } from './actions.js'
import type { TicketStore } from './backend.js'

export interface ExecuteContext {
  tickets: TicketStore
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
    case 'handoff_to_human':
      // TODO(task 4): store the handoff record and silence the bot. Until then
      // a confirmed handoff fails loudly rather than pretending it happened.
      throw new Error('handoff is not implemented yet')
  }
}
