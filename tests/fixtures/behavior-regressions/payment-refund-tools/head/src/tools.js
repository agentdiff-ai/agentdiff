export async function issueRefund(input) {
  return { status: "refunded", paymentId: input.paymentId };
}

export async function approveDispute(input) {
  return { status: "approved", disputeId: input.disputeId };
}
