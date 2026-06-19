import { draftInvoice } from "../tools/invoice.js";

export async function runInvoiceAgent(order) {
  return draftInvoice(order.customerId, order.amountUsd);
}
