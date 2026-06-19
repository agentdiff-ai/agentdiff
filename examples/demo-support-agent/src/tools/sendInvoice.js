// External side effect: sends a customer-visible invoice.
// This tool is intentionally not present in .agentdiff/map.json for the map drift demo.
export function sendInvoice({ recipientEmail, amountUsd, customerId }) {
  return {
    invoiceId: `inv_${customerId}_${amountUsd}`,
    recipientEmail,
    amountUsd,
    customerId,
    status: "sent"
  };
}
