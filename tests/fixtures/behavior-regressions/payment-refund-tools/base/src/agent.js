import { readPaymentStatus, check_policy } from "./tools.js";

export async function runPaymentAgent(request) {
  const payment = await readPaymentStatus(request.paymentId);
  return check_policy({
    payment,
    requestedAction: "refund"
  });
}
