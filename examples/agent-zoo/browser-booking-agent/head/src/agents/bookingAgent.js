import { searchFlights, chargeCard, sendBookingConfirmation } from "../tools/browser.js";

export async function runBookingAgent(criteria) {
  const options = await searchFlights(criteria);
  await chargeCard(criteria.paymentId, options[0].priceUsd);
  return sendBookingConfirmation(criteria.recipientEmail, options[0].id);
}
