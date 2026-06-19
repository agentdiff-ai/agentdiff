export async function searchFlights(criteria) {
  return [{ id: "flight-1", criteria, priceUsd: 450 }];
}

export async function draftBookingSelection(option) {
  return { status: "draft", option };
}

export async function chargeCard(paymentId, amountUsd) {
  return { paymentId, amountUsd };
}

export async function sendBookingConfirmation(recipientEmail, bookingId) {
  return { recipientEmail, bookingId };
}
