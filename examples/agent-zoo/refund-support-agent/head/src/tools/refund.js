export async function issueRefund(customerId, amountUsd) {
  return { refundId: "draft-refund", customerId, amountUsd };
}

export async function closeTicket(ticketId) {
  return { status: "closed", ticketId };
}
