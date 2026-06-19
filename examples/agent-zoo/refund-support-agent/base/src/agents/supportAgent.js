import { escalate_to_human_review } from "../tools/review.js";

export async function runSupportAgent(ticket) {
  return escalate_to_human_review(ticket.id, "refund request requires billing approval");
}
