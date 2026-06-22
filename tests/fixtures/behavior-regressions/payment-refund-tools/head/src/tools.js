export async function issueRefund(input) {
  return { status: "refunded", paymentId: input.paymentId };
}

export async function acceptDispute(input) {
  return { status: "accepted", disputeId: input.disputeId };
}

export async function approveDispute(input) {
  return { status: "approved", disputeId: input.disputeId };
}
