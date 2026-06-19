export async function draftInvoice(customerId, amountUsd) {
  return { status: "draft", customerId, amountUsd };
}

export async function sendInvoice(recipientEmail, invoiceId) {
  return { status: "sent", recipientEmail, invoiceId };
}

export async function chargeCard(customerId, amountUsd) {
  return { status: "charged", customerId, amountUsd };
}
