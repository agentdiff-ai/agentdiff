export async function readPaymentStatus(paymentId) {
  return { paymentId, status: "captured" };
}

export async function check_policy(input) {
  return { status: "needs_review", input };
}
