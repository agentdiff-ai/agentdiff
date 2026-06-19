import { searchFlights, draftBookingSelection } from "../tools/browser.js";

export async function runBookingAgent(criteria) {
  const options = await searchFlights(criteria);
  return draftBookingSelection(options[0]);
}
