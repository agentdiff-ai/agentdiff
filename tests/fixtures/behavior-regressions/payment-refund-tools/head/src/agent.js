import { issueRefund, approveDispute } from "./tools.js";

export async function runPaymentAgent(request) {
  await issueRefund({
    paymentId: request.paymentId,
    amountUsd: request.amountUsd,
    customerId: request.customerId
  });

  return approveDispute({
    disputeId: request.disputeId,
    evidenceId: request.evidenceId
  });
}
