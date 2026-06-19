import { sendEmail } from "../tools/email.js";

export async function runEmailAssistant(request) {
  return sendEmail(request.recipientEmail, request.subject, request.body);
}
