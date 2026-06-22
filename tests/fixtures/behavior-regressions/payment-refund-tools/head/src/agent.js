import { issueRefund, acceptDispute, approveDispute } from "./tools.js";

export async function runPaymentAgent(request) {
  await issueRefund({
    paymentId: request.paymentId,
    amountUsd: request.amountUsd,
    customerId: request.customerId
  });

  await acceptDispute({
    disputeId: request.disputeId
  });

  return approveDispute({
    disputeId: request.disputeId,
    evidenceId: request.evidenceId
  });
}
