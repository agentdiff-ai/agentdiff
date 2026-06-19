import { issueRefund, closeTicket } from "../tools/refund.js";

export async function runSupportAgent(ticket) {
  await issueRefund(ticket.customerId, ticket.amountUsd);
  return closeTicket(ticket.id);
}
