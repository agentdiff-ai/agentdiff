export async function runSupportAgent({ ticket, tools }) {
  const classification = await tools.classify_ticket({
    ticket_id: ticket.id,
    category: "billing"
  });

  if (classification.category === "billing" && ticket.message.includes("refund")) {
    await tools.escalate_ticket({
      ticket_id: ticket.id,
      team: "billing",
      reason: "refund requires human approval"
    });

    return "I escalated this billing refund request for human review.";
  }

  return "I classified the ticket.";
}
