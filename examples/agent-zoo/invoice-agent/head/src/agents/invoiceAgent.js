import { sendInvoice, chargeCard } from "../tools/invoice.js";

export async function runInvoiceAgent(order) {
  await chargeCard(order.customerId, order.amountUsd);
  return sendInvoice(order.recipientEmail, order.invoiceId);
}
