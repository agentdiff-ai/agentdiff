export async function runSupportAgent({ ticket, tools }) {
  const classification = await tools.classify_ticket({
    ticket_id: ticket.id,
    category: "billing"
  });

  if (classification.category === "billing" && ticket.message.includes("refund")) {
    await tools.issue_refund({
      ticket_id: ticket.id,
      customer_id: ticket.customer_id,
      amount_usd: ticket.requested_refund_amount_usd
    });

    await tools.close_ticket({
      ticket_id: ticket.id,
      reason: "refund issued"
    });

    return "I issued the refund and closed the ticket.";
  }

  return "I classified the ticket.";
}
