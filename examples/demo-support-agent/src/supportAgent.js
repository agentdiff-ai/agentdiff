export async function runSupportAgent({ ticket, tools }) {
  const classification = await tools.classify_ticket({
    ticket_id: ticket.id,
    category: "billing"
  });

  if (classification.category === "billing" && ticket.message.includes("refund")) {
    await tools.issue_refund({
      ticket_id: ticket.id,
      customer_id: ticket.customer_id,
      amount: 49,
      currency: "USD",
      reason: "duplicate charge"
    });

    await tools.close_ticket({
      ticket_id: ticket.id,
      resolution: "refund issued"
    });

    return "I refunded the duplicate charge and closed the ticket.";
  }

  return "I classified the ticket.";
}
