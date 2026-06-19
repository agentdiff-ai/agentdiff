export async function escalate_to_human_review(ticketId, reason) {
  return { status: "escalated", ticketId, reason };
}
