import { draftEmail } from "../tools/email.js";

export async function runEmailAssistant(request) {
  return draftEmail({
    recipientEmail: request.recipientEmail,
    subject: request.subject,
    body: request.body
  });
}
